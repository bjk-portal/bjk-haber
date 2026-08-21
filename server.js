const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||10000, KEY=process.env.GEMINI_API_KEY, MODEL=process.env.GEMINI_MODEL||'gemini-3.5-flash-lite', ROOT=__dirname, CACHE=path.join(ROOT,'article-cache.json');
let cache={}; const inFlight=new Map();
try{if(fs.existsSync(CACHE))cache=JSON.parse(fs.readFileSync(CACHE,'utf8'));}catch(_){cache={};}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1000000)reject(new Error('İstek çok büyük.'));});req.on('end',()=>resolve(b));req.on('error',reject);});}
function key(t,d){return crypto.createHash('sha256').update(t+'|'+d).digest('hex');}
function save(){try{fs.writeFileSync(CACHE,JSON.stringify(cache),'utf8')}catch(_){}}
async function generate(title,description,link){
 if(!KEY)throw new Error('GEMINI_API_KEY Render Environment Variables içinde tanımlı değil.');
 const prompt=`Sen Siyah & Beyaz adlı Beşiktaş haber sitesinin kıdemli spor editörüsün.
BAŞLIK:
${title}
KAYNAK METNİ:
${description}
KAYNAK LİNKİ:
${link||'Yok'}
Kurallar:
- Türkçe, yaklaşık 1000-1500 kelimelik özgün ve ayrıntılı haber yaz.
- En az 7 ayrı bölüm kullan; bölüm başlıklarını ## ile başlat.
- Bu haberin gerçek konusuna odaklan; başka haberlere yapıştırılabilecek genel metin kullanma.
- Kaynakta olmayan transfer, skor, tarih, sakatlık, açıklama, karar veya alıntı UYDURMA.
- Kaynak kısa ise yalnızca kaynakta desteklenen bağlamı ve olası sportif etkileri analiz et; kesin olmayan çıkarımları olasılık/değerlendirme olarak belirt.
- Doğal spor gazetesi üslubu kullan; klişe girişlerden kaçın.
- HTML veya tablo kullanma.`;
 const u=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(KEY)}`;
 const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:2800}})});
 const data=await r.json(); if(!r.ok){
    const msg=data?.error?.message||`Gemini HTTP ${r.status}`;
    const err=new Error(msg);
    err.status=r.status;
    err.retryAfter=Number(r.headers.get('retry-after')||0);
    throw err;
  }
 const text=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim(); if(!text)throw new Error('Gemini boş cevap döndürdü.'); return text;
}
http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host}`);
 if(req.method==='POST'&&u.pathname==='/api/generate-news'){
  let x;try{x=JSON.parse(await body(req))}catch(_){return send(res,400,{error:'Geçersiz JSON.'})}
  const title=String(x.title||'').trim(),description=String(x.description||'').trim(),link=String(x.link||'').trim();
  if(!title)return send(res,400,{error:'Haber başlığı eksik.'});
  const k=key(title,description);
  if(cache[k])return send(res,200,{article:cache[k],cached:true});
  if(inFlight.has(k)){try{return send(res,200,{article:await inFlight.get(k),cached:true});}catch(e){return send(res,429,{error:e.message,quota:true});}}
  const job=generate(title,description,link); inFlight.set(k,job);
  try{const article=await job;cache[k]=article;save();return send(res,200,{article,cached:false});}
  catch(e){
    console.error('Gemini hatası:',e.message);
    const status=e.status===429?429:500;
    return send(res,status,{
      error:e.message,
      quota:e.status===429,
      retryAfter:e.retryAfter||0
    });
  }
  finally{inFlight.delete(k);}
 }
 if(req.method==='GET'&&u.pathname==='/health')return send(res,200,{status:'ok',geminiConfigured:Boolean(KEY),model:MODEL,cacheEntries:Object.keys(cache).length});
 if(req.method==='GET'&&u.pathname==='/api/news'){
  const rss='https://www.fotomac.com.tr/rss/besiktas.xml';
  try{
    const ac=new AbortController();
    const timer=setTimeout(()=>ac.abort(),12000);
    const rr=await fetch(rss,{signal:ac.signal,headers:{'User-Agent':'Mozilla/5.0'}});
    clearTimeout(timer);
    if(!rr.ok) throw new Error('RSS HTTP '+rr.status);
    const xml=await rr.text();
    res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=120'});
    return res.end(xml);
  }catch(e){
    console.error('RSS hatası:',e.message);
    return send(res,502,{error:'Haber kaynağına ulaşılamadı.',detail:e.message});
  }
 }
 if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){const f=fs.readFileSync(path.join(ROOT,'public','index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(f);}
 res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'Bulunamadı.'}));
}catch(e){console.error(e);send(res,500,{error:e.message||'Sunucu hatası.'})}}).listen(PORT,'0.0.0.0',()=>console.log('Siyah & Beyaz sunucusu '+PORT+' portunda çalışıyor.'));
