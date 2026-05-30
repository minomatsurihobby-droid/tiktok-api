/**
 * ============================================================================
 *  YouTube Alternative — "GenTube"
 *  Vercel Single-File Node.js Application (no public/ folder, no external deps)
 *  ----------------------------------------------------------------------------
 *  - Backed by multiple Piped public API instances (auto-failover)
 *  - googlevideo streams are reverse-proxied through this server (CORS bypass)
 *  - HLS / DASH playback supported via hls.js (loaded from CDN)
 *  - YouTube-like UI: home, trending, search, watch page, channel, comments,
 *    related videos, subscriptions (localStorage), watch history (localStorage),
 *    dark/light theme, infinite scroll-ish "load more", search suggestions.
 *  - No Google API key required.
 * ============================================================================
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

/* ============================================================================
 *  Piped API instance pool — auto failover.
 *  Sourced from https://github.com/TeamPiped/documentation public-instances list.
 * ========================================================================== */
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
  'https://pipedapi.ducks.party',
  'https://piped-api.codespace.cz',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.private.coffee',
  'https://pipedapi.darkness.services',
  'https://pipedapi.orangenet.cc',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.nosebs.ru'
];

// In-memory rotation index so subsequent requests try a different instance first
let instanceCursor = 0;

/* ============================================================================
 *  HTTP helper — promisified GET with gzip/br/deflate, redirects, timeout.
 * ========================================================================== */
function httpRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(targetUrl); } catch (e) { return reject(e); }

    const lib = urlObj.protocol === 'http:' ? http : https;
    const reqOptions = {
      method: options.method || 'GET',
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      }, options.headers || {})
    };

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects (max 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (options.redirectCount || 0) < 5) {
        const next = new URL(res.headers.location, targetUrl).toString();
        res.resume();
        return resolve(httpRequest(next, Object.assign({}, options, { redirectCount: (options.redirectCount || 0) + 1 })));
      }

      // Stream-passthrough mode (for proxying)
      if (options.streamPassthrough) {
        return resolve({ statusCode: res.statusCode, headers: res.headers, stream: res });
      }

      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: buf });
      });
      stream.on('error', reject);
    });

    req.setTimeout(options.timeout || 15000, () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/* ============================================================================
 *  Piped API client with automatic failover.
 *  Strategy:
 *   - Try the cursor-preferred instance first, then walk the list.
 *   - Reject empty/short bodies, JSON parse errors, and known-bad responses.
 *   - Validate that the response looks meaningful for the endpoint.
 * ========================================================================== */
function looksValid(path, json) {
  if (json == null) return false;
  if (Array.isArray(json)) return json.length > 0;
  if (typeof json !== 'object') return false;
  if (json.error && !(json.title || json.items || json.relatedStreams || json.videoStreams || json.hls || json.comments)) return false;
  if (path.startsWith('/streams/')) {
    // need a playable manifest or at least streams
    return !!(json.hls || (Array.isArray(json.videoStreams) && json.videoStreams.length) || (Array.isArray(json.audioStreams) && json.audioStreams.length) || json.title);
  }
  if (path.startsWith('/search')) return Array.isArray(json.items);
  if (path.startsWith('/channel')) return !!(json.name || json.relatedStreams);
  if (path.startsWith('/comments/')) return Array.isArray(json.comments) || !!json.commentCount;
  if (path.startsWith('/trending')) return Array.isArray(json) && json.length > 0;
  if (path.startsWith('/nextpage')) return !!(json.items || json.relatedStreams || json.comments);
  return true;
}

async function pipedFetch(path) {
  const startIdx = instanceCursor;
  const tried = [];
  for (let i = 0; i < PIPED_INSTANCES.length; i++) {
    const idx = (startIdx + i) % PIPED_INSTANCES.length;
    const base = PIPED_INSTANCES[idx];
    const url = base + path;
    tried.push(base);
    try {
      const res = await httpRequest(url, { timeout: 7000 });
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      const txt = res.body.toString('utf8').trim();
      if (!txt || txt.length < 2) continue;
      let json;
      try { json = JSON.parse(txt); } catch (e) { continue; }
      if (!looksValid(path, json)) continue;
      instanceCursor = idx; // remember last successful
      return json;
    } catch (e) {
      // try next
    }
  }
  throw new Error('All Piped instances failed for ' + path);
}

/* ============================================================================
 *  Static assets returned inline (HTML / CSS / JS) — no public folder used.
 * ========================================================================== */

const CSS = /* css */ `
:root{
  --bg:#0f0f0f; --bg-elev:#212121; --bg-hover:#3f3f3f;
  --text:#f1f1f1; --text-sub:#aaa; --border:#303030;
  --accent:#ff0000; --accent-hover:#cc0000;
  --header-h:56px; --sidebar-w:240px; --sidebar-mini-w:72px;
  --radius:12px;
}
.light{
  --bg:#ffffff; --bg-elev:#f2f2f2; --bg-hover:#e5e5e5;
  --text:#0f0f0f; --text-sub:#606060; --border:#e5e5e5;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:"Roboto","Noto Sans JP",Arial,sans-serif;font-size:14px}
a{color:inherit;text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
img{display:block;max-width:100%}

/* ---------- HEADER ---------- */
header{
  position:fixed;top:0;left:0;right:0;height:var(--header-h);
  display:flex;align-items:center;padding:0 16px;
  background:var(--bg);z-index:50;gap:16px;
}
.hdr-left{display:flex;align-items:center;gap:16px;min-width:160px}
.menu-btn{font-size:22px;padding:8px;border-radius:50%;width:40px;height:40px;display:grid;place-items:center}
.menu-btn:hover{background:var(--bg-hover)}
.logo{display:flex;align-items:center;gap:4px;font-size:20px;font-weight:700;letter-spacing:-1px;cursor:pointer}
.logo .play{
  width:32px;height:22px;background:var(--accent);border-radius:6px;
  display:grid;place-items:center;color:#fff;
}
.logo .play::before{
  content:""; border-left:9px solid #fff;
  border-top:6px solid transparent;border-bottom:6px solid transparent;
  margin-left:2px;
}
.hdr-center{flex:1;display:flex;justify-content:center;max-width:720px;margin:0 auto}
.search-wrap{flex:1;display:flex;height:40px;max-width:640px;position:relative}
.search-input{
  flex:1;background:var(--bg);border:1px solid var(--border);border-right:none;
  border-radius:40px 0 0 40px;padding:0 16px 0 16px;color:var(--text);outline:none;font-size:16px;
}
.search-input:focus{border-color:#1c62b9;box-shadow:inset 0 0 0 1px #1c62b9}
.search-btn{
  width:64px;background:var(--bg-elev);border:1px solid var(--border);
  border-radius:0 40px 40px 0;display:grid;place-items:center;font-size:18px;
}
.search-btn:hover{background:var(--bg-hover)}
.suggestions{
  position:absolute;top:42px;left:0;right:64px;background:var(--bg-elev);
  border:1px solid var(--border);border-radius:8px;overflow:hidden;z-index:60;display:none;
}
.suggestions.active{display:block}
.suggestions div{padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:10px}
.suggestions div:hover{background:var(--bg-hover)}
.hdr-right{display:flex;align-items:center;gap:8px;min-width:160px;justify-content:flex-end}
.icon-btn{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:20px}
.icon-btn:hover{background:var(--bg-hover)}

/* ---------- SIDEBAR ---------- */
aside{
  position:fixed;top:var(--header-h);left:0;bottom:0;width:var(--sidebar-w);
  overflow-y:auto;padding:12px 0;background:var(--bg);
  transition:width .15s ease;
}
aside.mini{width:var(--sidebar-mini-w)}
aside.mini .side-label,aside.mini .side-section-title{display:none}
aside.mini .side-item{flex-direction:column;padding:14px 0;gap:4px;font-size:10px}
aside.mini .side-item span.ico{font-size:22px}
.side-section{padding:8px 0;border-bottom:1px solid var(--border)}
.side-section:last-child{border-bottom:none}
.side-section-title{padding:8px 24px;color:var(--text-sub);font-size:14px;font-weight:600}
.side-item{
  display:flex;align-items:center;gap:24px;padding:8px 24px;cursor:pointer;
  border-radius:10px;margin:0 12px;
}
.side-item:hover{background:var(--bg-hover)}
.side-item.active{background:var(--bg-hover);font-weight:600}
.side-item .ico{font-size:20px;width:24px;text-align:center}

/* ---------- MAIN ---------- */
main{margin-top:var(--header-h);margin-left:var(--sidebar-w);padding:24px;transition:margin-left .15s}
main.expanded{margin-left:var(--sidebar-mini-w)}

/* chip row */
.chips{display:flex;gap:12px;overflow-x:auto;padding:0 0 16px;position:sticky;top:var(--header-h);background:var(--bg);z-index:10}
.chips::-webkit-scrollbar{display:none}
.chip{
  background:var(--bg-elev);border:1px solid var(--border);
  padding:6px 14px;border-radius:8px;white-space:nowrap;font-size:14px;cursor:pointer;
}
.chip:hover{background:var(--bg-hover)}
.chip.active{background:var(--text);color:var(--bg);border-color:var(--text)}

/* video grid */
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(290px,1fr));
  gap:16px 12px;
}
.card{cursor:pointer;display:flex;flex-direction:column;gap:10px}
.card .thumb{
  position:relative;border-radius:var(--radius);overflow:hidden;background:#000;aspect-ratio:16/9;
}
.card .thumb img{width:100%;height:100%;object-fit:cover;transition:transform .2s}
.card:hover .thumb img{transform:scale(1.02)}
.card .dur{
  position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.85);
  color:#fff;font-size:12px;padding:2px 4px;border-radius:4px;font-weight:500;
}
.card .meta{display:flex;gap:12px}
.card .avatar{width:36px;height:36px;border-radius:50%;background:var(--bg-elev);flex-shrink:0;overflow:hidden}
.card .info{flex:1;min-width:0}
.card .title{font-size:14px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0 0 4px}
.card .uploader{color:var(--text-sub);font-size:13px;line-height:1.4}
.card .uploader:hover{color:var(--text)}
.card .stats{color:var(--text-sub);font-size:13px;line-height:1.4}

/* ---------- WATCH PAGE ---------- */
.watch{display:grid;grid-template-columns:minmax(0,1fr) 402px;gap:24px;max-width:1800px;margin:0 auto}
@media (max-width:1100px){.watch{grid-template-columns:1fr}}
.player-wrap{width:100%;aspect-ratio:16/9;background:#000;border-radius:var(--radius);overflow:hidden;position:relative}
.player-wrap video{width:100%;height:100%;background:#000}
.player-loading{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:18px;z-index:5;background:rgba(0,0,0,.55);pointer-events:none}
.watch h1{font-size:20px;margin:14px 0 10px;line-height:1.3}
.watch-actions{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:14px}
.uploader-box{display:flex;align-items:center;gap:12px}
.uploader-box .avatar{width:40px;height:40px;border-radius:50%;background:var(--bg-elev);overflow:hidden;flex-shrink:0}
.uploader-box .name{font-weight:600;font-size:15px}
.uploader-box .subs{font-size:12px;color:var(--text-sub)}
.btn{
  background:var(--bg-elev);padding:8px 16px;border-radius:24px;font-weight:600;
  display:inline-flex;align-items:center;gap:6px;font-size:14px;
}
.btn:hover{background:var(--bg-hover)}
.btn.primary{background:var(--text);color:var(--bg)}
.btn.primary:hover{opacity:.85}
.btn.red{background:var(--accent);color:#fff}
.action-group{display:flex;gap:8px;flex-wrap:wrap}
.desc{background:var(--bg-elev);padding:12px 14px;border-radius:12px;font-size:14px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:hidden;cursor:pointer;line-height:1.5}
.desc.expanded{max-height:none}
.desc .stats-line{font-weight:700;margin-bottom:6px}

/* comments */
.comments h3{font-size:16px;margin:24px 0 16px}
.comment{display:flex;gap:12px;margin-bottom:18px}
.comment .avatar{width:40px;height:40px;border-radius:50%;background:var(--bg-elev);overflow:hidden;flex-shrink:0}
.comment .body{flex:1;min-width:0}
.comment .author{font-size:13px;font-weight:600;margin-bottom:2px}
.comment .author .time{color:var(--text-sub);font-weight:400;margin-left:6px;font-size:12px}
.comment .text{font-size:14px;white-space:pre-wrap;word-break:break-word;line-height:1.5}
.comment .meta-row{margin-top:6px;color:var(--text-sub);font-size:12px;display:flex;gap:14px}

/* sidebar related */
.related .card{flex-direction:row;gap:8px}
.related .card .thumb{width:168px;height:94px;aspect-ratio:auto;flex-shrink:0}
.related .card .info{padding-top:0}
.related .card .title{font-size:14px;-webkit-line-clamp:2}
.related .card .uploader,.related .card .stats{font-size:12px}

/* channel page */
.ch-banner{width:100%;aspect-ratio:6/1;border-radius:12px;overflow:hidden;background:var(--bg-elev);margin-bottom:18px}
.ch-banner img{width:100%;height:100%;object-fit:cover}
.ch-head{display:flex;align-items:center;gap:18px;margin-bottom:24px}
.ch-head .avatar{width:120px;height:120px;border-radius:50%;background:var(--bg-elev);overflow:hidden}
.ch-head h1{margin:0 0 6px;font-size:24px}
.ch-head .stats{color:var(--text-sub);font-size:13px}

/* utility */
.center{display:grid;place-items:center;min-height:50vh;color:var(--text-sub);text-align:center;padding:32px}
.spinner{width:42px;height:42px;border:4px solid var(--bg-elev);border-top-color:var(--accent);border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-elev);border:1px solid var(--border);padding:10px 18px;border-radius:8px;z-index:200;opacity:0;transition:opacity .25s}
.toast.show{opacity:1}

/* scrollbars */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:var(--bg-hover);border-radius:4px}
::-webkit-scrollbar-track{background:transparent}

/* mobile */
@media (max-width:900px){
  aside{transform:translateX(-100%);transition:transform .2s}
  aside.show{transform:translateX(0);z-index:60;background:var(--bg);box-shadow:2px 0 12px rgba(0,0,0,.5)}
  main{margin-left:0}
  .hdr-left .logo span{display:none}
  .hdr-right{min-width:auto}
}
`;

const CLIENT_JS = /* javascript */ `
/* =========================================================================
 *  GenTube client — single-page YouTube-like experience.
 * ========================================================================= */
(function(){
'use strict';

const $ = (sel,p)=>{ return (p||document).querySelector(sel); };
const $$ = (sel,p)=>{ return Array.from((p||document).querySelectorAll(sel)); };
const ce = (tag, attrs, ...children)=>{
  const el = document.createElement(tag);
  if(attrs){
    for(const k in attrs){
      if(k==='class') el.className = attrs[k];
      else if(k==='style' && typeof attrs[k]==='object') Object.assign(el.style, attrs[k]);
      else if(k.startsWith('on') && typeof attrs[k]==='function') el.addEventListener(k.slice(2), attrs[k]);
      else if(k==='html') el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
  }
  for(const c of children){
    if(c==null) continue;
    if(typeof c==='string'||typeof c==='number') el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
};

// proxy any thumbnail/avatar to bypass CORS / hot-link blocks
function proxyImg(url){
  if(!url) return '';
  // Already proxied or data URI
  if(url.startsWith('/api/proxy')||url.startsWith('data:')) return url;
  return '/api/img?u='+encodeURIComponent(url);
}

function formatViews(n){
  if(n==null||isNaN(n)) return '';
  n = Number(n);
  if(n>=1e9) return (n/1e9).toFixed(1).replace(/\\.0$/,'')+'B';
  if(n>=1e6) return (n/1e6).toFixed(1).replace(/\\.0$/,'')+'M';
  if(n>=1e3) return (n/1e3).toFixed(1).replace(/\\.0$/,'')+'K';
  return String(n);
}
function formatDuration(sec){
  if(sec==null||sec<0) return '';
  sec=Math.floor(sec);
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  const pad=(x)=>String(x).padStart(2,'0');
  return h>0 ? h+':'+pad(m)+':'+pad(s) : m+':'+pad(s);
}
function timeAgo(ts){
  if(!ts) return '';
  let s = (Date.now()-ts)/1000;
  const u=[['年',31536000],['ヶ月',2592000],['週間',604800],['日',86400],['時間',3600],['分',60]];
  for(const [n,v] of u){ if(s>=v) return Math.floor(s/v)+n+'前'; }
  return Math.floor(s)+'秒前';
}

/* localStorage helpers */
const LS = {
  get(k,d){ try{ return JSON.parse(localStorage.getItem('gt_'+k))||d; }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem('gt_'+k, JSON.stringify(v)); }catch(e){} }
};

function addHistory(v){
  const h = LS.get('history', []);
  const id = v.url ? v.url.split('v=')[1] : v.videoId;
  const filtered = h.filter(x=>x.id!==id);
  filtered.unshift({id, title:v.title, thumbnail:v.thumbnail, uploader:v.uploaderName||v.uploader, uploaderUrl:v.uploaderUrl, duration:v.duration, ts:Date.now()});
  LS.set('history', filtered.slice(0,200));
}
function toast(msg){
  const t = $('#toast') || (function(){ const x=ce('div',{id:'toast',class:'toast'}); document.body.appendChild(x); return x; })();
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ===================== API helpers ===================== */
async function api(path){
  const r = await fetch('/api'+path);
  if(!r.ok) throw new Error('API error '+r.status);
  return r.json();
}

/* ===================== Render: video card ===================== */
function videoCard(v, opts){
  opts = opts || {};
  const id = (v.url||v.videoId||'').replace('/watch?v=','').replace(/^\\?v=/,'').split('&')[0].replace(/^v=/,'');
  const videoId = id || v.videoId;
  const thumb = proxyImg(v.thumbnail || v.thumbnailUrl);
  const avatar = proxyImg(v.uploaderAvatar);
  const uploaderName = v.uploaderName || v.uploader || '';
  const uploaderUrl = v.uploaderUrl || '';
  const dur = formatDuration(v.duration);
  const views = v.views!=null ? formatViews(v.views)+' 回視聴' : '';
  const uploaded = v.uploadedDate || (v.uploaded ? timeAgo(v.uploaded) : '');

  const card = ce('div', {class:'card', onclick:(e)=>{
    e.preventDefault();
    location.hash = '#/watch?v='+videoId;
  }},
    ce('div',{class:'thumb'},
      thumb? ce('img',{src:thumb, loading:'lazy', alt:v.title||''}) : null,
      dur? ce('span',{class:'dur'}, dur) : null
    ),
    ce('div',{class:'meta'},
      !opts.hideAvatar && uploaderUrl ? ce('a',{class:'avatar', href:'#'+uploaderUrl, onclick:(e)=>{ e.stopPropagation(); }},
        avatar? ce('img',{src:avatar, alt:''}) : null
      ) : null,
      ce('div',{class:'info'},
        ce('div',{class:'title'}, v.title||''),
        uploaderName? ce('a',{class:'uploader', href:'#'+uploaderUrl, onclick:(e)=>{ e.stopPropagation(); }}, uploaderName) : null,
        (views || uploaded) ? ce('div',{class:'stats'}, [views, uploaded].filter(Boolean).join(' · ')) : null
      )
    )
  );
  return card;
}

/* ===================== Loading / Error helpers ===================== */
function showLoading(target){
  target.innerHTML='';
  target.appendChild(ce('div',{class:'center'}, ce('div',{class:'spinner'})));
}
function showError(target, msg){
  target.innerHTML='';
  target.appendChild(ce('div',{class:'center'},
    ce('div',{},'⚠️ '+msg),
    ce('button',{class:'btn', style:{marginTop:'12px'}, onclick:()=>location.reload()}, '再読み込み')
  ));
}

/* ===================== Page: Home / Trending ===================== */
async function pageHome(){
  const main = $('#main');
  main.innerHTML='';

  const chips = ce('div',{class:'chips'});
  const currentRegion = LS.get('region','JP');
  const categories = [
    {label:'すべて', region: currentRegion, active:true},
    {label:'音楽', region: currentRegion, q:'music'},
    {label:'ゲーム', region: currentRegion, q:'gaming'},
    {label:'ニュース', region: currentRegion, q:'news'},
    {label:'ライブ', region: currentRegion, q:'live'},
    {label:'スポーツ', region: currentRegion, q:'sports'},
    {label:'映画', region: currentRegion, q:'movies'},
    {label:'学習', region: currentRegion, q:'education'},
    {label:'テクノロジー', region: currentRegion, q:'technology'},
    {label:'料理', region: currentRegion, q:'cooking'},
    {label:'最近アップロード', region: currentRegion, sort:'upload_date'}
  ];
  for(const c of categories){
    const chip = ce('button',{class:'chip'+(c.active?' active':''), onclick:()=>{
      $$('.chip', chips).forEach(x=>x.classList.remove('active'));
      chip.classList.add('active');
      if(c.q){ location.hash = '#/search?q='+encodeURIComponent(c.q); }
      else loadTrending();
    }}, c.label);
    chips.appendChild(chip);
  }
  main.appendChild(chips);
  const grid = ce('div',{class:'grid', id:'grid'});
  main.appendChild(grid);

  async function loadTrending(){
    showLoading(grid);
    try{
      const data = await api('/trending?region='+currentRegion);
      grid.innerHTML='';
      if(!Array.isArray(data)||!data.length){ showError(grid,'トレンドを読み込めませんでした'); return; }
      for(const v of data) grid.appendChild(videoCard(v));
    }catch(e){ showError(grid, 'トレンドの読み込みに失敗しました: '+e.message); }
  }
  loadTrending();
}

/* ===================== Page: Search ===================== */
async function pageSearch(q){
  const main = $('#main');
  main.innerHTML='';
  const filters = [
    {label:'すべて',  v:'all'},
    {label:'動画',    v:'videos'},
    {label:'チャンネル', v:'channels'},
    {label:'プレイリスト', v:'playlists'},
    {label:'音楽',    v:'music_songs'}
  ];
  const chips = ce('div',{class:'chips'});
  let curFilter='all';
  filters.forEach(f=>{
    const chip = ce('button',{class:'chip'+(f.v===curFilter?' active':''), onclick:()=>{
      curFilter=f.v;
      $$('.chip',chips).forEach(x=>x.classList.remove('active'));
      chip.classList.add('active');
      doSearch();
    }}, f.label);
    chips.appendChild(chip);
  });
  main.appendChild(chips);

  const grid = ce('div',{class:'grid', id:'grid'});
  main.appendChild(grid);

  let nextpage = null;
  async function doSearch(){
    showLoading(grid);
    try{
      const data = await api('/search?q='+encodeURIComponent(q)+'&filter='+curFilter);
      grid.innerHTML='';
      const items = data.items || [];
      if(!items.length){ showError(grid,'結果が見つかりません'); return; }
      for(const it of items){
        if(it.type==='channel'){
          grid.appendChild(channelCard(it));
        } else {
          grid.appendChild(videoCard(it));
        }
      }
      nextpage = data.nextpage;
      if(nextpage) addLoadMore();
    }catch(e){ showError(grid, '検索失敗: '+e.message); }
  }

  function addLoadMore(){
    const btn = ce('button',{class:'btn', style:{margin:'20px auto',gridColumn:'1/-1'}, onclick: async ()=>{
      btn.disabled=true; btn.textContent='読み込み中...';
      try{
        const data = await api('/nextpage/search?q='+encodeURIComponent(q)+'&filter='+curFilter+'&nextpage='+encodeURIComponent(nextpage));
        btn.remove();
        const items = data.items || [];
        for(const it of items){
          if(it.type==='channel') grid.appendChild(channelCard(it));
          else grid.appendChild(videoCard(it));
        }
        nextpage = data.nextpage;
        if(nextpage) addLoadMore();
      }catch(e){ btn.textContent='もっと見る'; btn.disabled=false; toast('読み込み失敗'); }
    }}, 'もっと見る');
    grid.appendChild(btn);
  }

  function channelCard(c){
    const url = c.url || '';
    return ce('div',{class:'card', onclick:()=> location.hash = '#'+url},
      ce('div',{class:'thumb', style:{aspectRatio:'1/1',borderRadius:'50%',maxWidth:'180px',margin:'0 auto'}},
        c.thumbnail? ce('img',{src:proxyImg(c.thumbnail)}) : null
      ),
      ce('div',{class:'meta'},
        ce('div',{class:'info', style:{textAlign:'center',width:'100%'}},
          ce('div',{class:'title'}, c.name||''),
          ce('div',{class:'stats'}, (c.subscribers!=null? formatViews(c.subscribers)+' 人の登録者':'') + (c.videos? ' · 動画 '+c.videos+'本':'')),
          c.description? ce('div',{class:'stats'}, c.description.slice(0,100)) : null
        )
      )
    );
  }

  doSearch();
}

/* ===================== Page: Watch ===================== */
let hlsInstance = null;
async function pageWatch(videoId){
  const main = $('#main');
  main.innerHTML='';
  const layout = ce('div',{class:'watch'});
  const left  = ce('div',{});
  const right = ce('div',{class:'related'});
  layout.appendChild(left);
  layout.appendChild(right);
  main.appendChild(layout);

  showLoading(left);
  right.innerHTML='';
  right.appendChild(ce('div',{class:'center', style:{minHeight:'200px'}}, ce('div',{class:'spinner'})));

  let data;
  try{
    data = await api('/streams/'+videoId);
  }catch(e){
    showError(left,'動画情報の取得に失敗: '+e.message);
    right.innerHTML='';
    return;
  }
  if(data && data.error){
    showError(left, '読込失敗: '+data.error);
    right.innerHTML='';
    return;
  }

  /* ----------- Build player ----------- */
  left.innerHTML='';
  const playerWrap = ce('div',{class:'player-wrap'},
    ce('video',{id:'player', controls:'controls', playsinline:'playsinline', autoplay:'autoplay', crossorigin:'anonymous'}),
    ce('div',{class:'player-loading', id:'pload'}, '読み込み中...')
  );
  left.appendChild(playerWrap);

  const video = $('#player', left);
  const ploading = $('#pload', left);
  video.addEventListener('canplay', ()=> ploading.style.display='none');
  video.addEventListener('playing', ()=> ploading.style.display='none');
  video.addEventListener('waiting', ()=> ploading.style.display='grid');

  /* choose stream source — prefer HLS, else best MP4 video+audio if available */
  let sourceSet = false;
  if(data.hls){
    const hlsUrl = '/api/proxy?u='+encodeURIComponent(data.hls);
    if(video.canPlayType('application/vnd.apple.mpegurl')){
      video.src = hlsUrl; sourceSet=true;
    } else if(window.Hls && Hls.isSupported()){
      if(hlsInstance){ try{hlsInstance.destroy();}catch(e){} }
      hlsInstance = new Hls({ enableWorker:true, lowLatencyMode:false });
      hlsInstance.loadSource(hlsUrl);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.ERROR, function(_, d){ if(d.fatal){ console.warn('HLS fatal', d); } });
      sourceSet = true;
    }
  }
  if(!sourceSet){
    // pick a muxed format if possible. Piped returns separate audio/video streams.
    // Find a videoStream with itag that is muxed (videoOnly false), else just use the best one.
    let chosen = null;
    if(Array.isArray(data.videoStreams)){
      // Prefer muxed (videoOnly===false)
      const muxed = data.videoStreams.filter(s=>s.videoOnly===false && /mp4|webm/i.test(s.format||''));
      if(muxed.length){
        muxed.sort((a,b)=> (b.bitrate||0)-(a.bitrate||0));
        chosen = muxed[0];
      } else {
        // fallback: any video stream
        const sorted = data.videoStreams.slice().sort((a,b)=> (b.bitrate||0)-(a.bitrate||0));
        chosen = sorted[0];
      }
    }
    if(chosen){
      video.src = '/api/proxy?u='+encodeURIComponent(chosen.url);
      sourceSet = true;
    }
  }
  if(!sourceSet){
    ploading.textContent='再生可能なストリームが見つかりませんでした';
  }

  /* ----------- Title, actions, uploader info ----------- */
  left.appendChild(ce('h1',{}, data.title||''));
  const uploaderName = data.uploader || '';
  const uploaderUrl  = data.uploaderUrl || '';
  const sub = LS.get('subs',[]);
  const isSubbed = sub.some(s=>s.url===uploaderUrl);

  const actions = ce('div',{class:'watch-actions'},
    ce('div',{class:'uploader-box'},
      ce('a',{class:'avatar', href:'#'+uploaderUrl},
        data.uploaderAvatar? ce('img',{src:proxyImg(data.uploaderAvatar)}):null
      ),
      ce('div',{},
        ce('a',{class:'name', href:'#'+uploaderUrl}, uploaderName + (data.uploaderVerified?' ✓':'')),
        ce('div',{class:'subs'}, data.uploaderSubscriberCount!=null? formatViews(data.uploaderSubscriberCount)+' 人の登録者':'')
      ),
      ce('button',{class:'btn '+(isSubbed?'':'red'), style:{marginLeft:'14px'}, onclick:function(){
        const subs = LS.get('subs',[]);
        const idx = subs.findIndex(s=>s.url===uploaderUrl);
        if(idx>=0){ subs.splice(idx,1); this.classList.add('red'); this.textContent='登録'; toast('登録解除しました'); }
        else { subs.unshift({name:uploaderName, url:uploaderUrl, avatar:data.uploaderAvatar}); this.classList.remove('red'); this.textContent='登録済み'; toast('登録しました'); }
        LS.set('subs',subs);
      }}, isSubbed?'登録済み':'登録')
    ),
    ce('div',{class:'action-group'},
      ce('button',{class:'btn', onclick:()=>{
        const liked = LS.get('liked',[]);
        if(!liked.includes(videoId)){ liked.unshift(videoId); LS.set('liked',liked); toast('高評価しました'); }
        else { LS.set('liked', liked.filter(x=>x!==videoId)); toast('高評価を取り消しました'); }
      }}, '👍 '+(data.likes!=null?formatViews(data.likes):'高評価')),
      ce('button',{class:'btn', onclick:()=>{
        navigator.clipboard.writeText(location.origin+'/#/watch?v='+videoId).then(()=>toast('リンクをコピーしました'));
      }}, '🔗 共有'),
      ce('button',{class:'btn', onclick:()=>{
        // open original google video url to allow native download via right click
        const stream = (data.videoStreams||[]).find(s=>!s.videoOnly) || (data.videoStreams||[])[0];
        if(stream){ window.open('/api/proxy?u='+encodeURIComponent(stream.url)+'&dl=1','_blank'); }
        else toast('ダウンロード可能なストリームがありません');
      }}, '⬇️ ダウンロード')
    )
  );
  left.appendChild(actions);

  /* description */
  const stats = (data.views!=null? formatViews(data.views)+' 回視聴 ':'') + (data.uploadDate||'');
  const desc = ce('div',{class:'desc', onclick: function(){ this.classList.toggle('expanded'); }},
    ce('div',{class:'stats-line'}, stats),
    ce('div',{html:(data.description||'').replace(/\\n/g,'<br>')})
  );
  left.appendChild(desc);

  /* save history */
  addHistory({videoId, title:data.title, thumbnail:data.thumbnailUrl, uploader:uploaderName, uploaderUrl, duration:data.duration});

  /* Related videos in right column */
  right.innerHTML='';
  right.appendChild(ce('h3',{style:{margin:'0 0 12px'}},'関連動画'));
  if(Array.isArray(data.relatedStreams) && data.relatedStreams.length){
    for(const r of data.relatedStreams){
      if(r.type && r.type!=='stream') continue;
      right.appendChild(videoCard(r));
    }
  } else {
    right.appendChild(ce('div',{class:'stats'},'関連動画はありません'));
  }

  /* Comments below player */
  const commentsBox = ce('div',{class:'comments', id:'comments'},
    ce('h3',{}, 'コメント')
  );
  left.appendChild(commentsBox);
  loadComments(videoId, commentsBox);
}

async function loadComments(videoId, container){
  try{
    const data = await api('/comments/'+videoId);
    const list = data.comments || [];
    if(!list.length){
      container.appendChild(ce('div',{class:'stats'},'コメントはありません（または無効化されています）'));
      return;
    }
    container.querySelector('h3').textContent = 'コメント ' + (data.commentCount? '('+formatViews(data.commentCount)+')':'');
    for(const c of list){
      container.appendChild(ce('div',{class:'comment'},
        ce('a',{class:'avatar', href:'#'+ (c.commentorUrl||'')},
          c.thumbnail? ce('img',{src:proxyImg(c.thumbnail)}):null
        ),
        ce('div',{class:'body'},
          ce('div',{class:'author'}, (c.author||'')+(c.verified?' ✓':''),
            ce('span',{class:'time'}, c.commentedTime||'')
          ),
          ce('div',{class:'text', html:(c.commentText||'').replace(/\\n/g,'<br>')}),
          ce('div',{class:'meta-row'},
            ce('span',{}, '👍 '+(c.likeCount!=null?formatViews(c.likeCount):'')),
            c.replyCount? ce('span',{}, '💬 '+c.replyCount+' 件の返信') : null,
            c.pinned? ce('span',{},'📌 固定') : null,
            c.hearted? ce('span',{},'❤️') : null
          )
        )
      ));
    }
  }catch(e){
    container.appendChild(ce('div',{class:'stats'},'コメントを読み込めませんでした'));
  }
}

/* ===================== Page: Channel ===================== */
async function pageChannel(rawPath){
  // rawPath like "/channel/UC..."
  const main = $('#main');
  main.innerHTML='';
  showLoading(main);
  try{
    const data = await api(rawPath);
    main.innerHTML='';
    if(data.bannerUrl){
      main.appendChild(ce('div',{class:'ch-banner'}, ce('img',{src:proxyImg(data.bannerUrl)})));
    }
    main.appendChild(ce('div',{class:'ch-head'},
      ce('div',{class:'avatar'}, data.avatarUrl? ce('img',{src:proxyImg(data.avatarUrl)}):null),
      ce('div',{},
        ce('h1',{}, (data.name||'') + (data.verified?' ✓':'')),
        ce('div',{class:'stats'}, (data.subscriberCount!=null? formatViews(data.subscriberCount)+' 人の登録者':'') ),
        data.description? ce('div',{class:'stats', style:{marginTop:'6px',maxWidth:'600px'}}, data.description.slice(0,200)) : null
      ),
      ce('button',{class:'btn red', style:{marginLeft:'auto'}, onclick:function(){
        const subs = LS.get('subs',[]);
        const url = data.id ? '/channel/'+data.id : (data.url||'');
        const idx = subs.findIndex(s=>s.url===url);
        if(idx>=0){ subs.splice(idx,1); this.textContent='登録'; this.classList.add('red'); toast('登録解除'); }
        else { subs.unshift({name:data.name, url, avatar:data.avatarUrl}); this.textContent='登録済み'; this.classList.remove('red'); toast('登録しました'); }
        LS.set('subs',subs);
      }}, '登録')
    ));
    const grid = ce('div',{class:'grid'});
    main.appendChild(grid);
    const items = data.relatedStreams || [];
    for(const v of items) grid.appendChild(videoCard(v));

    if(data.nextpage){
      const channelId = (data.id || rawPath.split('/channel/')[1]);
      let np = data.nextpage;
      const btn = ce('button',{class:'btn', style:{margin:'20px auto',gridColumn:'1/-1'}, onclick: async ()=>{
        btn.disabled=true; btn.textContent='読み込み中...';
        try{
          const more = await api('/nextpage/channel/'+channelId+'?nextpage='+encodeURIComponent(np));
          btn.remove();
          for(const v of (more.relatedStreams||[])) grid.appendChild(videoCard(v));
          np = more.nextpage;
          if(np) grid.appendChild(btn), btn.disabled=false, btn.textContent='もっと見る';
        }catch(e){ btn.disabled=false; btn.textContent='もっと見る'; toast('読み込み失敗'); }
      }}, 'もっと見る');
      grid.appendChild(btn);
    }
  }catch(e){ showError(main,'チャンネル読み込み失敗: '+e.message); }
}

/* ===================== Page: Local (history / subs / liked) ===================== */
function pageHistory(){
  const main = $('#main');
  main.innerHTML='';
  main.appendChild(ce('h1',{style:{margin:'0 0 18px',fontSize:'24px'}},'視聴履歴'));
  const items = LS.get('history',[]);
  if(!items.length){ main.appendChild(ce('div',{class:'center'},'履歴はまだありません')); return; }
  const actions = ce('div',{style:{marginBottom:'14px'}},
    ce('button',{class:'btn', onclick:()=>{ LS.set('history',[]); pageHistory(); toast('履歴をクリアしました'); }}, '🗑 履歴をクリア')
  );
  main.appendChild(actions);
  const grid = ce('div',{class:'grid'});
  for(const v of items) grid.appendChild(videoCard({...v, thumbnail:v.thumbnail, uploaderName:v.uploader, url:'/watch?v='+v.id}));
  main.appendChild(grid);
}

function pageSubs(){
  const main = $('#main');
  main.innerHTML='';
  main.appendChild(ce('h1',{style:{margin:'0 0 18px',fontSize:'24px'}},'登録チャンネル'));
  const subs = LS.get('subs',[]);
  if(!subs.length){ main.appendChild(ce('div',{class:'center'},'まだチャンネル登録がありません')); return; }
  const grid = ce('div',{class:'grid'});
  for(const s of subs){
    grid.appendChild(ce('div',{class:'card', onclick:()=> location.hash='#'+s.url},
      ce('div',{class:'thumb', style:{aspectRatio:'1/1',borderRadius:'50%',maxWidth:'200px',margin:'0 auto',background:'var(--bg-elev)'}},
        s.avatar? ce('img',{src:proxyImg(s.avatar)}) : null
      ),
      ce('div',{class:'meta'},
        ce('div',{class:'info', style:{textAlign:'center',width:'100%'}},
          ce('div',{class:'title'}, s.name),
          ce('button',{class:'btn', style:{marginTop:'8px'}, onclick:function(e){ e.stopPropagation(); const arr=LS.get('subs',[]).filter(x=>x.url!==s.url); LS.set('subs',arr); pageSubs(); }}, '登録解除')
        )
      )
    ));
  }
  main.appendChild(grid);
}

function pageLiked(){
  const main = $('#main');
  main.innerHTML='';
  main.appendChild(ce('h1',{style:{margin:'0 0 18px',fontSize:'24px'}},'高評価した動画'));
  const ids = LS.get('liked',[]);
  if(!ids.length){ main.appendChild(ce('div',{class:'center'},'まだありません')); return; }
  const grid = ce('div',{class:'grid'});
  main.appendChild(grid);
  ids.forEach(async (id)=>{
    try{
      const d = await api('/streams/'+id);
      grid.appendChild(videoCard({videoId:id,title:d.title,thumbnail:d.thumbnailUrl,uploader:d.uploader,uploaderUrl:d.uploaderUrl,duration:d.duration,views:d.views,url:'/watch?v='+id}));
    }catch(e){}
  });
}

/* ===================== Router ===================== */
function router(){
  const hash = location.hash.replace(/^#/,'') || '/';
  // close mobile sidebar
  const aside = $('aside'); if(aside) aside.classList.remove('show');

  if(hash==='/' || hash===''){ pageHome(); setActiveSide('home'); return; }
  if(hash==='/trending'){ pageHome(); setActiveSide('trending'); return; }
  if(hash==='/history'){ pageHistory(); setActiveSide('history'); return; }
  if(hash==='/subs'){ pageSubs(); setActiveSide('subs'); return; }
  if(hash==='/liked'){ pageLiked(); setActiveSide('liked'); return; }
  if(hash.startsWith('/search')){
    const q = new URLSearchParams(hash.split('?')[1]||'').get('q')||'';
    pageSearch(q); setActiveSide(null);
    $('#searchInput').value = q;
    return;
  }
  if(hash.startsWith('/watch')){
    const v = new URLSearchParams(hash.split('?')[1]||'').get('v')||'';
    pageWatch(v); setActiveSide(null); return;
  }
  if(hash.startsWith('/channel/') || hash.startsWith('/c/') || hash.startsWith('/user/')){
    pageChannel(hash); setActiveSide(null); return;
  }
  pageHome();
}
function setActiveSide(key){
  $$('.side-item').forEach(x=>x.classList.toggle('active', x.dataset.key===key));
}

/* ===================== Bootstrap UI ===================== */
function buildSidebar(){
  const aside = $('aside');
  aside.innerHTML='';
  const items = [
    {key:'home', icon:'🏠', label:'ホーム', go:()=> location.hash='#/'},
    {key:'trending', icon:'🔥', label:'急上昇', go:()=> location.hash='#/trending'},
    {key:'subs', icon:'📺', label:'登録チャンネル', go:()=> location.hash='#/subs'}
  ];
  const items2 = [
    {key:'history', icon:'🕘', label:'履歴', go:()=> location.hash='#/history'},
    {key:'liked', icon:'👍', label:'高評価した動画', go:()=> location.hash='#/liked'}
  ];
  const sec1 = ce('div',{class:'side-section'});
  for(const it of items){
    sec1.appendChild(ce('div',{class:'side-item', 'data-key':it.key, onclick:it.go},
      ce('span',{class:'ico'}, it.icon),
      ce('span',{class:'side-label'}, it.label)
    ));
  }
  aside.appendChild(sec1);
  const sec2 = ce('div',{class:'side-section'},
    ce('div',{class:'side-section-title'},'あなた')
  );
  for(const it of items2){
    sec2.appendChild(ce('div',{class:'side-item','data-key':it.key, onclick:it.go},
      ce('span',{class:'ico'}, it.icon),
      ce('span',{class:'side-label'}, it.label)
    ));
  }
  aside.appendChild(sec2);

  // Subscriptions list
  const subs = LS.get('subs',[]);
  if(subs.length){
    const sec3 = ce('div',{class:'side-section'},
      ce('div',{class:'side-section-title'},'登録チャンネル')
    );
    for(const s of subs.slice(0,30)){
      sec3.appendChild(ce('div',{class:'side-item', onclick:()=> location.hash='#'+s.url},
        ce('span',{class:'ico'},
          s.avatar? ce('img',{src:proxyImg(s.avatar), style:'width:24px;height:24px;border-radius:50%'}) : document.createTextNode('👤')
        ),
        ce('span',{class:'side-label'}, s.name)
      ));
    }
    aside.appendChild(sec3);
  }
}

/* ===================== Search suggestions ===================== */
let suggestTimer=null;
async function updateSuggestions(q){
  const box = $('#suggest');
  if(!q){ box.classList.remove('active'); return; }
  try{
    const data = await api('/suggestions?q='+encodeURIComponent(q));
    if(!Array.isArray(data) || !data.length){ box.classList.remove('active'); return; }
    box.innerHTML='';
    data.slice(0,10).forEach(s=>{
      box.appendChild(ce('div',{onclick:()=>{ $('#searchInput').value=s; box.classList.remove('active'); location.hash='#/search?q='+encodeURIComponent(s); }},
        ce('span',{},'🔍'),
        ce('span',{}, s)
      ));
    });
    box.classList.add('active');
  }catch(e){ box.classList.remove('active'); }
}

/* ===================== Init ===================== */
document.addEventListener('DOMContentLoaded', ()=>{
  // theme
  const theme = LS.get('theme','dark');
  if(theme==='light') document.body.classList.add('light');

  buildSidebar();

  // menu toggle
  $('#menuBtn').addEventListener('click', ()=>{
    const aside = $('aside'); const main = $('main');
    if(window.innerWidth<=900){ aside.classList.toggle('show'); }
    else{ aside.classList.toggle('mini'); main.classList.toggle('expanded'); }
  });

  // theme toggle
  $('#themeBtn').addEventListener('click', ()=>{
    document.body.classList.toggle('light');
    LS.set('theme', document.body.classList.contains('light')?'light':'dark');
  });

  // search submission
  $('#searchForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    $('#suggest').classList.remove('active');
    if(q) location.hash = '#/search?q='+encodeURIComponent(q);
  });

  // suggestions
  $('#searchInput').addEventListener('input', (e)=>{
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(()=> updateSuggestions(e.target.value.trim()), 180);
  });
  $('#searchInput').addEventListener('blur', ()=> setTimeout(()=> $('#suggest').classList.remove('active'), 180));
  $('#searchInput').addEventListener('focus', (e)=>{ if(e.target.value.trim()) updateSuggestions(e.target.value.trim()); });

  // logo click
  $('#logo').addEventListener('click', ()=> location.hash='#/');

  window.addEventListener('hashchange', router);
  router();
});

})();
`;

/* ============================================================================
 *  HTML root document — single page, hash-routed.
 * ========================================================================== */
function htmlRoot() {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f0f0f">
<meta name="description" content="GenTube — A privacy-friendly YouTube alternative front-end.">
<title>GenTube — YouTube Alternative</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23ff0000'/%3E%3Cpath d='M13 10l9 6-9 6z' fill='white'/%3E%3C/svg%3E">
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="hdr-left">
    <button class="menu-btn" id="menuBtn" title="メニュー">☰</button>
    <a class="logo" id="logo" title="ホーム"><span class="play"></span><span>GenTube</span></a>
  </div>
  <div class="hdr-center">
    <form class="search-wrap" id="searchForm" autocomplete="off">
      <input id="searchInput" class="search-input" type="text" placeholder="検索" />
      <button class="search-btn" type="submit" title="検索">🔍</button>
      <div class="suggestions" id="suggest"></div>
    </form>
  </div>
  <div class="hdr-right">
    <button class="icon-btn" id="themeBtn" title="テーマ切替">🌓</button>
    <button class="icon-btn" title="GitHub" onclick="window.open('https://github.com/TeamPiped/Piped','_blank')">⚙️</button>
  </div>
</header>
<aside></aside>
<main id="main"></main>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

/* ============================================================================
 *  Stream Proxy
 *  ----------------------------------------------------------------------------
 *  googlevideo.com requires specific headers and rejects cross-origin requests
 *  in the browser, so we tunnel the stream through this server.  Range
 *  requests are forwarded both ways for seekable HTML5 playback.
 *  Also rewrites HLS m3u8 manifests so child segments are also tunneled.
 * ========================================================================== */
async function proxyStream(req, res, targetUrl, opts) {
  opts = opts || {};
  let urlObj;
  try { urlObj = new URL(targetUrl); } catch (e) {
    res.statusCode = 400; res.end('Bad target URL'); return;
  }

  // Only allow proxying googlevideo / ytimg / piped / google related hosts.
  const allowed = /(\.googlevideo\.com|\.ytimg\.com|\.ggpht\.com|yt3\.ggpht\.com|i\.ytimg\.com|googleusercontent\.com|piped|invidious)/i;
  if (!allowed.test(urlObj.hostname)) {
    res.statusCode = 403; res.end('Host not allowed'); return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const lib = urlObj.protocol === 'http:' ? http : https;
  const proxyReq = lib.request({
    method: 'GET',
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
    path: urlObj.pathname + urlObj.search,
    headers
  }, (upstream) => {
    // Follow redirects manually
    if ([301,302,303,307,308].includes(upstream.statusCode) && upstream.headers.location) {
      const next = new URL(upstream.headers.location, targetUrl).toString();
      upstream.resume();
      return proxyStream(req, res, next, opts);
    }

    // CORS / cache headers
    const outHeaders = {};
    const passKeys = ['content-type','content-length','content-range','accept-ranges','cache-control','etag','last-modified'];
    passKeys.forEach(k=>{ if(upstream.headers[k]) outHeaders[k]=upstream.headers[k]; });
    outHeaders['Access-Control-Allow-Origin'] = '*';
    outHeaders['Access-Control-Expose-Headers'] = 'Content-Range,Content-Length,Accept-Ranges';

    if (opts.download) outHeaders['Content-Disposition'] = 'attachment; filename="video.mp4"';

    // Rewrite m3u8 (HLS manifest) so segments are also proxied
    const ctype = (upstream.headers['content-type']||'').toLowerCase();
    const isM3U = ctype.includes('mpegurl') || urlObj.pathname.endsWith('.m3u8');
    if (isM3U) {
      const chunks=[];
      upstream.on('data',c=>chunks.push(c));
      upstream.on('end',()=>{
        let body = Buffer.concat(chunks).toString('utf8');
        const base = urlObj.origin + urlObj.pathname.replace(/[^/]*$/,'');
        body = body.split('\n').map(line=>{
          if(!line || line.startsWith('#')){
            // rewrite URI="..." in EXT-X tags
            return line.replace(/URI="([^"]+)"/g, (m, u)=>{
              const abs = /^https?:/.test(u) ? u : (u.startsWith('/') ? urlObj.origin + u : base + u);
              return 'URI="/api/proxy?u='+encodeURIComponent(abs)+'"';
            });
          }
          const abs = /^https?:/.test(line) ? line : (line.startsWith('/') ? urlObj.origin + line : base + line);
          return '/api/proxy?u=' + encodeURIComponent(abs);
        }).join('\n');
        const buf = Buffer.from(body,'utf8');
        outHeaders['content-length'] = buf.length;
        outHeaders['content-type'] = 'application/vnd.apple.mpegurl';
        res.writeHead(upstream.statusCode, outHeaders);
        res.end(buf);
      });
      upstream.on('error',()=>{ try{res.end();}catch(e){} });
      return;
    }

    res.writeHead(upstream.statusCode, outHeaders);
    upstream.pipe(res);
  });

  proxyReq.on('error', (e) => {
    if(!res.headersSent){ res.statusCode = 502; }
    try { res.end('Upstream error: '+e.message); } catch (err) {}
  });
  proxyReq.setTimeout(25000, ()=> proxyReq.destroy(new Error('Proxy timeout')));
  proxyReq.end();

  req.on('close', ()=>{ try { proxyReq.destroy(); } catch(e){} });
}

/* ============================================================================
 *  Suggestions endpoint — Google's complete-search API (no key needed).
 * ========================================================================== */
async function fetchSuggestions(q) {
  const url = 'https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=' + encodeURIComponent(q) + '&hl=ja';
  try {
    const r = await httpRequest(url, { timeout: 5000 });
    const txt = r.body.toString('utf8');
    // jsonp-like: window.google.ac.h([...])  — extract array
    const m = txt.match(/\[.*\]/s);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || arr.length<2) return [];
    return arr[1].map(x => Array.isArray(x)?x[0]:x).filter(Boolean);
  } catch (e) { return []; }
}

/* ============================================================================
 *  Main HTTP handler
 * ========================================================================== */
async function handler(req, res) {
  // Quick CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  try {
    /* -------- Image proxy (thumbnails, avatars) -------- */
    if (pathname === '/api/img') {
      const u = parsed.searchParams.get('u');
      if (!u) { res.statusCode = 400; return res.end('missing u'); }
      return proxyStream(req, res, u);
    }

    /* -------- Generic stream proxy -------- */
    if (pathname === '/api/proxy') {
      const u = parsed.searchParams.get('u');
      const dl = parsed.searchParams.get('dl') === '1';
      if (!u) { res.statusCode = 400; return res.end('missing u'); }
      return proxyStream(req, res, u, { download: dl });
    }

    /* -------- Google search suggestions -------- */
    if (pathname === '/api/suggestions') {
      const q = parsed.searchParams.get('q') || '';
      const list = await fetchSuggestions(q);
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'public, max-age=300' });
      return res.end(JSON.stringify(list));
    }

    /* -------- Piped-backed JSON API endpoints -------- */
    if (pathname.startsWith('/api/')) {
      const sub = pathname.replace(/^\/api/, '') + (parsed.search || '');
      const data = await pipedFetch(sub);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60'
      });
      return res.end(JSON.stringify(data));
    }

    /* -------- Default: serve SPA root for everything else -------- */
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300'
    });
    return res.end(htmlRoot());

  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: e.message || String(e) }));
  }
}

/* ============================================================================
 *  Local server boot (only when not on Vercel serverless)
 * ========================================================================== */
if (require.main === module) {
  const port = process.env.PORT || 3000;
  http.createServer(handler).listen(port, () => {
    console.log('GenTube running on http://localhost:' + port);
  });
}

module.exports = handler;
