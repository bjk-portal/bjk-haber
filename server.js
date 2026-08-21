const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const ROOT = __dirname;
const CACHE = path.join(ROOT, "article-cache.json");

const RSS_URL = "https://www.fotomac.com.tr/rss/besiktas.xml";

let cache = {};
try {
  if (fs.existsSync(CACHE)) cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
} catch (_) {
  cache = {};
}

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => {
      b += c;
      if (b.length > 1000000) reject(new Error("İstek çok büyük."));
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

function hashKey(t, d) {
  return crypto.createHash("sha256").update(t + "|" + d).digest("hex");
}

function save() {
  try {
    fs.writeFileSync(CACHE, JSON.stringify(cache), "utf8");
  } catch (_) {}
}

function decodeXml(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function stripHtml(s = "") {
  return decodeXml(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeXml(m[1]) : "";
}

function imageFromBlock(block) {
  const m = block.match(/<media:content[^>]+url=["']([^"']+)["']/i)
    || block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)
    || block.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
  return m ? decodeXml(m[1]) : "";
}

function parseRss(xml) {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const block of matches.slice(0, 30)) {
    const title = tagValue(block, "title");
    const link = tagValue(block, "link");
    const description = tagValue(block, "description");
    const pubDate = tagValue(block, "pubDate");
    const thumbnail = imageFromBlock(block);

    if (title) {
      items.push({
        title,
        link,
        description,
        pubDate,
        thumbnail,
        source: "Fotomaç"
      });
    }
  }
  return items;
}

let rssCache = { items: [], fetchedAt: 0 };
const RSS_TTL = 5 * 60 * 1000;

async function getNews() {
  if (rssCache.items.length && Date.now() - rssCache.fetchedAt < RSS_TTL) {
    return rssCache.items;
  }

  const r = await fetch(RSS_URL, {
    headers: { "User-Agent": "SiyahBeyazHaber/1.0" }
  });

  if (!r.ok) throw new Error(`RSS alınamadı: HTTP ${r.status}`);

  const xml = await r.text();
  const items = parseRss(xml);

  if (!items.length) throw new Error("RSS içinde haber bulunamadı.");

  rssCache = { items, fetchedAt: Date.now() };
  return items;
}

async function generate(title, description, link) {
  if (!KEY) throw new Error("GEMINI_API_KEY Render Environment Variables içinde tanımlı değil.");

  const prompt = `Sen Siyah & Beyaz adlı Beşiktaş haber sitesinin kıdemli spor editörüsün.

BAŞLIK:
${title}

KAYNAK METNİ:
${description}

KAYNAK LİNKİ:
${link || "Yok"}

Kurallar:
- Türkçe, yaklaşık 1000-1500 kelimelik özgün ve ayrıntılı haber yaz.
- En az 7 ayrı bölüm kullan; bölüm başlıklarını ## ile başlat.
- Haber başlığının gerçek konusuna odaklan.
- Kaynakta olmayan transfer, skor, tarih, sakatlık, açıklama, karar veya alıntı UYDURMA.
- Kaynak kısa ise konunun sportif anlamını ve olası etkilerini analiz et; kesin olmayan çıkarımları açıkça olasılık/değerlendirme olarak belirt.
- Doğal spor gazetesi üslubu kullan; klişe ve konu dışı genel girişlerden kaçın.
- HTML veya tablo kullanma.`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}` +
    `:generateContent?key=${encodeURIComponent(KEY)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 6000
      }
    })
  });

  const data = await r.json();

  if (!r.ok) {
    throw new Error(data?.error?.message || `Gemini HTTP ${r.status}`);
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "")
    .join("")
    .trim();

  if (!text) throw new Error("Gemini boş cevap döndürdü.");
  return text;
}

function markdownToHtml(md) {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^##\s+(.+)$/gm, "<h3>$1</h3>")
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      if (p.startsWith("<h3>")) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    // RSS haberlerini Render üzerinden sunuyoruz.
    if (req.method === "GET" && u.pathname === "/api/news") {
      try {
        const items = await getNews();
        return send(res, 200, { status: "ok", items });
      } catch (e) {
        console.error("RSS hatası:", e);
        return send(res, 502, { status: "error", error: e.message });
      }
    }

    // Gemini yalnızca kullanıcı haber detayını açtığında çağrılır.
    if (req.method === "POST" && u.pathname === "/api/generate-news") {
      let x;
      try {
        x = JSON.parse(await body(req));
      } catch (_) {
        return send(res, 400, { error: "Geçersiz JSON." });
      }

      const title = String(x.title || "").trim();
      const description = String(x.description || "").trim();
      const link = String(x.link || "").trim();

      if (!title) return send(res, 400, { error: "Haber başlığı eksik." });

      const k = hashKey(title, description);

      if (cache[k]) {
        return send(res, 200, { article: cache[k], cached: true });
      }

      try {
        const article = await generate(title, description, link);
        cache[k] = article;
        save();
        return send(res, 200, { article, cached: false });
      } catch (e) {
        console.error("Gemini hatası:", e);
        return send(res, 502, { error: e.message || "Gemini hatası." });
      }
    }

    if (req.method === "GET" && u.pathname === "/health") {
      return send(res, 200, {
        status: "ok",
        geminiConfigured: Boolean(KEY),
        model: MODEL
      });
    }

    if (
      req.method === "GET" &&
      (u.pathname === "/" || u.pathname === "/index.html")
    ) {
      const f = fs.readFileSync(path.join(ROOT, "public", "index.html"));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      return res.end(f);
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Bulunamadı." }));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message || "Sunucu hatası." });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Siyah & Beyaz sunucusu ${PORT} portunda çalışıyor.`);
});
