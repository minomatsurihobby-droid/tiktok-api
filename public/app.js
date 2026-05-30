/* ============================================================
   TokView - フロントエンドロジック
   - 縦スクロールスナップで本家風 UX
   - IntersectionObserver で現在表示カードのみ再生
   - 末尾近くで自動的に追加ロード（無限スクロール）
   - 検索 / リージョン切替
   ============================================================ */

(() => {
  "use strict";

  // ---------- 状態 ----------
  const state = {
    mode: "feed",        // 'feed' | 'search'
    region: "jp",
    keywords: "",
    cursor: "0",
    hasMore: true,
    loading: false,
    muted: true,         // 自動再生のためデフォルト ミュート
    seenIds: new Set(),  // 重複防止
  };

  // ---------- DOM ----------
  const feedEl = document.getElementById("feed");
  const loaderEl = document.getElementById("loader");
  const emptyEl = document.getElementById("empty");
  const emptyBackBtn = document.getElementById("emptyBack");
  const cardTpl = document.getElementById("cardTpl");
  const searchForm = document.getElementById("searchForm");
  const searchInput = document.getElementById("searchInput");
  const tabs = document.querySelectorAll(".tab");
  const hintEl = document.getElementById("hint");

  // ---------- ユーティリティ ----------
  const fmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };

  function showLoader(show) { loaderEl.hidden = !show; }
  function hideHintSoon() { setTimeout(() => hintEl.classList.add("hide"), 2500); }

  // ---------- データ取得 ----------
  async function fetchPage() {
    if (state.loading || !state.hasMore) return [];
    state.loading = true;
    showLoader(true);
    try {
      let url;
      if (state.mode === "search") {
        url = `/api/search?keywords=${encodeURIComponent(state.keywords)}&count=12&cursor=${encodeURIComponent(state.cursor)}`;
      } else {
        url = `/api/feed?region=${encodeURIComponent(state.region)}&count=12&cursor=${encodeURIComponent(state.cursor)}`;
      }
      const r = await fetch(url);
      const json = await r.json();
      if (!json.ok) throw new Error(json.error || "fetch failed");

      state.cursor = json.cursor || state.cursor;
      state.hasMore = !!json.hasMore;

      // 重複除去
      const fresh = (json.videos || []).filter(v => v && v.id && !state.seenIds.has(v.id));
      fresh.forEach(v => state.seenIds.add(v.id));
      return fresh;
    } catch (e) {
      console.error("[fetchPage]", e);
      return [];
    } finally {
      state.loading = false;
      showLoader(false);
    }
  }

  // ---------- カード生成 ----------
  function buildCard(v) {
    const node = cardTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = v.id;
    node.dataset.src = v.play;
    node.dataset.fallback = v.playDirect || "";

    // 動画は IntersectionObserver で再生時にセット
    const video = node.querySelector(".video");
    video.muted = state.muted;
    video.playsInline = true;

    // ポスター（カバー）
    if (v.cover) {
      video.poster = v.cover;
    }

    // メタ
    const auth = v.author || {};
    node.querySelector(".uniq").textContent = auth.unique_id || auth.nickname || "user";
    node.querySelector(".title").textContent = v.title || "";
    node.querySelector(".music-title").textContent =
      (v.music && v.music.title) ? v.music.title : "original sound";

    const avatar = node.querySelector(".avatar");
    if (auth.avatar) avatar.src = auth.avatar;

    const musicCover = node.querySelector(".music-cover");
    if (v.music && v.music.cover) musicCover.src = v.music.cover;

    node.querySelector(".digg").textContent = fmt(v.stats.digg);
    node.querySelector(".comment").textContent = fmt(v.stats.comment);
    node.querySelector(".share").textContent = fmt(v.stats.share);

    // ミュートボタン表示
    const muteBtn = node.querySelector(".mute-btn");
    muteBtn.textContent = state.muted ? "🔇" : "🔊";

    // ===== イベント =====
    // タップでミュート切替（初回タップで音が出るようにもする）
    muteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.muted = !state.muted;
      document.querySelectorAll(".feed video").forEach(v => v.muted = state.muted);
      document.querySelectorAll(".mute-btn").forEach(b => b.textContent = state.muted ? "🔇" : "🔊");
    });

    // 動画クリックで再生/停止トグル
    const playOverlay = node.querySelector(".play-overlay");
    video.addEventListener("click", () => {
      if (video.paused) {
        video.play().catch(()=>{});
        playOverlay.hidden = true;
      } else {
        video.pause();
        playOverlay.hidden = false;
      }
    });

    // いいねボタン
    const likeBtn = node.querySelector(".like-btn");
    const diggEl = node.querySelector(".digg");
    let liked = false;
    let base = v.stats.digg;
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      liked = !liked;
      likeBtn.classList.toggle("liked", liked);
      diggEl.textContent = fmt(base + (liked ? 1 : 0));
    });

    // ダブルタップでいいね
    let lastTap = 0;
    video.addEventListener("touchend", () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        if (!liked) {
          liked = true;
          likeBtn.classList.add("liked");
          diggEl.textContent = fmt(base + 1);
        }
      }
      lastTap = now;
    });

    // シェアボタン
    node.querySelector(".share-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const shareUrl = `${location.origin}/?v=${v.id}`;
      try {
        if (navigator.share) {
          await navigator.share({ title: v.title || "TokView", url: shareUrl });
        } else {
          await navigator.clipboard.writeText(shareUrl);
          flashToast("リンクをコピーしました");
        }
      } catch (_) { /* キャンセル等 */ }
    });

    // コメントボタン（簡易：トースト）
    node.querySelector(".comment-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      flashToast("コメント機能は準備中です 💬");
    });

    // 進行バー
    const bar = node.querySelector(".bar");
    video.addEventListener("timeupdate", () => {
      if (video.duration) bar.style.width = (video.currentTime / video.duration * 100) + "%";
    });

    // エラー時
    const errorOverlay = node.querySelector(".error-overlay");
    const loadingOverlay = node.querySelector(".loading-overlay");
    const retryBtn = node.querySelector(".error-retry");

    let triedFallback = false;
    video.addEventListener("error", () => {
      if (!triedFallback && node.dataset.fallback) {
        triedFallback = true;
        loadingOverlay.hidden = false;
        errorOverlay.hidden = true;
        video.src = node.dataset.fallback;
        video.load();
      } else {
        loadingOverlay.hidden = true;
        errorOverlay.hidden = false;
      }
    });
    video.addEventListener("loadeddata", () => {
      loadingOverlay.hidden = true;
      errorOverlay.hidden = true;
    });
    retryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      triedFallback = false;
      errorOverlay.hidden = true;
      loadingOverlay.hidden = false;
      video.src = node.dataset.src;
      video.load();
      video.play().catch(()=>{});
    });

    return node;
  }

  // ---------- トースト ----------
  let toastTimer;
  function flashToast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.style.cssText = `
        position:fixed; left:50%; bottom:90px; transform:translateX(-50%);
        background:rgba(0,0,0,.8); color:#fff; padding:10px 18px;
        border-radius:999px; font-size:13px; z-index:200; opacity:0;
        transition:opacity .25s; pointer-events:none;`;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = "0"), 1800);
  }

  // ---------- 再生制御（IntersectionObserver） ----------
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const card = entry.target;
      const video = card.querySelector(".video");
      if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
        // 表示中: 再生開始
        if (!video.src) {
          video.src = card.dataset.src;
        }
        const p = video.play();
        if (p && p.catch) p.catch(() => {
          // 自動再生失敗時は再生オーバーレイ表示
          card.querySelector(".play-overlay").hidden = false;
        });
      } else {
        // 画面外: 停止
        video.pause();
        // メモリ節約: 大きく離れたら src を外す
        if (entry.intersectionRatio === 0) {
          // 1枚前後を残してアンロード
          // ここでは即時アンロードは行わない（戻る時の体験を優先）
        }
      }
    });
  }, { threshold: [0, 0.6, 1] });

  // ---------- 無限スクロール ----------
  const sentinelIO = new IntersectionObserver(async (entries) => {
    if (entries.some(e => e.isIntersecting)) {
      await appendNextPage();
    }
  }, { rootMargin: "200px 0px" });

  let sentinelEl = null;
  function placeSentinel() {
    if (sentinelEl) sentinelEl.remove();
    sentinelEl = document.createElement("div");
    sentinelEl.style.height = "1px";
    sentinelEl.id = "sentinel";
    feedEl.appendChild(sentinelEl);
    sentinelIO.observe(sentinelEl);
  }

  async function appendNextPage() {
    const list = await fetchPage();
    if (!list.length) {
      // 無検索結果フォールバック
      if (feedEl.children.length === 0) {
        emptyEl.hidden = false;
      }
      return;
    }
    emptyEl.hidden = true;

    const frag = document.createDocumentFragment();
    list.forEach(v => {
      const card = buildCard(v);
      frag.appendChild(card);
    });
    feedEl.appendChild(frag);

    // 新カードに observer をかける
    feedEl.querySelectorAll(".card").forEach(c => io.observe(c));
    placeSentinel();
  }

  // ---------- リセット & 再読込 ----------
  async function resetAndLoad() {
    state.cursor = "0";
    state.hasMore = true;
    state.seenIds.clear();
    feedEl.innerHTML = "";
    emptyEl.hidden = true;
    await appendNextPage();
    // 先頭にスクロール
    feedEl.scrollTo({ top: 0, behavior: "instant" });
  }

  // ---------- 検索 ----------
  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) {
      state.mode = "feed";
    } else {
      state.mode = "search";
      state.keywords = q;
    }
    tabs.forEach(t => t.classList.remove("active"));
    await resetAndLoad();
  });

  // ---------- タブ切替 ----------
  tabs.forEach(btn => {
    btn.addEventListener("click", async () => {
      tabs.forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      state.mode = "feed";
      state.region = btn.dataset.region;
      state.keywords = "";
      searchInput.value = "";
      await resetAndLoad();
    });
  });

  emptyBackBtn.addEventListener("click", async () => {
    state.mode = "feed"; state.keywords = ""; searchInput.value = "";
    tabs.forEach(t => t.classList.remove("active"));
    tabs[0].classList.add("active");
    await resetAndLoad();
  });

  // ---------- キーボード操作 ----------
  document.addEventListener("keydown", (e) => {
    const cards = [...feedEl.querySelectorAll(".card")];
    if (!cards.length) return;
    const top = feedEl.scrollTop;
    const idx = Math.round(top / window.innerHeight);
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      const next = cards[Math.min(idx + 1, cards.length - 1)];
      next && next.scrollIntoView({ behavior: "smooth" });
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      const prev = cards[Math.max(idx - 1, 0)];
      prev && prev.scrollIntoView({ behavior: "smooth" });
    } else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      const cur = cards[idx];
      if (cur) {
        const v = cur.querySelector(".video");
        if (v.paused) v.play(); else v.pause();
      }
    } else if (e.key === "m") {
      state.muted = !state.muted;
      document.querySelectorAll(".feed video").forEach(v => v.muted = state.muted);
      document.querySelectorAll(".mute-btn").forEach(b => b.textContent = state.muted ? "🔇" : "🔊");
    }
  });

  // ---------- 共有URLで起動した場合（?v=ID） ----------
  async function maybeOpenShared() {
    const params = new URLSearchParams(location.search);
    const vid = params.get("v");
    if (!vid) return false;
    try {
      const r = await fetch(`/api/video?id=${encodeURIComponent(vid)}`);
      const j = await r.json();
      if (j.ok && j.video) {
        state.seenIds.add(j.video.id);
        feedEl.appendChild(buildCard(j.video));
        feedEl.querySelectorAll(".card").forEach(c => io.observe(c));
        // 続きはおすすめで埋める
        await appendNextPage();
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ---------- 起動 ----------
  (async function init() {
    hideHintSoon();
    const opened = await maybeOpenShared();
    if (!opened) await appendNextPage();
  })();

})();
