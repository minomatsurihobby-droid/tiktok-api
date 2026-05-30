/**
 * YT-Ultra — Serverless YouTube alternative on Vercel
 * --------------------------------------------------
 * - No API key required. Uses public Invidious instances with automatic failover.
 * - Single-file Express app. HTML/CSS/JS are embedded as template strings.
 * - Provides: search, trending, home, watch (with direct googlevideo stream playback),
 *   channel pages, comments, related videos, suggestions, history & subscriptions
 *   (client-side in localStorage), shorts, music, dark/light theme, responsive UI.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();

/* ------------------------------------------------------------------ *
 * Invidious instance pool (no API key required).
 * ------------------------------------------------------------------ */
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
  'https://invidious.f5.si',
  'https://iv.melmac.space',
  'https://invidious.lunivers.trade',
  'https://invidious.einfachzocken.eu'
];

let healthyInstances = [...INVIDIOUS_INSTANCES];

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        ...(opts.headers || {})
      }
    });
  } finally {
    clearTimeout(t);
  }
}

async function invidiousFetch(path, { timeoutMs = 8000, attempts = 5 } = {}) {
  let lastErr = null;
  const order = [...healthyInstances];
  for (let i = 0; i < Math.min(attempts, order.length); i++) {
    const base = order[i];
    try {
      const r = await fetchWithTimeout(base + path, {}, timeoutMs);
      if (!r.ok) {
        lastErr = new Error(base + ' -> HTTP ' + r.status);
        continue;
      }
      const json = await r.json();
      healthyInstances = [base, ...healthyInstances.filter((x) => x !== base)];
      return { json, instance: base };
    } catch (e) {
      lastErr = e;
      healthyInstances = [...healthyInstances.filter((x) => x !== base), base];
    }
  }
  throw lastErr || new Error('All Invidious instances failed.');
}

const safeId = (s) => /^[\w-]{6,32}$/.test(String(s || ''));
const safeChannelId = (s) => /^[\w-]{6,64}$/.test(String(s || ''));

/* =================== API ROUTES =================== */

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().slice(0, 200);
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const type = (req.query.type || 'all').toString();
  const sort = (req.query.sort || 'relevance').toString();
  if (!q) return res.json([]);
  try {
    const params = new URLSearchParams({
      q, page: String(page), type, sort_by: sort, region: 'JP', hl: 'ja'
    });
    const { json } = await invidiousFetch('/api/v1/search?' + params.toString());
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'search failed', detail: String(e.message || e) });
  }
});

app.get('/api/trending', async (req, res) => {
  const region = (req.query.region || 'JP').toString().slice(0, 2);
  const type = (req.query.type || '').toString();
  try {
    const q = new URLSearchParams({ region, hl: 'ja' });
    if (type) q.set('type', type);
    const { json } = await invidiousFetch('/api/v1/trending?' + q.toString());
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'trending failed' });
  }
});

app.get('/api/popular', async (_req, res) => {
  try {
    const { json } = await invidiousFetch('/api/v1/popular');
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'popular failed' });
  }
});

app.get('/api/video/:id', async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    let result;
    try {
      result = await invidiousFetch('/api/v1/videos/' + id + '?hl=ja&region=JP');
    } catch (e) {
      result = await invidiousFetch('/api/v1/videos/' + id + '?hl=ja&region=JP&local=true');
    }
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({ ...result.json, _instance: result.instance });
  } catch (e) {
    res.status(502).json({ error: 'video failed', detail: String(e.message || e) });
  }
});

app.get('/api/comments/:id', async (req, res) => {
  const id = req.params.id;
  if (!safeId(id)) return res.status(400).json({ error: 'invalid id' });
  const continuation = (req.query.continuation || '').toString();
  try {
    const q = new URLSearchParams({ hl: 'ja' });
    if (continuation) q.set('continuation', continuation);
    const { json } = await invidiousFetch('/api/v1/comments/' + id + '?' + q.toString());
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'comments failed' });
  }
});

app.get('/api/channel/:id', async (req, res) => {
  const id = req.params.id;
  if (!safeChannelId(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const { json } = await invidiousFetch('/api/v1/channels/' + id + '?hl=ja');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'channel failed' });
  }
});

app.get('/api/channel/:id/videos', async (req, res) => {
  const id = req.params.id;
  if (!safeChannelId(id)) return res.status(400).json({ error: 'invalid id' });
  const continuation = (req.query.continuation || '').toString();
  try {
    const q = new URLSearchParams({ hl: 'ja' });
    if (continuation) q.set('continuation', continuation);
    const { json } = await invidiousFetch('/api/v1/channels/' + id + '/videos?' + q.toString());
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'channel videos failed' });
  }
});

app.get('/api/suggest', async (req, res) => {
  const q = (req.query.q || '').toString().slice(0, 100);
  if (!q) return res.json([]);
  try {
    const r = await fetchWithTimeout(
      'https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=ja&q=' +
        encodeURIComponent(q),
      {}, 4000
    );
    const text = await r.text();
    const m = text.match(/\[.*\]/s);
    if (!m) return res.json([]);
    try {
      const data = JSON.parse(m[0]);
      const items = (data[1] || []).map((x) => Array.isArray(x) ? x[0] : String(x));
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(items);
    } catch {
      return res.json([]);
    }
  } catch {
    res.json([]);
  }
});

/* =================== STREAM PROXIES =================== */

app.get('/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('missing url');
  let u;
  try { u = new URL(target); } catch { return res.status(400).send('bad url'); }
  const allowedHost =
    /(^|\.)googlevideo\.com$/.test(u.hostname) ||
    /(^|\.)ytimg\.com$/.test(u.hostname) ||
    /(^|\.)youtube\.com$/.test(u.hostname) ||
    /(^|\.)ggpht\.com$/.test(u.hostname);
  if (!allowedHost) return res.status(400).send('host not allowed');

  const lib = u.protocol === 'http:' ? http : https;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'ja,en;q=0.8',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/'
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = lib.request({
    protocol: u.protocol, hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search, method: 'GET', headers
  }, (upRes) => {
    const passthrough = ['content-type','content-length','content-range','accept-ranges','cache-control','expires','last-modified','etag'];
    const out = {};
    passthrough.forEach((k) => { if (upRes.headers[k]) out[k] = upRes.headers[k]; });
    out['Access-Control-Allow-Origin'] = '*';
    res.writeHead(upRes.statusCode || 200, out);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.status(502).send('proxy error: ' + e.message);
    else res.end();
  });
  req.on('close', () => upstream.destroy());
  upstream.end();
});

app.get('/img', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).end();
  let u;
  try { u = new URL(target); } catch { return res.status(400).end(); }
  const allowed =
    /(^|\.)ytimg\.com$/.test(u.hostname) ||
    /(^|\.)ggpht\.com$/.test(u.hostname) ||
    /(^|\.)youtube\.com$/.test(u.hostname);
  if (!allowed) return res.status(400).end();

  const lib = u.protocol === 'http:' ? http : https;
  lib.get({
    hostname: u.hostname, path: u.pathname + u.search,
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.youtube.com/' }
  }, (up) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (up.headers['content-type']) res.setHeader('content-type', up.headers['content-type']);
    res.writeHead(up.statusCode || 200);
    up.pipe(res);
  }).on('error', () => res.status(502).end());
});

/* =================== SPA SHELL =================== */
const INLINE_CSS = "<style>\n:root{\n  --bg:#0f0f0f; --bg-elev:#181818; --bg-elev-2:#222; --bg-hover:#272727;\n  --text:#f1f1f1; --text-2:#aaa; --text-3:#717171;\n  --accent:#ff0033; --accent-2:#ff4060;\n  --border:#272727; --shadow:0 6px 24px rgba(0,0,0,.45);\n  --radius:12px; --header-h:56px; --sidebar-w:240px; --sidebar-mini-w:72px;\n  --chip-bg:#272727; --chip-bg-active:#f1f1f1; --chip-fg-active:#0f0f0f;\n}\nhtml[data-theme=\"light\"]{\n  --bg:#f9f9f9; --bg-elev:#fff; --bg-elev-2:#f1f1f1; --bg-hover:#e5e5e5;\n  --text:#0f0f0f; --text-2:#606060; --text-3:#909090;\n  --border:#e5e5e5; --shadow:0 6px 18px rgba(0,0,0,.08);\n  --chip-bg:#f1f1f1; --chip-bg-active:#0f0f0f; --chip-fg-active:#fff;\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;padding:0;background:var(--bg);color:var(--text);\n  font-family:\"Roboto\",\"Noto Sans JP\",\"Helvetica Neue\",Arial,sans-serif;\n  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;\n  scroll-behavior:smooth;}\na{color:inherit;text-decoration:none}\nbutton{font:inherit;color:inherit}\nimg{display:block}\n\n/* HEADER */\nheader.top{position:sticky;top:0;z-index:50;background:var(--bg);\n  height:var(--header-h);display:flex;align-items:center;\n  padding:0 16px;gap:8px;border-bottom:1px solid transparent;}\nheader.top .left,header.top .right{display:flex;align-items:center;gap:8px}\nheader.top .center{flex:1;display:flex;justify-content:center;padding:0 20px}\n.icon-btn{width:40px;height:40px;border-radius:50%;background:transparent;\n  border:0;display:inline-flex;align-items:center;justify-content:center;\n  cursor:pointer;transition:background .15s;color:inherit}\n.icon-btn:hover{background:var(--bg-hover)}\n.logo{display:flex;align-items:center;gap:6px;font-weight:700;font-size:20px;letter-spacing:-.5px;padding:0 6px;cursor:pointer}\n.logo .play{width:32px;height:22px;background:var(--accent);border-radius:6px;display:inline-grid;place-items:center}\n.logo .play::after{content:\"\";border-left:10px solid #fff;border-top:6px solid transparent;border-bottom:6px solid transparent;margin-left:2px}\n.search{display:flex;width:100%}\n.search input{flex:1;height:40px;background:var(--bg-elev);border:1px solid var(--border);\n  border-right:0;border-radius:40px 0 0 40px;padding:0 16px;color:inherit;\n  font-size:16px;outline:none}\n.search input:focus{border-color:#1c62b9}\n.search button.go{width:64px;height:40px;background:var(--bg-elev-2);border:1px solid var(--border);\n  border-left:0;border-radius:0 40px 40px 0;cursor:pointer;color:var(--text)}\n.search button.go:hover{background:var(--bg-hover)}\n.search-wrap{position:relative;flex:1;max-width:720px}\n.suggest{position:absolute;top:42px;left:0;right:64px;background:var(--bg-elev);\n  border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);\n  overflow:hidden;display:none;z-index:60}\n.suggest.show{display:block}\n.suggest div{padding:8px 16px;cursor:pointer;display:flex;align-items:center;gap:10px}\n.suggest div:hover,.suggest div.active{background:var(--bg-hover)}\n.suggest svg{opacity:.6;flex-shrink:0}\n\n/* LAYOUT */\n#layout{display:flex;min-height:calc(100vh - var(--header-h))}\nnav.sidebar{width:var(--sidebar-w);flex:0 0 var(--sidebar-w);padding:12px 8px;\n  position:sticky;top:var(--header-h);align-self:flex-start;\n  height:calc(100vh - var(--header-h));overflow-y:auto}\nnav.sidebar::-webkit-scrollbar{width:8px}\nnav.sidebar::-webkit-scrollbar-thumb{background:transparent;border-radius:4px}\nnav.sidebar:hover::-webkit-scrollbar-thumb{background:var(--bg-hover)}\n.sb-section{padding:8px 0;border-bottom:1px solid var(--border)}\n.sb-section:last-child{border-bottom:0}\n.sb-item{display:flex;align-items:center;gap:24px;padding:10px 12px;border-radius:10px;\n  cursor:pointer;font-size:14px;color:var(--text);user-select:none}\n.sb-item:hover{background:var(--bg-hover)}\n.sb-item.active{background:var(--bg-elev-2);font-weight:600}\n.sb-item svg{flex:0 0 24px}\n.sb-title{padding:8px 12px;font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.6px}\nbody.mini nav.sidebar{width:var(--sidebar-mini-w);flex-basis:var(--sidebar-mini-w)}\nbody.mini .sb-item{flex-direction:column;gap:6px;font-size:10px;padding:14px 0;text-align:center}\nbody.mini .sb-title,body.mini .sb-section + .sb-section{display:none}\n\nmain#main{flex:1;padding:24px 24px 64px;min-width:0}\n\n/* CHIP BAR */\n.chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:12px;margin-bottom:12px;\n  position:sticky;top:var(--header-h);background:var(--bg);z-index:5;padding-top:8px}\n.chips::-webkit-scrollbar{display:none}\n.chip{flex:0 0 auto;background:var(--chip-bg);color:var(--text);padding:8px 14px;\n  border-radius:8px;font-size:14px;cursor:pointer;border:0;white-space:nowrap}\n.chip.active{background:var(--chip-bg-active);color:var(--chip-fg-active)}\n\n/* VIDEO GRID */\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px 14px}\n.card{cursor:pointer;display:flex;flex-direction:column;gap:10px}\n.thumb{position:relative;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden}\n.thumb img{width:100%;height:100%;object-fit:cover;transition:transform .25s}\n.card:hover .thumb img{transform:scale(1.02)}\n.duration{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.85);color:#fff;\n  font-size:12px;font-weight:600;padding:2px 6px;border-radius:4px}\n.meta{display:flex;gap:10px}\n.avatar{width:36px;height:36px;border-radius:50%;background:var(--bg-elev-2);flex:0 0 36px;overflow:hidden;cursor:pointer}\n.avatar img{width:100%;height:100%;object-fit:cover}\n.title{font-weight:600;font-size:15px;line-height:1.35;display:-webkit-box;\n  -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.byline{font-size:13px;color:var(--text-2);margin-top:4px}\n.byline .ch{display:block;cursor:pointer}\n.byline .ch:hover{color:var(--text)}\n.byline .stats{display:block;font-size:12px}\n\n/* WATCH */\n.watch{display:grid;grid-template-columns:minmax(0,1fr) 402px;gap:24px;max-width:1700px;margin:0 auto}\n@media (max-width:1100px){.watch{grid-template-columns:1fr}}\n.player-wrap{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden}\n.player-wrap video,.player-wrap iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}\n.video-title{font-size:20px;font-weight:700;margin:16px 0 8px;line-height:1.3}\n.video-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0 18px}\n.channel-bar{display:flex;align-items:center;gap:12px;flex:1;min-width:240px}\n.channel-bar .avatar{width:40px;height:40px;flex:0 0 40px}\n.ch-name{font-weight:600;cursor:pointer}\n.ch-subs{font-size:12px;color:var(--text-2)}\n.btn{background:var(--bg-elev-2);border:0;padding:0 16px;height:36px;border-radius:18px;\n  cursor:pointer;font-weight:600;display:inline-flex;align-items:center;gap:6px;color:inherit}\n.btn:hover{background:var(--bg-hover)}\n.btn.primary{background:var(--text);color:var(--bg)}\n.btn.danger{background:var(--accent);color:#fff}\n.desc{background:var(--bg-elev);border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.5;\n  white-space:pre-wrap;word-break:break-word}\n.desc .stats-line{font-weight:700;margin-bottom:6px}\n.desc .more{margin-top:8px;font-weight:600;color:var(--text-2);cursor:pointer}\n.desc.collapsed .body{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}\n.comments h3{margin:18px 0 12px}\n.comment{display:flex;gap:12px;margin-bottom:18px}\n.comment .avatar{width:40px;height:40px;flex:0 0 40px}\n.comment .who{font-weight:600;font-size:13px}\n.comment .when{color:var(--text-2);font-size:12px;margin-left:6px}\n.comment .body{margin-top:4px;font-size:14px;white-space:pre-wrap;line-height:1.45}\n.comment .likes{color:var(--text-2);font-size:12px;margin-top:6px}\n.related .row{display:flex;gap:8px;margin-bottom:10px;cursor:pointer}\n.related .row .thumb{flex:0 0 168px;aspect-ratio:16/9;border-radius:8px}\n.related .row .info{min-width:0}\n.related .row .t{font-size:14px;font-weight:600;line-height:1.3;\n  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.related .row .b{font-size:12px;color:var(--text-2);margin-top:4px}\n\n/* CHANNEL */\n.channel-banner{height:200px;border-radius:12px;background:#000;overflow:hidden;margin-bottom:16px}\n.channel-banner img{width:100%;height:100%;object-fit:cover}\n.channel-head{display:flex;gap:18px;align-items:center;margin-bottom:24px;flex-wrap:wrap}\n.channel-head .avatar{width:128px;height:128px;flex:0 0 128px}\n.channel-head h1{margin:0 0 6px;font-size:28px}\n\n/* MISC */\n.loading{display:flex;align-items:center;justify-content:center;padding:48px;color:var(--text-2)}\n.spinner{width:24px;height:24px;border:3px solid var(--bg-elev-2);border-top-color:var(--accent);\n  border-radius:50%;animation:spin .8s linear infinite}\n@keyframes spin{to{transform:rotate(360deg)}}\n.empty{padding:48px;text-align:center;color:var(--text-2)}\n#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);\n  background:#111;color:#fff;padding:10px 18px;border-radius:8px;\n  box-shadow:var(--shadow);opacity:0;pointer-events:none;transition:opacity .2s;z-index:200}\n#toast.show{opacity:1}\n.qmenu{position:absolute;right:12px;bottom:60px;background:rgba(20,20,20,.92);\n  color:#fff;padding:6px;border-radius:8px;display:none;z-index:5;min-width:160px}\n.qmenu.show{display:block}\n.qmenu .qi{padding:8px 12px;cursor:pointer;border-radius:6px;font-size:13px}\n.qmenu .qi:hover,.qmenu .qi.active{background:rgba(255,255,255,.15)}\n\n@media(max-width:900px){\n  nav.sidebar{display:none}\n  header.top .center{padding:0 8px}\n}\n@media(max-width:600px){\n  main#main{padding:12px}\n  .video-title{font-size:16px}\n}\n\n.foot{padding:24px;text-align:center;color:var(--text-3);font-size:12px}\n</style>\n";
const INLINE_HEADER = "<header class=\"top\">\n  <div class=\"left\">\n    <button class=\"icon-btn\" id=\"btn-menu\" aria-label=\"メニュー\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z\"/></svg>\n    </button>\n    <div class=\"logo\" onclick=\"route('/')\"><span class=\"play\"></span><span>Ultra</span></div>\n  </div>\n  <div class=\"center\">\n    <div class=\"search-wrap\">\n      <form class=\"search\" id=\"search-form\" role=\"search\">\n        <input id=\"q\" type=\"search\" placeholder=\"検索\" autocomplete=\"off\" />\n        <button class=\"go\" aria-label=\"検索\" type=\"submit\">\n          <svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M15.5 14h-.8l-.27-.27a6.5 6.5 0 1 0-.71.71l.27.28v.79l5 5L20.5 19zM10 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8z\"/></svg>\n        </button>\n      </form>\n      <div class=\"suggest\" id=\"suggest\"></div>\n    </div>\n  </div>\n  <div class=\"right\">\n    <button class=\"icon-btn\" id=\"btn-theme\" title=\"テーマ切替\">\n      <svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z\"/></svg>\n    </button>\n  </div>\n</header>\n";
const INLINE_SIDEBAR = "<nav class=\"sidebar\" id=\"sidebar\">\n  <div class=\"sb-section\">\n    <div class=\"sb-item active\" data-nav=\"home\" onclick=\"route('/')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M12 3l9 8h-3v9h-4v-6H10v6H6v-9H3z\"/></svg>\n      <span>ホーム</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/?chip=__live__')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M10 4v16l8-8z\"/></svg>\n      <span>ショート</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/feed/subscriptions')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M10 16.5l6-4.5-6-4.5zM20 4H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z\"/></svg>\n      <span>登録チャンネル</span>\n    </div>\n  </div>\n  <div class=\"sb-section\">\n    <div class=\"sb-title\">あなた</div>\n    <div class=\"sb-item\" onclick=\"route('/feed/history')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7zm-1 5v5l4 2.6.8-1.3-3.3-2V8z\"/></svg>\n      <span>履歴</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/feed/library')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M4 6h2v14H4zm4 0h2v14H8zm5-2l7 18-1.9.7L12 7.4z\"/></svg>\n      <span>ライブラリ</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/feed/liked')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M2 21h4V9H2zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 0 0-.44-1.06L14.17 1 7.59 7.59A2 2 0 0 0 7 9v10a2 2 0 0 0 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73z\"/></svg>\n      <span>高評価した動画</span>\n    </div>\n  </div>\n  <div class=\"sb-section\">\n    <div class=\"sb-title\">探索</div>\n    <div class=\"sb-item\" onclick=\"route('/trending')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M3.5 18.5l6-6.5 4 4L22 5.7 20.6 4.3 13.5 12l-4-4-7.5 8.1z\"/></svg>\n      <span>急上昇</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/trending?type=music')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M12 3v10.55A4 4 0 1 0 14 17V7h4V3z\"/></svg>\n      <span>音楽</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/trending?type=gaming')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM11 13H8v3H6v-3H3v-2h3V8h2v3h3zm4.5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z\"/></svg>\n      <span>ゲーム</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/trending?type=news')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M20 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM6 7h6v6H6zm12 10H6v-2h12zm0-4h-4v-2h4zm0-4h-4V7h4z\"/></svg>\n      <span>ニュース</span>\n    </div>\n    <div class=\"sb-item\" onclick=\"route('/trending?type=movies')\">\n      <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4z\"/></svg>\n      <span>映画</span>\n    </div>\n  </div>\n  <div class=\"sb-section\">\n    <div class=\"sb-title\">登録チャンネル</div>\n    <div id=\"sb-subs\"></div>\n  </div>\n  <div class=\"foot\">\n    <div>YT Ultra · APIキー不要 · 広告なし</div>\n    <div style=\"margin-top:4px\">Powered by Invidious</div>\n  </div>\n</nav>\n";
const INLINE_JS = "<script>\n'use strict';\n\n/* ---------- Helpers ---------- */\nconst $ = (s, el) => (el||document).querySelector(s);\nconst $$ = (s, el) => Array.from((el||document).querySelectorAll(s));\nconst esc = (s) => String(s==null?'':s)\n  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')\n  .replace(/\"/g,'&quot;').replace(/'/g,'&#39;');\nconst fmt = {\n  views(n){ if(n==null) return ''; n=Number(n); if(!isFinite(n)) return '';\n    if(n>=1e8) return (n/1e8).toFixed(1)+'億 回視聴';\n    if(n>=1e4) return (n/1e4).toFixed(1)+'万 回視聴';\n    return n.toLocaleString('ja-JP')+' 回視聴'; },\n  subs(n){ if(n==null) return ''; n=Number(n); if(!isFinite(n)) return '';\n    if(n>=1e8) return 'チャンネル登録者数 '+(n/1e8).toFixed(1)+'億人';\n    if(n>=1e4) return 'チャンネル登録者数 '+(n/1e4).toFixed(1)+'万人';\n    return 'チャンネル登録者数 '+n.toLocaleString('ja-JP')+'人'; },\n  dur(sec){ sec=Math.max(0, Math.floor(sec||0));\n    const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;\n    return (h?h+':':'')+String(m).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0'); },\n  ago(epochSec){ if(!epochSec) return '';\n    const diff=Math.floor(Date.now()/1000-epochSec);\n    if(diff<60) return diff+'秒前';\n    if(diff<3600) return Math.floor(diff/60)+'分前';\n    if(diff<86400) return Math.floor(diff/3600)+'時間前';\n    if(diff<2592000) return Math.floor(diff/86400)+'日前';\n    if(diff<31536000) return Math.floor(diff/2592000)+'か月前';\n    return Math.floor(diff/31536000)+'年前'; }\n};\nfunction toast(msg, ms){\n  const t=$('#toast'); t.textContent=msg; t.classList.add('show');\n  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'), ms||1800);\n}\nfunction imgProxy(u){ if(!u) return ''; return '/img?url='+encodeURIComponent(u); }\nfunction bestThumb(arr){\n  if(!arr||!arr.length) return '';\n  const sorted = arr.slice().sort((a,b)=>(b.width||0)-(a.width||0));\n  return sorted[0].url||'';\n}\n\n/* ---------- Local storage ---------- */\nconst STORE = {\n  get(k, def){ try{ const v=JSON.parse(localStorage.getItem('ytu:'+k)); return v==null?def:v; }catch{ return def; }},\n  set(k,v){ try{ localStorage.setItem('ytu:'+k, JSON.stringify(v)); }catch{} }\n};\nconst HIST = {\n  add(v){ const a=STORE.get('hist',[]).filter(x=>x.videoId!==v.videoId); a.unshift(v); STORE.set('hist', a.slice(0,500)); },\n  all(){ return STORE.get('hist',[]); },\n  clear(){ STORE.set('hist',[]); }\n};\nconst SUBS = {\n  list(){ return STORE.get('subs',[]); },\n  has(id){ return SUBS.list().some(s=>s.id===id); },\n  toggle(ch){\n    let a=SUBS.list();\n    if(a.some(s=>s.id===ch.id)) a=a.filter(s=>s.id!==ch.id);\n    else a.unshift({id:ch.id,name:ch.name,thumb:ch.thumb});\n    STORE.set('subs', a.slice(0,200)); renderSidebarSubs(); return SUBS.has(ch.id);\n  }\n};\nconst LIKES = {\n  list(){ return STORE.get('liked',[]); },\n  has(id){ return LIKES.list().some(s=>s.videoId===id); },\n  toggle(v){\n    let a=LIKES.list();\n    if(a.some(s=>s.videoId===v.videoId)) a=a.filter(s=>s.videoId!==v.videoId);\n    else a.unshift(v);\n    STORE.set('liked', a.slice(0,500)); return LIKES.has(v.videoId);\n  }\n};\n\n/* ---------- Theme ---------- */\nfunction applyTheme(){\n  document.documentElement.setAttribute('data-theme', STORE.get('theme','dark'));\n}\napplyTheme();\n$('#btn-theme').addEventListener('click', ()=>{\n  STORE.set('theme', STORE.get('theme','dark')==='dark'?'light':'dark');\n  applyTheme();\n});\n$('#btn-menu').addEventListener('click', ()=> document.body.classList.toggle('mini'));\n\n/* ---------- Sidebar subs ---------- */\nfunction renderSidebarSubs(){\n  const host = $('#sb-subs'); if(!host) return;\n  const subs = SUBS.list();\n  if(!subs.length){ host.innerHTML='<div style=\"padding:8px 12px;font-size:12px;color:var(--text-2)\">未登録</div>'; return; }\n  host.innerHTML = subs.slice(0,15).map(s=>\n    '<div class=\"sb-item\" onclick=\"route(\\\\'/channel/'+esc(s.id)+'\\\\')\">'+\n      '<div class=\"avatar\" style=\"width:24px;height:24px;flex:0 0 24px\">'+\n        (s.thumb?'<img src=\"'+imgProxy(s.thumb)+'\" alt=\"\">':'')+\n      '</div>'+\n      '<span style=\"font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">'+esc(s.name)+'</span>'+\n    '</div>'\n  ).join('');\n}\nrenderSidebarSubs();\n\n/* ---------- Router ---------- */\nfunction route(href){\n  if(typeof href==='string'){ history.pushState({}, '', href); }\n  render();\n}\nwindow.route = route;\nwindow.addEventListener('popstate', render);\ndocument.addEventListener('click', (e)=>{\n  const a = e.target.closest('a[data-link]');\n  if(a){ e.preventDefault(); route(a.getAttribute('href')); }\n});\n\nasync function render(){\n  const url = new URL(location.href);\n  const path = url.pathname;\n  const main = $('#main'); main.scrollTop=0; window.scrollTo(0,0);\n  main.innerHTML = '<div class=\"loading\"><div class=\"spinner\"></div></div>';\n  setActiveSidebar(path);\n  try{\n    if(path==='/' || path==='') await renderHome(url);\n    else if(path==='/watch') await renderWatch(url.searchParams.get('v'));\n    else if(path==='/results') await renderResults(url.searchParams.get('search_query')||'', url);\n    else if(path==='/trending') await renderTrending(url);\n    else if(path.indexOf('/channel/')===0) await renderChannel(path.split('/')[2]);\n    else if(path==='/feed/history') renderLocalList('履歴', HIST.all(), true);\n    else if(path==='/feed/liked') renderLocalList('高評価した動画', LIKES.list(), false);\n    else if(path==='/feed/library') renderLibrary();\n    else if(path==='/feed/subscriptions') await renderSubscriptions();\n    else await renderHome(url);\n  }catch(err){\n    main.innerHTML = '<div class=\"empty\">読み込みに失敗しました。<br><small>'+esc(err.message||err)+'</small><br><br><button class=\"btn\" onclick=\"render()\">再試行</button></div>';\n  }\n}\nwindow.render = render;\nfunction setActiveSidebar(path){\n  $$('.sb-item').forEach(el=>el.classList.remove('active'));\n  const map = {'/':'ホーム','/trending':'急上昇','/feed/subscriptions':'登録チャンネル',\n    '/feed/history':'履歴','/feed/library':'ライブラリ','/feed/liked':'高評価した動画'};\n  const label = map[path];\n  if(label){\n    const node = $$('.sb-item').find(el=>el.textContent.trim()===label);\n    if(node) node.classList.add('active');\n  }\n}\n\n/* ---------- Video card ---------- */\nfunction videoCard(v){\n  const id = v.videoId || v.id || '';\n  const t  = v.title || '';\n  const dur = v.lengthSeconds || v.duration || 0;\n  const thumb = bestThumb(v.videoThumbnails) ||\n    (id ? 'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg' : '');\n  const ch = v.author || v.channelTitle || '';\n  const chId = v.authorId || v.channelId || '';\n  const views = v.viewCount!=null ? fmt.views(v.viewCount) : (v.viewCountText||'');\n  const pub = v.publishedText || (v.published ? fmt.ago(v.published) : '');\n  const chThumb = bestThumb(v.authorThumbnails) || '';\n  return ''+\n    '<div class=\"card\" onclick=\"route(\\\\'/watch?v='+esc(id)+'\\\\')\">'+\n      '<div class=\"thumb\">'+\n        '<img loading=\"lazy\" src=\"'+imgProxy(thumb)+'\" alt=\"\">'+\n        (dur ? '<div class=\"duration\">'+fmt.dur(dur)+'</div>' : '')+\n      '</div>'+\n      '<div class=\"meta\">'+\n        '<div class=\"avatar\" onclick=\"event.stopPropagation();route(\\\\'/channel/'+esc(chId)+'\\\\')\">'+\n          (chThumb?'<img src=\"'+imgProxy(chThumb)+'\" alt=\"\">':'')+\n        '</div>'+\n        '<div style=\"min-width:0;flex:1\">'+\n          '<div class=\"title\">'+esc(t)+'</div>'+\n          '<div class=\"byline\">'+\n            '<span class=\"ch\" onclick=\"event.stopPropagation();route(\\\\'/channel/'+esc(chId)+'\\\\')\">'+esc(ch)+'</span>'+\n            '<span class=\"stats\">'+esc(views)+(views&&pub?' · ':'')+esc(pub)+'</span>'+\n          '</div>'+\n        '</div>'+\n      '</div>'+\n    '</div>';\n}\nfunction gridHTML(list){\n  if(!list || !list.length) return '<div class=\"empty\">動画がありません</div>';\n  const html = list.filter(v=>v.type==='video'||v.videoId).map(videoCard).join('');\n  return html ? '<div class=\"grid\">'+html+'</div>' : '<div class=\"empty\">動画がありません</div>';\n}\n\n/* ---------- API ---------- */\nasync function api(path){\n  const r = await fetch(path);\n  if(!r.ok) throw new Error('API '+r.status);\n  return r.json();\n}\n\n/* ---------- Home ---------- */\nconst CHIPS = [\n  {label:'すべて', value:''},\n  {label:'音楽', value:'music'},\n  {label:'ゲーム', value:'gaming'},\n  {label:'ニュース', value:'news'},\n  {label:'映画', value:'movies'},\n  {label:'急上昇', value:'__trending__'},\n  {label:'ライブ', value:'__live__'}\n];\nasync function renderHome(url){\n  const main=$('#main');\n  const chip = url.searchParams.get('chip')||'';\n  main.innerHTML = chipsHTML(chip) + '<div id=\"home-grid\"><div class=\"loading\"><div class=\"spinner\"></div></div></div>';\n  bindChips();\n  let list = [];\n  try{\n    if(chip==='__trending__') list = await api('/api/trending?region=JP');\n    else if(chip==='__live__') list = await api('/api/search?q='+encodeURIComponent('ライブ 配信')+'&type=video&sort=upload_date');\n    else if(chip==='music' || chip==='gaming' || chip==='news' || chip==='movies')\n      list = await api('/api/trending?region=JP&type='+chip);\n    else list = await api('/api/popular');\n    if(!Array.isArray(list)||!list.length){\n      list = await api('/api/trending?region=JP');\n    }\n  }catch(e){\n    try{ list = await api('/api/trending?region=JP'); }catch{ list=[]; }\n  }\n  $('#home-grid').innerHTML = gridHTML(list);\n}\nfunction chipsHTML(active){\n  return '<div class=\"chips\">'+ CHIPS.map(c=>\n    '<button class=\"chip '+(c.value===active?'active':'')+'\" data-chip=\"'+esc(c.value)+'\">'+esc(c.label)+'</button>'\n  ).join('') +'</div>';\n}\nfunction bindChips(){\n  $$('.chip[data-chip]').forEach(b=>b.addEventListener('click', ()=>{\n    const v = b.dataset.chip;\n    const u = new URL(location.href);\n    if(v) u.searchParams.set('chip', v); else u.searchParams.delete('chip');\n    route(u.pathname + (u.search?u.search:''));\n  }));\n}\n\n/* ---------- Search ---------- */\nasync function renderResults(q, url){\n  const main=$('#main');\n  const sort = url.searchParams.get('sort')||'relevance';\n  const type = url.searchParams.get('type')||'all';\n  const sortLabels = {relevance:'関連性',upload_date:'アップロード日',view_count:'視聴回数',rating:'評価'};\n  const typeLabels = {all:'すべて',video:'動画',channel:'チャンネル',playlist:'再生リスト'};\n  main.innerHTML =\n    '<div class=\"chips\">'+\n      ['relevance','upload_date','view_count','rating'].map(s=>\n        '<button class=\"chip '+(s===sort?'active':'')+'\" data-sort=\"'+s+'\">'+sortLabels[s]+'</button>'\n      ).join('')+\n      '<span style=\"width:1px;background:var(--border);margin:0 6px\"></span>'+\n      ['all','video','channel','playlist'].map(t=>\n        '<button class=\"chip '+(t===type?'active':'')+'\" data-type=\"'+t+'\">'+typeLabels[t]+'</button>'\n      ).join('')+\n    '</div>'+\n    '<h2 style=\"margin:8px 0 16px;font-size:18px\">「'+esc(q)+'」の検索結果</h2>'+\n    '<div id=\"result-grid\"><div class=\"loading\"><div class=\"spinner\"></div></div></div>';\n  $$('.chip[data-sort]').forEach(b=>b.addEventListener('click',()=>{\n    const u=new URL(location.href); u.searchParams.set('sort',b.dataset.sort); route(u.pathname+u.search);\n  }));\n  $$('.chip[data-type]').forEach(b=>b.addEventListener('click',()=>{\n    const u=new URL(location.href); u.searchParams.set('type',b.dataset.type); route(u.pathname+u.search);\n  }));\n  const list = await api('/api/search?'+new URLSearchParams({q:q,sort:sort,type:type}));\n  const items = (list||[]).map(x=> x.type==='channel' ? channelCard(x) : videoCard(x)).join('');\n  $('#result-grid').innerHTML = items ? '<div class=\"grid\">'+items+'</div>' : '<div class=\"empty\">結果が見つかりませんでした</div>';\n}\nfunction channelCard(c){\n  const thumb = bestThumb(c.authorThumbnails);\n  return '<div class=\"card\" onclick=\"route(\\\\'/channel/'+esc(c.authorId)+'\\\\')\">'+\n    '<div class=\"thumb\" style=\"border-radius:50%;width:160px;height:160px;margin:0 auto;aspect-ratio:1/1\">'+\n      (thumb?'<img src=\"'+imgProxy(thumb)+'\" alt=\"\">':'')+\n    '</div>'+\n    '<div class=\"meta\" style=\"justify-content:center\"><div style=\"text-align:center\">'+\n      '<div class=\"title\">'+esc(c.author||'')+'</div>'+\n      '<div class=\"byline\"><span class=\"stats\">'+fmt.subs(c.subCount)+'</span></div>'+\n    '</div></div>'+\n  '</div>';\n}\n\n/* ---------- Trending ---------- */\nasync function renderTrending(url){\n  const type = url.searchParams.get('type')||'';\n  const main=$('#main');\n  const labels = {'':'すべて',music:'音楽',gaming:'ゲーム',news:'ニュース',movies:'映画'};\n  main.innerHTML = '<h2 style=\"margin:0 0 16px\">急上昇'+(type?' · '+labels[type]:'')+'</h2>'+\n    '<div class=\"chips\">'+\n      ['','music','gaming','news','movies'].map(t=>\n        '<button class=\"chip '+(t===type?'active':'')+'\" data-t=\"'+t+'\">'+labels[t]+'</button>'\n      ).join('')+\n    '</div>'+\n    '<div id=\"t-grid\"><div class=\"loading\"><div class=\"spinner\"></div></div></div>';\n  $$('.chip[data-t]').forEach(b=>b.addEventListener('click',()=>{\n    const u=new URL(location.href);\n    if(b.dataset.t) u.searchParams.set('type',b.dataset.t); else u.searchParams.delete('type');\n    route(u.pathname+u.search);\n  }));\n  const list = await api('/api/trending?region=JP'+(type?'&type='+type:''));\n  $('#t-grid').innerHTML = gridHTML(list);\n}\n\n/* ---------- Watch ---------- */\nlet _currentVideo = null;\nasync function renderWatch(id){\n  if(!id){ $('#main').innerHTML='<div class=\"empty\">動画 ID がありません</div>'; return; }\n  const main=$('#main');\n  main.innerHTML =\n    '<div class=\"watch\">'+\n      '<div class=\"left-col\">'+\n        '<div class=\"player-wrap\" id=\"player-wrap\"><div class=\"loading\"><div class=\"spinner\"></div></div></div>'+\n        '<h1 class=\"video-title\" id=\"v-title\">読み込み中…</h1>'+\n        '<div class=\"video-actions\" id=\"v-actions\"></div>'+\n        '<div class=\"desc collapsed\" id=\"v-desc\"></div>'+\n        '<div class=\"comments\" id=\"v-comments\"></div>'+\n      '</div>'+\n      '<aside class=\"related\" id=\"v-related\"><div class=\"loading\"><div class=\"spinner\"></div></div></aside>'+\n    '</div>';\n\n  let v;\n  try{\n    v = await api('/api/video/'+encodeURIComponent(id));\n  }catch(e){\n    main.innerHTML = '<div class=\"empty\">動画を取得できませんでした<br><small>'+esc(e.message)+'</small><br><br>'+\n      '<button class=\"btn\" onclick=\"render()\">再試行</button> '+\n      '<button class=\"btn\" onclick=\"useFallbackEmbed(\\\\''+esc(id)+'\\\\')\">YouTube 公式埋め込みで再生</button></div>';\n    return;\n  }\n  _currentVideo = v;\n\n  HIST.add({videoId:id, title:v.title, author:v.author, authorId:v.authorId,\n    authorThumbnails:v.authorThumbnails, videoThumbnails:v.videoThumbnails,\n    lengthSeconds:v.lengthSeconds, viewCount:v.viewCount, published:v.published});\n\n  $('#v-title').textContent = v.title || '';\n  mountPlayer(v);\n\n  const liked = LIKES.has(id);\n  const subbed = SUBS.has(v.authorId);\n  $('#v-actions').innerHTML =\n    '<div class=\"channel-bar\">'+\n      '<div class=\"avatar\" onclick=\"route(\\\\'/channel/'+esc(v.authorId)+'\\\\')\">'+\n        (bestThumb(v.authorThumbnails)?'<img src=\"'+imgProxy(bestThumb(v.authorThumbnails))+'\" alt=\"\">':'')+\n      '</div>'+\n      '<div>'+\n        '<div class=\"ch-name\" onclick=\"route(\\\\'/channel/'+esc(v.authorId)+'\\\\')\">'+esc(v.author||'')+'</div>'+\n        '<div class=\"ch-subs\">'+esc(fmt.subs(v.subCount)||v.subCountText||'')+'</div>'+\n      '</div>'+\n      '<button class=\"btn '+(subbed?'':'danger')+'\" id=\"btn-sub\">'+(subbed?'登録済み':'チャンネル登録')+'</button>'+\n    '</div>'+\n    '<button class=\"btn\" id=\"btn-like\">'+(liked?'★ 高評価済み':'☆ 高評価')+'</button>'+\n    '<button class=\"btn\" id=\"btn-share\">共有</button>'+\n    '<button class=\"btn\" id=\"btn-download\">ダウンロード</button>'+\n    '<button class=\"btn\" id=\"btn-yt\">YouTube で開く</button>';\n  $('#btn-sub').addEventListener('click', ()=>{\n    const now = SUBS.toggle({id:v.authorId,name:v.author,thumb:bestThumb(v.authorThumbnails)});\n    toast(now?'チャンネル登録しました':'登録を解除しました'); renderWatch(id);\n  });\n  $('#btn-like').addEventListener('click', ()=>{\n    const cur = {videoId:id, title:v.title, author:v.author, authorId:v.authorId,\n      videoThumbnails:v.videoThumbnails, authorThumbnails:v.authorThumbnails,\n      lengthSeconds:v.lengthSeconds, viewCount:v.viewCount, published:v.published};\n    const now = LIKES.toggle(cur); toast(now?'高評価しました':'高評価を解除しました');\n    $('#btn-like').textContent = now?'★ 高評価済み':'☆ 高評価';\n  });\n  $('#btn-share').addEventListener('click', async ()=>{\n    const link = location.origin + '/watch?v=' + id;\n    try{ await navigator.clipboard.writeText(link); toast('リンクをコピーしました'); }\n    catch{ prompt('リンクをコピーしてください', link); }\n  });\n  $('#btn-download').addEventListener('click', ()=> openDownloadMenu(v));\n  $('#btn-yt').addEventListener('click', ()=> window.open('https://www.youtube.com/watch?v='+id,'_blank'));\n\n  const desc = $('#v-desc');\n  const viewsStr = fmt.views(v.viewCount);\n  const pubStr = v.publishedText || (v.published?fmt.ago(v.published):'');\n  desc.innerHTML =\n    '<div class=\"stats-line\">'+esc(viewsStr)+(viewsStr&&pubStr?' · ':'')+esc(pubStr)+'</div>'+\n    '<div class=\"body\">'+linkify(v.descriptionHtml || esc(v.description||''))+'</div>'+\n    '<div class=\"more\" id=\"desc-more\">…もっと表示</div>';\n  $('#desc-more').addEventListener('click', ()=>{\n    desc.classList.toggle('collapsed');\n    $('#desc-more').textContent = desc.classList.contains('collapsed') ? '…もっと表示':'閉じる';\n  });\n\n  $('#v-related').innerHTML = (v.recommendedVideos||[]).map(r=>\n    '<div class=\"row\" onclick=\"route(\\\\'/watch?v='+esc(r.videoId)+'\\\\')\">'+\n      '<div class=\"thumb\"><img src=\"'+imgProxy(bestThumb(r.videoThumbnails))+'\" alt=\"\">'+\n        (r.lengthSeconds?'<div class=\"duration\">'+fmt.dur(r.lengthSeconds)+'</div>':'')+\n      '</div>'+\n      '<div class=\"info\">'+\n        '<div class=\"t\">'+esc(r.title||'')+'</div>'+\n        '<div class=\"b\">'+esc(r.author||'')+'</div>'+\n        '<div class=\"b\">'+(r.viewCountText?esc(r.viewCountText):(r.viewCount?fmt.views(r.viewCount):''))+'</div>'+\n      '</div>'+\n    '</div>'\n  ).join('') || '<div class=\"empty\">関連動画なし</div>';\n\n  loadComments(id);\n}\nfunction linkify(s){\n  return String(s||'').replace(/(https?:\\\\/\\\\/[^\\\\s<]+)/g, '<a href=\"$1\" target=\"_blank\" rel=\"noopener\" style=\"color:#3ea6ff\">$1</a>');\n}\nasync function loadComments(id){\n  const host = $('#v-comments');\n  host.innerHTML = '<h3>コメント</h3><div class=\"loading\"><div class=\"spinner\"></div></div>';\n  try{\n    const data = await api('/api/comments/'+encodeURIComponent(id));\n    const list = data.comments || [];\n    if(!list.length){ host.innerHTML = '<h3>コメント</h3><div class=\"empty\">コメントはありません</div>'; return; }\n    host.innerHTML = '<h3>コメント '+(data.commentCount?'('+data.commentCount.toLocaleString()+')':'')+'</h3>'+\n      list.map(c=>\n        '<div class=\"comment\">'+\n          '<div class=\"avatar\">'+(bestThumb(c.authorThumbnails)?'<img src=\"'+imgProxy(bestThumb(c.authorThumbnails))+'\">':'')+'</div>'+\n          '<div style=\"min-width:0;flex:1\">'+\n            '<div><span class=\"who\">'+esc(c.author||'')+'</span><span class=\"when\">'+esc(c.publishedText||'')+'</span></div>'+\n            '<div class=\"body\">'+linkify(esc(c.content||''))+'</div>'+\n            '<div class=\"likes\">👍 '+(c.likeCount||0).toLocaleString()+(c.replies&&c.replies.replyCount?' · 返信 '+c.replies.replyCount:'')+'</div>'+\n          '</div>'+\n        '</div>'\n      ).join('');\n  }catch{\n    host.innerHTML = '<h3>コメント</h3><div class=\"empty\">コメントを取得できません</div>';\n  }\n}\n\n/* ---------- Player ---------- */\nfunction mountPlayer(v){\n  const host = $('#player-wrap');\n  const id = v.videoId;\n  host.innerHTML = '';\n\n  const fmts = (v.formatStreams||[]).filter(f=>f.url && (f.container==='mp4'||!f.container))\n    .map(f=>{\n      const h = parseInt((f.qualityLabel||'').replace(/\\\\D/g,''),10)\n        || parseInt(f.resolution||'0',10) || 0;\n      return Object.assign({}, f, {h:h});\n    })\n    .sort((a,b)=>b.h-a.h);\n\n  let chosen = fmts[0];\n\n  if(!chosen && v.hlsUrl){ return mountHLS(host, v); }\n  if(!chosen){ return mountEmbed(host, id); }\n\n  const vid = document.createElement('video');\n  vid.controls = true;\n  vid.playsInline = true;\n  vid.autoplay = true;\n  vid.preload = 'auto';\n  vid.poster = imgProxy(bestThumb(v.videoThumbnails));\n  vid.src = '/proxy?url=' + encodeURIComponent(chosen.url);\n  vid.style.background = '#000';\n  let failCount = 0;\n  vid.addEventListener('error', ()=>{\n    failCount++;\n    const idx = fmts.indexOf(chosen);\n    if(idx+1 < fmts.length && failCount<fmts.length){\n      chosen = fmts[idx+1];\n      vid.src = '/proxy?url=' + encodeURIComponent(chosen.url);\n      vid.play().catch(()=>{});\n    } else if (v.hlsUrl) {\n      mountHLS(host, v);\n    } else {\n      mountEmbed(host, id);\n    }\n  });\n  host.appendChild(vid);\n\n  const qbtn = document.createElement('button');\n  qbtn.className='btn';\n  qbtn.style.cssText='position:absolute;right:12px;top:12px;z-index:4;opacity:.85';\n  qbtn.textContent = (chosen.qualityLabel||(chosen.h+'p'))+' ▾';\n  host.appendChild(qbtn);\n\n  const menu = document.createElement('div');\n  menu.className='qmenu';\n  menu.innerHTML = fmts.map((f,i)=>'<div class=\"qi '+(f===chosen?'active':'')+'\" data-i=\"'+i+'\">'+esc(f.qualityLabel||f.h+'p')+' · '+esc(f.container||'mp4')+'</div>').join('');\n  host.appendChild(menu);\n  qbtn.addEventListener('click', e=>{ e.stopPropagation(); menu.classList.toggle('show'); });\n  document.addEventListener('click', ()=>menu.classList.remove('show'));\n  menu.addEventListener('click', e=>{\n    const tgt = e.target.closest('.qi'); if(!tgt) return;\n    const f = fmts[parseInt(tgt.dataset.i,10)];\n    if(!f) return;\n    const t = vid.currentTime;\n    chosen = f;\n    vid.src = '/proxy?url='+encodeURIComponent(f.url);\n    vid.currentTime = t; vid.play().catch(()=>{});\n    qbtn.textContent = (f.qualityLabel||(f.h+'p'))+' ▾';\n    $$('.qi',menu).forEach(x=>x.classList.toggle('active', x===tgt));\n    menu.classList.remove('show');\n  });\n}\nfunction mountHLS(host, v){\n  const vid = document.createElement('video');\n  vid.controls = true; vid.playsInline=true; vid.autoplay=true;\n  vid.poster = imgProxy(bestThumb(v.videoThumbnails));\n  if(vid.canPlayType('application/vnd.apple.mpegurl')){\n    vid.src = v.hlsUrl;\n    host.appendChild(vid);\n  } else {\n    loadHlsJs().then(Hls=>{\n      if(Hls.isSupported()){\n        host.appendChild(vid);\n        const hls = new Hls();\n        hls.loadSource(v.hlsUrl);\n        hls.attachMedia(vid);\n      } else { mountEmbed(host, v.videoId); }\n    }).catch(()=>mountEmbed(host, v.videoId));\n  }\n}\nfunction loadHlsJs(){\n  return new Promise((res, rej)=>{\n    if(window.Hls) return res(window.Hls);\n    const s=document.createElement('script');\n    s.src='https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';\n    s.onload=()=>res(window.Hls); s.onerror=rej;\n    document.head.appendChild(s);\n  });\n}\nfunction mountEmbed(host, id){\n  host.innerHTML = '';\n  const ifr = document.createElement('iframe');\n  ifr.src = 'https://www.youtube-nocookie.com/embed/'+encodeURIComponent(id)+'?autoplay=1&rel=0&modestbranding=1';\n  ifr.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope';\n  ifr.allowFullscreen = true;\n  host.appendChild(ifr);\n}\nfunction useFallbackEmbed(id){\n  $('#main').innerHTML = '<div class=\"watch\"><div>'+\n    '<div class=\"player-wrap\" id=\"player-wrap\"></div>'+\n    '<h1 class=\"video-title\">YouTube 公式埋め込みで再生中</h1>'+\n  '</div><aside></aside></div>';\n  mountEmbed($('#player-wrap'), id);\n}\nwindow.useFallbackEmbed = useFallbackEmbed;\n\nfunction openDownloadMenu(v){\n  const fmts = (v.formatStreams||[]).filter(f=>f.url);\n  const adp  = (v.adaptiveFormats||[]).filter(f=>f.url);\n  const all = fmts.map(f=>Object.assign({},f,{kind:'progressive'}))\n              .concat(adp.map(f=>Object.assign({},f,{kind:'adaptive'})));\n  if(!all.length){ toast('ダウンロード可能な形式が見つかりません'); return; }\n  const safeTitle = (v.title||'video').replace(/[\\\\/\\\\\\\\:*?\"<>|]/g,'_');\n  const html = '<div style=\"padding:18px\">'+\n    '<h3 style=\"margin:0 0 12px\">ダウンロード</h3>'+\n    '<div style=\"max-height:60vh;overflow:auto;display:grid;gap:6px\">'+\n    all.map(f=>\n      '<a class=\"btn\" style=\"justify-content:flex-start\" target=\"_blank\" rel=\"noopener\" '+\n         'href=\"/proxy?url='+encodeURIComponent(f.url)+'\" '+\n         'download=\"'+esc(safeTitle)+'-'+esc(f.qualityLabel||f.resolution||f.bitrate||'')+'.'+esc(f.container||'mp4')+'\">'+\n        esc(f.qualityLabel||f.resolution||(f.audioQuality?'音声 '+f.audioQuality:'')||'')+\n        ' · '+esc(f.container||'')+' · '+esc(f.kind)+\n        (f.fps?' · '+f.fps+'fps':'')+\n        (f.bitrate?' · '+Math.round(f.bitrate/1000)+'kbps':'')+\n      '</a>'\n    ).join('')+\n    '</div></div>';\n  modal(html);\n}\nfunction modal(html){\n  let bg = $('#modal-bg');\n  if(!bg){\n    bg = document.createElement('div'); bg.id='modal-bg';\n    bg.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:flex;align-items:center;justify-content:center';\n    document.body.appendChild(bg);\n    bg.addEventListener('click', e=>{ if(e.target===bg) bg.remove(); });\n  }\n  bg.innerHTML = '<div style=\"background:var(--bg-elev);border-radius:14px;max-width:560px;width:92vw;max-height:86vh;overflow:auto;box-shadow:var(--shadow);color:var(--text)\">'+html+'</div>';\n}\n\n/* ---------- Channel ---------- */\nasync function renderChannel(id){\n  if(!id){ $('#main').innerHTML='<div class=\"empty\">チャンネルIDがありません</div>'; return; }\n  const main=$('#main');\n  const c = await api('/api/channel/'+encodeURIComponent(id));\n  const banner = bestThumb(c.authorBanners);\n  const avatar = bestThumb(c.authorThumbnails);\n  const subbed = SUBS.has(c.authorId);\n  main.innerHTML =\n    (banner?'<div class=\"channel-banner\"><img src=\"'+imgProxy(banner)+'\" alt=\"\"></div>':'')+\n    '<div class=\"channel-head\">'+\n      '<div class=\"avatar\">'+(avatar?'<img src=\"'+imgProxy(avatar)+'\" alt=\"\">':'')+'</div>'+\n      '<div style=\"min-width:0;flex:1\">'+\n        '<h1>'+esc(c.author||'')+'</h1>'+\n        '<div class=\"ch-subs\">'+esc(fmt.subs(c.subCount)||c.subscriberCountText||'')+'</div>'+\n        '<div style=\"margin-top:6px;color:var(--text-2);max-width:680px;white-space:pre-wrap\">'+esc((c.description||'').slice(0,300))+'</div>'+\n      '</div>'+\n      '<button class=\"btn '+(subbed?'':'danger')+'\" id=\"ch-sub\">'+(subbed?'登録済み':'チャンネル登録')+'</button>'+\n    '</div>'+\n    '<div id=\"ch-videos\"><div class=\"loading\"><div class=\"spinner\"></div></div></div>';\n  $('#ch-sub').addEventListener('click', ()=>{\n    const now = SUBS.toggle({id:c.authorId,name:c.author,thumb:avatar});\n    toast(now?'登録しました':'解除しました'); renderChannel(id);\n  });\n  try{\n    const list = await api('/api/channel/'+encodeURIComponent(id)+'/videos');\n    const videos = list.videos||list||[];\n    $('#ch-videos').innerHTML = gridHTML(videos);\n  }catch{ $('#ch-videos').innerHTML='<div class=\"empty\">動画を取得できませんでした</div>'; }\n}\n\n/* ---------- Local lists ---------- */\nfunction renderLocalList(title, list, withClear){\n  const main=$('#main');\n  main.innerHTML = '<div style=\"display:flex;align-items:center;gap:12px;margin-bottom:16px\">'+\n    '<h1 style=\"margin:0\">'+esc(title)+'</h1>'+\n    (withClear?'<button class=\"btn\" id=\"btn-clear\">すべて削除</button>':'')+\n  '</div><div id=\"ll-grid\">'+gridHTML(list)+'</div>';\n  if(withClear) $('#btn-clear').addEventListener('click', ()=>{\n    if(confirm(title+'をすべて削除しますか？')){ HIST.clear(); renderLocalList(title, [], withClear); }\n  });\n}\nfunction renderLibrary(){\n  const main=$('#main');\n  const hist = HIST.all().slice(0,12);\n  const liked = LIKES.list().slice(0,12);\n  main.innerHTML =\n    '<h1 style=\"margin:0 0 16px\">ライブラリ</h1>'+\n    '<section style=\"margin-bottom:24px\">'+\n      '<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\">'+\n        '<h2 style=\"margin:0;font-size:16px\">履歴</h2>'+\n        '<a style=\"color:var(--text-2);cursor:pointer\" onclick=\"route(\\\\'/feed/history\\\\')\">すべて表示</a>'+\n      '</div>'+\n      gridHTML(hist)+\n    '</section>'+\n    '<section>'+\n      '<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\">'+\n        '<h2 style=\"margin:0;font-size:16px\">高評価した動画</h2>'+\n        '<a style=\"color:var(--text-2);cursor:pointer\" onclick=\"route(\\\\'/feed/liked\\\\')\">すべて表示</a>'+\n      '</div>'+\n      gridHTML(liked)+\n    '</section>';\n}\nasync function renderSubscriptions(){\n  const subs = SUBS.list();\n  const main=$('#main');\n  if(!subs.length){ main.innerHTML='<div class=\"empty\">登録チャンネルがまだありません</div>'; return; }\n  main.innerHTML='<h1 style=\"margin:0 0 16px\">登録チャンネルの最新動画</h1><div id=\"sub-grid\"><div class=\"loading\"><div class=\"spinner\"></div></div></div>';\n  const all=[];\n  for(const s of subs.slice(0,15)){\n    try{\n      const r = await api('/api/channel/'+encodeURIComponent(s.id)+'/videos');\n      const vs = (r.videos||r||[]).slice(0,6);\n      all.push.apply(all, vs);\n    }catch{}\n  }\n  all.sort((a,b)=>(b.published||0)-(a.published||0));\n  $('#sub-grid').innerHTML = gridHTML(all);\n}\n\n/* ---------- Search bar ---------- */\nconst qEl = $('#q'); const sugEl = $('#suggest');\nlet sugIdx = -1;\n$('#search-form').addEventListener('submit', e=>{\n  e.preventDefault();\n  const v = qEl.value.trim(); if(!v) return;\n  sugEl.classList.remove('show');\n  route('/results?search_query='+encodeURIComponent(v));\n});\nlet sugTimer = null;\nqEl.addEventListener('input', ()=>{\n  clearTimeout(sugTimer);\n  const v = qEl.value.trim();\n  if(!v){ sugEl.classList.remove('show'); sugEl.innerHTML=''; return; }\n  sugTimer = setTimeout(async ()=>{\n    try{\n      const items = await api('/api/suggest?q='+encodeURIComponent(v));\n      if(!items.length){ sugEl.classList.remove('show'); return; }\n      sugEl.innerHTML = items.slice(0,10).map(it=>\n        '<div><svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M15.5 14h-.8l-.27-.27a6.5 6.5 0 1 0-.71.71l.27.28v.79l5 5L20.5 19zM10 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8z\"/></svg><span>'+esc(it)+'</span></div>'\n      ).join('');\n      sugIdx = -1;\n      sugEl.classList.add('show');\n      $$('#suggest div').forEach(d=>d.addEventListener('click',()=>{\n        qEl.value = d.querySelector('span').textContent;\n        sugEl.classList.remove('show');\n        route('/results?search_query='+encodeURIComponent(qEl.value));\n      }));\n    }catch{}\n  }, 150);\n});\nqEl.addEventListener('keydown', e=>{\n  const items = $$('#suggest div');\n  if(!sugEl.classList.contains('show')||!items.length) return;\n  if(e.key==='ArrowDown'){ e.preventDefault(); sugIdx=(sugIdx+1)%items.length; }\n  else if(e.key==='ArrowUp'){ e.preventDefault(); sugIdx=(sugIdx-1+items.length)%items.length; }\n  else if(e.key==='Escape'){ sugEl.classList.remove('show'); return; }\n  else if(e.key==='Enter' && sugIdx>=0){\n    e.preventDefault();\n    qEl.value = items[sugIdx].querySelector('span').textContent;\n    sugEl.classList.remove('show');\n    route('/results?search_query='+encodeURIComponent(qEl.value));\n    return;\n  } else return;\n  items.forEach((it,i)=>it.classList.toggle('active', i===sugIdx));\n});\ndocument.addEventListener('click', e=>{\n  if(!e.target.closest('#suggest') && e.target!==qEl) sugEl.classList.remove('show');\n});\n\n(function syncQuery(){\n  const u = new URL(location.href);\n  if(u.pathname==='/results') qEl.value = u.searchParams.get('search_query')||'';\n})();\n\nrender();\n</script>\n";
const HTML_DOC = buildHtmlDocument();

app.get(['/', '/watch', '/results', '/trending', '/channel/*', '/feed/*'], (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(HTML_DOC);
});
app.get('*', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(HTML_DOC);
});

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('YT-Ultra running on http://localhost:' + port));
}

function buildHtmlDocument() {
  return '<!DOCTYPE html>\n' +
'<html lang="ja">\n' +
'<head>\n' +
'<meta charset="utf-8" />\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />\n' +
'<title>YT Ultra — 最速のYouTube代替</title>\n' +
'<meta name="theme-color" content="#0f0f0f" />\n' +
'<meta name="description" content="API キー不要・広告なし・高速。YouTube の完全代替フロントエンド。" />\n' +
'<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 90 64\'%3E%3Crect width=\'90\' height=\'64\' rx=\'14\' fill=\'%23ff0033\'/%3E%3Cpolygon points=\'36,18 36,46 60,32\' fill=\'white\'/%3E%3C/svg%3E" />\n' +
INLINE_CSS + '\n' +
'</head>\n' +
'<body>\n' +
INLINE_HEADER + '\n' +
'<div id="layout">\n' +
INLINE_SIDEBAR + '\n' +
'  <main id="main" tabindex="-1"></main>\n' +
'</div>\n' +
'<div id="toast" role="status" aria-live="polite"></div>\n' +
INLINE_JS + '\n' +
'</body>\n' +
'</html>';
}

