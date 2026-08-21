# Siyah & Beyaz — AI Haber Sistemi

Bu sürümde:

RSS → Node.js backend → OpenAI → konuya özel haber → web sitesindeki detay sayfası

şeklinde çalışır.

## Kurulum

1. Bilgisayarında Node.js kurulu olmalı.
2. Bu klasörde terminal aç.
3. `npm install` çalıştır.
4. `.env.example` dosyasını `.env` olarak kopyala.
5. `.env` içine kendi OpenAI API anahtarını yaz.
6. `npm start` çalıştır.
7. Tarayıcıdan `http://localhost:3000` adresini aç.

## Önemli

OpenAI API anahtarını `public/index.html` içine koyma.
Anahtar yalnızca sunucudaki `.env` dosyasında bulunmalıdır.

Her haber ilk açıldığında AI tarafından oluşturulur ve sunucu belleğinde önbelleğe alınır.
Aynı haber tekrar açıldığında tekrar API çağrısı yapılmaz.

RSS kaynağında bulunmayan bilgilerin uydurulmaması için AI istemi özellikle kısıtlanmıştır.
