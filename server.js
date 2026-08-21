const express = require("express");
const Parser = require("rss-parser");
require("dotenv").config();

const app = express();
const path = require("path");

const port = process.env.PORT || 3000;

const RSS_URL = "https://www.fotomac.com.tr/rss/besiktas.xml";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Modeli .env'den değiştirebilirsin.
// Varsayılan olarak güncel Flash modelini kullanıyoruz.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const parser = new Parser({
    timeout: 15000
});

let cachedItems = [];
const articleCache = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));


// --------------------------------------------------
// METİN TEMİZLEME
// --------------------------------------------------

function cleanText(text = "") {
    return String(text)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
}


// --------------------------------------------------
// RSS HABERLERİNİ ÇEK
// --------------------------------------------------

async function refreshFeed() {

    const feed = await parser.parseURL(RSS_URL);

    cachedItems = (feed.items || [])
        .slice(0, 30)
        .map((item, index) => {

            return {
                id:
                    item.guid ||
                    item.id ||
                    item.link ||
                    `${index}-${item.title}`,

                title: cleanText(item.title || ""),

                description: cleanText(
                    item.contentSnippet ||
                    item.content ||
                    item.description ||
                    ""
                ),

                thumbnail:
                    item.enclosure?.url ||
                    item["media:content"]?.url ||
                    item["media:thumbnail"]?.url ||
                    "",

                pubDate:
                    item.pubDate ||
                    item.isoDate ||
                    "",

                link:
                    item.link ||
                    ""
            };

        });

    return cachedItems;
}


// --------------------------------------------------
// HABER LİSTESİ API
// --------------------------------------------------

app.get("/api/news", async (req, res) => {

    try {

        if (!cachedItems.length) {
            await refreshFeed();
            app.locals.lastFeedRefresh = Date.now();
        }

        const now = Date.now();

        // 10 dakikada bir RSS yenile
        if (
            !app.locals.lastFeedRefresh ||
            now - app.locals.lastFeedRefresh > 10 * 60 * 1000
        ) {

            app.locals.lastFeedRefresh = now;

            refreshFeed().catch(error => {
                console.error(
                    "RSS yenileme hatası:",
                    error.message
                );
            });
        }

        res.json({
            items: cachedItems
        });

    } catch (error) {

        console.error(
            "RSS hatası:",
            error.message
        );

        res.status(500).json({
            error: "RSS haberleri alınamadı."
        });

    }

});


// --------------------------------------------------
// HABER BUL
// --------------------------------------------------

function findItem(index) {

    const numericIndex = Number(index);

    if (
        !Number.isInteger(numericIndex) ||
        numericIndex < 0 ||
        numericIndex >= cachedItems.length
    ) {

        return null;

    }

    return cachedItems[numericIndex];
}


// --------------------------------------------------
// AI ÇIKTISINDAKİ MARKDOWN KOD BLOKLARINI TEMİZLE
// --------------------------------------------------

function stripCodeFences(text = "") {

    return text
        .replace(/^```html\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

}


// --------------------------------------------------
// GEMINI'DEN HABER OLUŞTUR
// --------------------------------------------------

app.post("/api/generate-news", async (req, res) => {

    try {

        if (!GEMINI_API_KEY) {

            return res.status(500).json({
                error:
                    "GEMINI_API_KEY bulunamadı. .env dosyanı kontrol et."
            });

        }


        const item = findItem(req.body?.index);


        if (!item) {

            return res.status(404).json({
                error: "Haber bulunamadı."
            });

        }


        // Aynı haber daha önce oluşturulduysa
        // tekrar Gemini API çağrısı yapma.
        const cacheKey = item.id;


        if (articleCache.has(cacheKey)) {

            return res.json({
                html: articleCache.get(cacheKey)
            });

        }


        // --------------------------------------------------
        // GEMINI PROMPT
        // --------------------------------------------------

        const prompt = `

Sen profesyonel bir Türkçe spor haber editörüsün.

Görevin, aşağıdaki RSS haberini temel alarak
SADECE BU HABERİN KONUSUNA ODAKLANAN,
özgün, uzun ve okunabilir bir haber metni hazırlamak.

ÇOK ÖNEMLİ KURALLAR:

1. Haber yaklaşık 500-700 kelime olsun.

2. Haber başlığında anlatılan konu neyse
   bütün metin o konu etrafında ilerlesin.

3. Başka haberlerde kullanılabilecek genel,
   alakasız Beşiktaş paragrafları yazma.

4. Kaynakta bulunmayan bilgileri UYDURMA.

5. Kaynakta olmayan:
   - oyuncu
   - transfer
   - skor
   - tarih
   - sakatlık
   - teknik direktör açıklaması
   - kulüp açıklaması
   - ücret
   - anlaşma
   - maç sonucu
   gibi bilgileri gerçekmiş gibi yazma.

6. Kaynak metin kısa ise,
   mevcut bilgileri daha anlaşılır şekilde açıklayabilirsin;
   fakat yeni gerçekler icat etme.

7. Kaynak metni kelimesi kelimesine kopyalama.

8. Haber dili profesyonel ve doğal Türkçe olsun.

9. Haber içinde 3-5 adet anlamlı ara başlık kullan.

10. İlk paragraf haberin en önemli bilgisini
    doğrudan anlatsın.

11. Gereksiz tekrar yapma.

12. "Yapay zekâ", "AI tarafından oluşturuldu",
    "kaynak metne göre" gibi ifadeler kullanma.

13. Sadece HTML döndür.

14. Kullanabileceğin HTML etiketleri:

<p>
<h3>
<strong>
<ul>
<li>

15. Markdown kullanma.

16. Kaynak linki veya kaynakça ekleme.


HABER BAŞLIĞI:

${item.title}


KAYNAK HABER:

${item.description}

`;


        // --------------------------------------------------
        // GEMINI API
        // --------------------------------------------------

        const apiUrl =
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
                GEMINI_MODEL
            )}:generateContent?key=${encodeURIComponent(
                GEMINI_API_KEY
            )}`;


        const geminiResponse = await fetch(apiUrl, {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({

                contents: [

                    {
                        role: "user",

                        parts: [
                            {
                                text: prompt
                            }
                        ]
                    }

                ],

                generationConfig: {

                    temperature: 0.7,

                    maxOutputTokens: 2200

                }

            })

        });


        const responseData =
            await geminiResponse.json();


        // --------------------------------------------------
        // GEMINI HATA KONTROLÜ
        // --------------------------------------------------

        if (!geminiResponse.ok) {

            console.error(
                "Gemini API hatası:",
                JSON.stringify(
                    responseData,
                    null,
                    2
                )
            );


            const apiMessage =
                responseData?.error?.message ||
                "Gemini API isteği başarısız oldu.";


            return res.status(
                geminiResponse.status
            ).json({

                error: apiMessage

            });

        }


        // --------------------------------------------------
        // GEMINI CEVABINI AL
        // --------------------------------------------------

        let html = "";


        const candidates =
            responseData?.candidates || [];


        for (const candidate of candidates) {

            const parts =
                candidate?.content?.parts || [];


            for (const part of parts) {

                if (part.text) {

                    html += part.text;

                }

            }

        }


        html = stripCodeFences(html);


        if (!html) {

            throw new Error(
                "Gemini boş cevap döndürdü."
            );

        }


        // --------------------------------------------------
        // SADECE İZİN VERİLEN HTML ETİKETLERİ
        // --------------------------------------------------

        html = html
            .replace(
                /<(?!\/?(?:p|h3|strong|ul|li)\b)[^>]*>/gi,
                ""
            )
            .trim();


        // --------------------------------------------------
        // ÖNBELLEĞE AL
        // --------------------------------------------------

        articleCache.set(
            cacheKey,
            html
        );


        res.json({
            html: html
        });


    } catch (error) {

        console.error(
            "Gemini haber oluşturma hatası:",
            error
        );


        res.status(500).json({

            error:
                error?.message ||
                "Gemini haber metnini oluşturamadı."

        });

    }

});


// --------------------------------------------------
// SİTENİN ANA SAYFASI
// --------------------------------------------------

app.get("/{*splat}", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );

});


// --------------------------------------------------
// SUNUCUYU BAŞLAT
// --------------------------------------------------

app.listen(port, () => {

    console.log(
        `Siyah & Beyaz çalışıyor: http://localhost:${port}`
    );

    console.log(
        `Gemini modeli: ${GEMINI_MODEL}`
    );

});