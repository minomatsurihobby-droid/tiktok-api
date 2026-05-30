// ============================================================
// TikTok Viewer - Express server for Vercel (@vercel/node)
//   - / と /api/* を1ファイルで提供
//   - tikwm.com の公開APIをサーバー経由でプロキシしてCORS/レート制限を回避
//   - 簡易メモリキャッシュで負荷を低減
// ============================================================

const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();

// ---------- 設定 ----------
const TIKWM_BASE = "https://www.tikwm.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// メモリキャッシュ（Vercelのサーバーレスでもウォーム実行中は有効）
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60秒

function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function setCache(key, data) {
  cache.set(key, { t: Date.now(), data });
  // メモリ膨張防止
  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// ---------- 共通 fetch ----------
async function tikwm(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${TIKWM_BASE}${pathname}${qs ? "?" + qs : ""}`;
  const key = "GET " + url;
  const cached = getCache(key);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ja,en;q=0.9",
      Referer: "https://www.tikwm.com/",
    },
    // 12秒タイムアウト
    timeout: 12000,
  });

  if (!res.ok) {
    throw new Error(`tikwm ${res.status}`);
  }
  const json = await res.json();
  setCache(key, json);
  return json;
}

// 動画オブジェクトを統一フォーマットに整える
function normalizeVideo(v) {
  if (!v) return null;
  const id = v.video_id || v.id;
  if (!id) return null;
  return {
    id: String(id),
    title: v.title || v.content_desc || "",
    cover: v.cover || v.origin_cover || v.ai_dynamic_cover || "",
    dynamicCover: v.ai_dynamic_cover || v.origin_cover || v.cover || "",
    // メインの再生URL: ユーザー指定の tikwm の安定ストリーム
    play: `https://tikwm.com/video/media/play/${id}.mp4`,
    // フォールバック（直接の CDN URL）
    playDirect: v.play || v.wmplay || "",
    music: v.music_info
      ? {
          id: v.music_info.id,
          title: v.music_info.title,
          author: v.music_info.author,
          play: v.music_info.play,
          cover: v.music_info.cover,
        }
      : null,
    duration: v.duration || 0,
    stats: {
      play: v.play_count || 0,
      digg: v.digg_count || 0,
      comment: v.comment_count || 0,
      share: v.share_count || 0,
      collect: v.collect_count || 0,
    },
    author: v.author
      ? {
          id: v.author.id,
          unique_id: v.author.unique_id,
          nickname: v.author.nickname,
          avatar: v.author.avatar,
        }
      : null,
    region: v.region || "",
    createTime: v.create_time || 0,
  };
}

// ---------- API ルート ----------

// トレンド／フィード
//   GET /api/feed?region=jp&count=12&cursor=0
app.get("/api/feed", async (req, res) => {
  try {
    const region = (req.query.region || "jp").toString().toLowerCase();
    const count = Math.min(parseInt(req.query.count || "12", 10) || 12, 20);
    const cursor = (req.query.cursor || "0").toString();

    const json = await tikwm("/api/feed/list", { region, count, cursor });

    if (json.code !== 0) {
      return res.status(502).json({ ok: false, error: json.msg || "upstream error" });
    }

    // /api/feed/list は data が「配列」で返ってくる
    const list = Array.isArray(json.data) ? json.data : [];
    const videos = list.map(normalizeVideo).filter(Boolean);

    res.json({
      ok: true,
      videos,
      hasMore: true, // 連続スクロール用に常時 true
      cursor: String(parseInt(cursor, 10) + count),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "internal" });
  }
});

// 検索
//   GET /api/search?keywords=cat&count=12&cursor=0
app.get("/api/search", async (req, res) => {
  try {
    const keywords = (req.query.keywords || "").toString().trim();
    if (!keywords) {
      return res.status(400).json({ ok: false, error: "keywords required" });
    }
    const count = Math.min(parseInt(req.query.count || "12", 10) || 12, 20);
    const cursor = (req.query.cursor || "0").toString();

    const json = await tikwm("/api/feed/search", { keywords, count, cursor });

    if (json.code !== 0) {
      return res.status(502).json({ ok: false, error: json.msg || "upstream error" });
    }

    // /api/feed/search は data が { videos, cursor, hasMore }
    const data = json.data || {};
    const list = Array.isArray(data.videos) ? data.videos : [];
    const videos = list.map(normalizeVideo).filter(Boolean);

    res.json({
      ok: true,
      videos,
      hasMore: !!data.hasMore,
      cursor: String(data.cursor || parseInt(cursor, 10) + count),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "internal" });
  }
});

// 個別動画情報（共有URL等から）
//   GET /api/video?url=https://www.tiktok.com/.../video/123  or  ?id=7585...
app.get("/api/video", async (req, res) => {
  try {
    const id = (req.query.id || "").toString().trim();
    const url = (req.query.url || "").toString().trim();
    if (!id && !url) {
      return res.status(400).json({ ok: false, error: "id or url required" });
    }

    // id 指定なら仮想URLを組み立てて tikwm に投げる
    const target = url || `https://www.tiktok.com/@u/video/${id}`;
    const json = await tikwm("/api//", { url: target, hd: 1 });

    if (json.code !== 0) {
      return res.status(502).json({ ok: false, error: json.msg || "upstream error" });
    }
    res.json({ ok: true, video: normalizeVideo(json.data) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "internal" });
  }
});

// ヘルスチェック
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- 静的アセット ----------
// Vercelの @vercel/node は public/ を自動公開しないので express で配る
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// それ以外は index.html
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Vercel / ローカル両対応
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`▶ http://localhost:${port}`));
}

module.exports = app;
