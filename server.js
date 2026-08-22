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

// Gemini kotası dolduğunda siteyi tamamen durdurmuyoruz.
// Bir kez 429 alınca belirli süre yeni Gemini isteği göndermeyip RSS içeriğine düşeriz.
let geminiCooldownUntil = 0;
let geminiCooldownSeconds = 60;
let generationInFlight = new Map();

let cache = {};
try {
  if (fs.existsSync(CACHE)) cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
} catch (_) {
  cache = {};
}

function send(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
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
      items.push({ title, link, description, pubDate, thumbnail, source: "Fotomaç" });
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
    headers: { "User-Agent": "SiyahBeyazHaber/2.0" }
  });

  if (!r.ok) throw new Error(`RSS alınamadı: HTTP ${r.status}`);

  const xml = await r.text();
  const items = parseRss(xml);
  if (!items.length) throw new Error("RSS içinde haber bulunamadı.");

  rssCache = { items, fetchedAt: Date.now() };
  return items;
}

function isQuotaError(status, message = "") {
  return status === 429 || /quota|rate.?limit|exceeded your current quota|limit:\s*\d+/i.test(message);
}

function retrySecondsFrom(message = "") {
  const m = message.match(/retry in\s+([0-9.]+)\s*s/i);
  if (m) return Math.max(15, Math.ceil(Number(m[1])));
  return 60;
}

function setGeminiCooldown(seconds) {
  geminiCooldownSeconds = Math.max(15, Math.min(3600, Number(seconds) || 60));
  geminiCooldownUntil = Date.now() + geminiCooldownSeconds * 1000;
}

function fallbackArticle(title, description, link) {
  const clean = stripHtml(description);
  const sourceText = clean || "Bu haberin kaynak metni şu anda sınırlı bilgi içeriyor.";
  return [
    `## ${title}`,
    sourceText,
    `## Haber Özeti`,
    `Bu içerik, kaynak haberin mevcut açıklamasındaki bilgiler temel alınarak hazırlanmıştır. Kaynak metinde yer almayan gelişmeler doğrulanmadan eklenmemiştir.`,
    `## Kaynak`,
    link ? `Kaynak haber: ${link}` : `Kaynak: Fotomaç RSS`
  ].join("\n\n");
}

async function generate(title, description, link) {
  if (!KEY) throw new Error("GEMINI_API_KEY Render Environment Variables içinde tanımlı değil.");

  if (Date.now() < geminiCooldownUntil) {
    const remaining = Math.ceil((geminiCooldownUntil - Date.now()) / 1000);
    const e = new Error(`Gemini kotası geçici olarak dolu. RSS içeriği kullanılacak. Yaklaşık ${remaining} saniye sonra tekrar denenebilir.`);
    e.quota = true;
    e.retrySeconds = remaining;
    throw e;
  }

  const prompt = `Sen Siyah & Beyaz adlı Beşiktaş haber sitesinin kıdemli spor editörüsün.

BAŞLIK:
${title}

KAYNAK METNİ:
${description}

KAYNAK LİNKİ:
${link || "Yok"}

Kurallar:
- Türkçe, yaklaşık 700-1000 kelimelik özgün ve ayrıntılı haber yaz.
- 5-7 bölüm kullan; bölüm başlıklarını ## ile başlat.
- Haber başlığının gerçek konusuna odaklan.
- Kaynakta olmayan transfer, skor, tarih, sakatlık, açıklama, karar veya alıntı UYDURMA.
- Kaynak kısa ise yalnızca kaynakta doğrulanabilen bilgileri açıkla ve sportif bağlamı ihtiyatlı biçimde yorumla.
- Kesin olmayan çıkarımları kesin bilgi gibi sunma.
- HTML veya tablo kullanma.`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}` +
    `:generateContent?key=${encodeURIComponent(KEY)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 3500 }
    })
  });

  const data = await r.json().catch(() => ({}));
  const message = data?.error?.message || `Gemini HTTP ${r.status}`;

  if (!r.ok) {
    if (isQuotaError(r.status, message)) {
      const seconds = retrySecondsFrom(message);
      setGeminiCooldown(seconds);
      const e = new Error(message);
      e.quota = true;
      e.retrySeconds = seconds;
      throw e;
    }
    throw new Error(message);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini boş cevap döndürdü.");
  return text;
}

async function generateOnce(k, title, description, link) {
  if (generationInFlight.has(k)) return generationInFlight.get(k);

  const job = (async () => {
    try {
      const article = await generate(title, description, link);
      cache[k] = { article, createdAt: Date.now(), type: "gemini" };
      save();
      return { article, type: "gemini", cached: false };
    } finally {
      generationInFlight.delete(k);
    }
  })();

  generationInFlight.set(k, job);
  return job;
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
    .map(p => p.startsWith("<h3>") ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}


const SITE_URL = "https://bjk-haber.onrender.com";

function slugify(value = "") {
  return String(value).toLowerCase()
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s")
    .replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function htmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderArticlePage(item) {
  let html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const title = item.title || "Beşiktaş Haberleri";
  const description = stripHtml(item.description || "Beşiktaş güncel haberleri ve son gelişmeler.").slice(0, 300);
  const slug = slugify(title);
  const url = `${SITE_URL}/haber/${encodeURIComponent(slug)}`;
  const image = item.thumbnail || "";
  const published = item.pubDate ? new Date(item.pubDate) : null;
  const datePublished = published && !Number.isNaN(published.getTime()) ? published.toISOString() : new Date().toISOString();

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${htmlEscape(title)} | Siyah &amp; Beyaz</title>`);
  html = html.replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${htmlEscape(description)}">`);
  html = html.replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${htmlEscape(url)}">`);
  html = html.replace(/<meta name="robots"[^>]*>/i, `<meta name="robots" content="index,follow,max-image-preview:large">`);

  const structured = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: title,
    description,
    datePublished,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    ...(image ? { image: [image] } : {}),
    publisher: { "@type": "Organization", name: "Siyah & Beyaz", url: SITE_URL }
  })}</script>`;
  html = html.replace("</head>", `${structured}</head>`);

  html = html.replace('<div id="singleNewsPage">', '<div id="singleNewsPage" style="display:block">');
  html = html.replace('<div id="homePage">', '<div id="homePage" style="display:none">');
  html = html.replace('<h2 class="news-detail-title" id="detailTitle"></h2>', `<h2 class="news-detail-title" id="detailTitle">${htmlEscape(title)}</h2>`);
  html = html.replace('<div class="news-detail-body" id="detailBody"></div>', `<div class="news-detail-body" id="detailBody"><p>${htmlEscape(description)}</p><p><a class="source-link" href="${htmlEscape(item.link || '#')}" target="_blank" rel="noopener">Kaynak haberi görüntüle →</a></p></div>`);
  if (image) html = html.replace('<img src="" id="detailImg" class="news-detail-img" alt="Haber Görseli" style="display:none">', `<img src="${htmlEscape(image)}" id="detailImg" class="news-detail-img" alt="${htmlEscape(title)}">`);
  return html;
}

async function buildSitemap() {
  const items = await getNews();
  const urls = [`  <url><loc>${SITE_URL}/</loc></url>`];
  for (const item of items) {
    const slug = slugify(item.title);
    if (!slug) continue;
    const last = item.pubDate ? new Date(item.pubDate) : null;
    const lastmod = last && !Number.isNaN(last.getTime()) ? `<lastmod>${last.toISOString()}</lastmod>` : "";
    urls.push(`  <url><loc>${SITE_URL}/haber/${encodeURIComponent(slug)}</loc>${lastmod}<changefreq>hourly</changefreq><priority>0.8</priority></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && u.pathname === "/sitemap.xml") {
      try {
        const xml = await buildSitemap();
        res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
        return res.end(xml);
      } catch (e) {
        console.error("Sitemap hatası:", e);
        res.writeHead(502, { "Content-Type": "application/xml; charset=utf-8" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><error>${xmlEscape(e.message)}</error>`);
      }
    }

    if (req.method === "GET" && u.pathname === "/robots.txt") {
      const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return res.end(robots);
    }

    if (req.method === "GET" && u.pathname.startsWith("/haber/")) {
      const slug = decodeURIComponent(u.pathname.slice("/haber/".length));
      if (!slug || slug.includes("/")) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Haber bulunamadı.");
      }
      try {
        const items = await getNews();
        const item = items.find(x => slugify(x.title) === slug);
        if (!item) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          return res.end("<!doctype html><html lang=\"tr\"><meta charset=\"utf-8\"><title>Haber bulunamadı</title><p>Haber bulunamadı.</p>");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
        return res.end(renderArticlePage(item));
      } catch (e) {
        console.error("Haber sayfası hatası:", e);
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Haber şu anda yüklenemiyor.");
      }
    }

    if (req.method === "GET" && u.pathname === "/api/news") {
      try {
        const items = await getNews();
        return send(res, 200, { status: "ok", items, cached: Date.now() - rssCache.fetchedAt < RSS_TTL });
      } catch (e) {
        console.error("RSS hatası:", e);
        return send(res, 502, { status: "error", error: e.message });
      }
    }

    if (req.method === "POST" && u.pathname === "/api/generate-news") {
      let x;
      try { x = JSON.parse(await body(req)); }
      catch (_) { return send(res, 400, { error: "Geçersiz JSON." }); }

      const title = String(x.title || "").trim();
      const description = String(x.description || "").trim();
      const link = String(x.link || "").trim();
      if (!title) return send(res, 400, { error: "Haber başlığı eksik." });

      const k = hashKey(title, description);
      const cached = cache[k];

      if (cached?.article) {
        return send(res, 200, {
          article: cached.article,
          cached: true,
          type: cached.type || "gemini"
        });
      }

      try {
        const result = await generateOnce(k, title, description, link);
        return send(res, 200, result);
      } catch (e) {
        // Kota hatasında kullanıcıya hata sayfası göstermiyoruz.
        // Kaynak RSS metnini güvenli biçimde gösteriyoruz.
        if (e.quota) {
          const article = fallbackArticle(title, description, link);
          return send(res, 200, {
            article,
            cached: false,
            type: "fallback",
            quota: true,
            retrySeconds: e.retrySeconds || geminiCooldownSeconds
          });
        }

        console.error("Gemini hatası:", e);
        const article = fallbackArticle(title, description, link);
        return send(res, 200, {
          article,
          cached: false,
          type: "fallback",
          error: e.message || "Gemini kullanılamadı."
        });
      }
    }

    if (req.method === "GET" && u.pathname === "/health") {
      return send(res, 200, {
        status: "ok",
        geminiConfigured: Boolean(KEY),
        model: MODEL,
        geminiCooldown: Date.now() < geminiCooldownUntil,
        cooldownRemaining: Math.max(0, Math.ceil((geminiCooldownUntil - Date.now()) / 1000)),
        cachedArticles: Object.keys(cache).length
      });
    }

    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
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
