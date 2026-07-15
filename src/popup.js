const YOUTUBE_CONFIG = globalThis.OCHA_YTDL_YOUTUBE_CONFIG || {};
const DEFAULT_INNERTUBE_API_KEY = YOUTUBE_CONFIG.defaultInnertubeApiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const DEFAULT_WEB_CLIENT_VERSION = YOUTUBE_CONFIG.defaultWebClientVersion || '2.20260114.08.00';
const RANGE_CHUNK_SIZE = YOUTUBE_CONFIG.rangeChunkSize || (10 << 20); // 10MB — matches yt-dlp's CHUNK_SIZE
const MUX_SOFT_LIMIT = 1100 * 1024 * 1024; // ~1.1GB 超: ffmpeg.wasm(wasm32)がヒープ確保に失敗(OOM)しやすい目安
const MAINTENANCE_STATUS_URL = 'https://raw.githubusercontent.com/0ch4/ocha-YTdl/main/docs/compat/latest.json';
const MAINTENANCE_STATUS_CACHE_MS = 24 * 60 * 60 * 1000;
const UPDATE_GUIDE_URL = 'https://github.com/0ch4/ocha-YTdl/blob/main/docs/UPDATE_JA.md';

document.addEventListener('DOMContentLoaded', async () => {
  // ?job=ID で開かれた場合は「ダウンロード専用ウィンドウ」として動作し、
  // 通常のUI抽出フローはスキップ（popupを閉じてもDL/合成が継続するようにするため）。
  const jobId = new URLSearchParams(location.search).get('job');
  if (jobId) { await runDownloadWorker(jobId); return; }

  const statusEl = document.getElementById('status');
  const errorEl  = document.getElementById('error');
  const titleEl  = document.getElementById('video-title');
  const versionEl = document.getElementById('version');
  const thumbEl  = document.getElementById('video-thumb');
  const durationEl = document.getElementById('video-duration');
  const sourceChipEl = document.getElementById('video-source-chip');
  const lengthChipEl = document.getElementById('video-length-chip');
  const nSigEl   = document.getElementById('nsig-status');
  const maintenanceEl = document.getElementById('maintenance-status');
  const maintenanceActionsEl = document.getElementById('maintenance-actions');
  const maintenancePillEl = document.getElementById('maintenance-pill');
  const updateGuideBtn = document.getElementById('open-update-guide');
  const reloadExtensionBtn = document.getElementById('reload-extension');
  const iframe   = document.getElementById('solver-iframe');
  const qualityPicker = document.getElementById('quality-picker');
  const qualityNote = document.getElementById('quality-note');
  const formatDebug = document.getElementById('format-debug');
  const pickerEls = {
    qualityPicker,
    resolutionSelect: document.getElementById('video-resolution-select'),
    fpsSelect: document.getElementById('video-fps-select'),
    extSelect: document.getElementById('video-ext-select'),
    videoSelect: document.getElementById('video-format-select'),
    audioSelect: document.getElementById('audio-format-select'),
    downloadVideo: document.getElementById('download-video-selected'),
    downloadAudio: document.getElementById('download-audio-selected'),
    downloadPair: document.getElementById('download-pair-selected'),
    downloadMux: document.getElementById('download-mux-selected'),
    trimRange: document.getElementById('trim-range-input'),
    trimStart: document.getElementById('trim-start-input'),
    trimEnd: document.getElementById('trim-end-input'),
    qualityNote
  };

  if (versionEl) {
    versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  updateGuideBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: UPDATE_GUIDE_URL });
  });
  reloadExtensionBtn?.addEventListener('click', () => {
    chrome.runtime.reload();
  });

  checkMaintenanceStatus(maintenanceEl, maintenanceActionsEl, maintenancePillEl).catch(e => {
    setMaintenancePill(maintenancePillEl, 'unknown', '確認不可', '互換性ステータスを確認できませんでした');
    console.info('[ytdl] Maintenance status check skipped:', e?.message || e);
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = extractYouTubeVideoId(tab?.url);
  const isShorts = isShortsUrl(tab?.url);
  _tabId = tab?.id ?? null; // PO Token をページMAIN worldで生成するのに使う

  if (!isYoutubeUrl(tab?.url)) {
    statusEl.textContent = 'YouTubeを開いてください';
    return;
  }

  if (!videoId) {
    statusEl.textContent = 'YouTubeの動画またはショート動画ページを開いてください';
    return;
  }

  statusEl.textContent = '動画情報を取得中...';

  await applyTrimDraft(pickerEls, videoId);

  // 1. Extract page globals using scripting API in MAIN world
  let pageGlobals;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        let pr = null;
        try { pr = window.ytInitialPlayerResponse || null; } catch(e) {}

        let jsUrl = null;
        let ytcfgData = {};
        try { ytcfgData = window.ytcfg?.data_ || {}; } catch(e) {}
        try { jsUrl = ytcfgData.PLAYER_JS_URL || null; } catch(e) {}

        // DOM fallback for playerResponse
        if (!pr) {
          for (const s of document.querySelectorAll('script:not([src])')) {
            const idx = s.textContent.indexOf('ytInitialPlayerResponse');
            if (idx === -1) continue;
            const start = s.textContent.indexOf('{', idx);
            if (start === -1) continue;
            let depth = 1, i = start + 1;
            const t = s.textContent;
            while (i < t.length && depth > 0) {
              if (t[i] === '{') depth++;
              else if (t[i] === '}') depth--;
              i++;
            }
            try {
              const p = JSON.parse(t.slice(start, i));
              if (p.streamingData) { pr = p; break; }
            } catch (_) {}
          }
        }
        
        // DOM fallback for PLAYER_JS_URL
        if (!jsUrl) {
          for (const s of document.querySelectorAll('script:not([src])')) {
            const m = s.textContent.match(/"(?:jsUrl|PLAYER_JS_URL)"\s*:\s*"([^"]+\/player\/[^"]+\.js)"/);
            if (!m) continue;
            jsUrl = m[1].replace(/\\\//g, '/');
            break;
          }
        }

        if (jsUrl && jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
        else if (jsUrl && jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;

        return {
          docTitle: document.title || null, // ytInitialPlayerResponse 未設定時のタイトル確実なフォールバック
          playerResponse: pr ? {
            videoDetails: pr.videoDetails ? {
              videoId: pr.videoDetails.videoId || null, // 現在URLのvideoIdと突き合わせて陳腐化を検出する
              title: pr.videoDetails.title,
              lengthSeconds: pr.videoDetails.lengthSeconds || null,
              isLiveContent: Boolean(pr.videoDetails.isLiveContent),
              isLive: Boolean(pr.videoDetails.isLive),
              thumbnail: pr.videoDetails.thumbnail || null
            } : null,
            streamingData: pr.streamingData
          } : null,
          playerJsUrl: jsUrl,
          innertube: {
            apiKey: ytcfgData.INNERTUBE_API_KEY || null,
            context: ytcfgData.INNERTUBE_CONTEXT || null,
            clientName: ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME || null,
            clientVersion: ytcfgData.INNERTUBE_CLIENT_VERSION || ytcfgData.INNERTUBE_CONTEXT?.client?.clientVersion || null,
            visitorData: ytcfgData.VISITOR_DATA || ytcfgData.INNERTUBE_CONTEXT?.client?.visitorData || null,
            sts: ytcfgData.STS || ytcfgData.SIGNATURE_TIMESTAMP || null
          }
        };
      }
    });
    pageGlobals = results?.[0]?.result;
  } catch (e) {
    showError(`動画情報の取得に失敗しました。ページをリロードしてから再試行してください。\n(${e.message})`);
    return;
  }

  // tv-only では player.js URL さえ取れれば watchページHTMLの取得(重い)は不要。
  // ページから player.js URL を取れなかった時だけ HTML を補完取得する。
  try {
    if (!pageGlobals?.playerJsUrl) {
      statusEl.textContent = '動画ページ情報を補完中...';
      pageGlobals = mergePageGlobals(pageGlobals, await fetchWatchPageGlobals(videoId));
    }
  } catch (e) {
    console.warn('[ytdl] Watch page fallback failed:', e);
  }

  // Shorts等のSPA遷移では window.ytInitialPlayerResponse が現在の動画に更新されない
  // ことがある。特に「再生不可なShort(削除済み等)」を挟むとページ側の更新が止まり、
  // その後いくらスクロール/URL変更しても前の動画のまま固まる（要リロード）。
  // → URL由来の videoId と一致しないページ応答は「古い別動画」なので破棄し、
  //   現在の videoId で取得した API 応答のみを使う。
  const pageVideoId = pageGlobals?.playerResponse?.videoDetails?.videoId || null;
  if (pageGlobals?.playerResponse && pageVideoId && pageVideoId !== videoId) {
    console.info(`[ytdl] stale ytInitialPlayerResponse (${pageVideoId} ≠ ${videoId}); ページ応答を無視`);
    pageGlobals.playerResponse = null;
  }

  _visitorData = pageGlobals?.innertube?.visitorData || null;
  _videoId = videoId;
  // PO Token は事前生成しない（tv経路は signatureTimestamp + Cookie で pot不要）。
  // 実際に 20MB超のDLで 403 になった時だけ遅延生成する（fetchRange 内）。

  const playerJsUrl = pageGlobals?.playerJsUrl;
  // player.js は tv リクエストと並行取得（どちらもネットワーク待ち＝重ね合わせで短縮）。
  const playerJsPromise = playerJsUrl
    ? getCachedPlayerJs(playerJsUrl).catch(e => { console.warn('[ytdl] player.js fetch failed:', e); return null; })
    : Promise.resolve(null);

  let apiPlayerResponse = [];
  let playerFetchDebug = null;
  try {
    statusEl.textContent = '動画フォーマットを確認中...';
    const fetchResult = await fetchInnertubePlayerResponses(videoId, pageGlobals?.innertube, statusEl, tab.id, _pot);
    apiPlayerResponse = fetchResult.responses;
    playerFetchDebug = fetchResult.debug;
  } catch (e) {
    console.warn('[ytdl] Innertube fallback failed:', e.message || e);
    playerFetchDebug = { errors: [e.message || String(e)], clients: [] };
  }

  const playerResponse = pickBestPlayerResponse([...apiPlayerResponse, markPlayerResponseSource(pageGlobals?.playerResponse, 'page')]);

  if (!playerResponse?.streamingData) {
    showError('動画情報が見つかりません。ページを再読み込みしてください。');
    return;
  }

  // タイトル/サムネ/再生時間は、ページの ytInitialPlayerResponse.videoDetails が最も充実
  // （tv応答は title を持たないことがある）。ページ情報を優先し、無ければAPI応答で補完。
  // どちらも無い場合（ytInitialPlayerResponse 未設定時など）は document.title から復元。
  const videoDetails = {
    ...(playerResponse.videoDetails || {}),
    ...(pageGlobals?.playerResponse?.videoDetails || {})
  };
  const title = videoDetails.title || cleanYouTubeDocTitle(pageGlobals?.docTitle) || 'video';
  videoDetails.title = title;
  const videoInfo = buildVideoInfo({ videoDetails }, videoId, isShorts);
  const { formats: rawFmts, adaptiveFormats: rawAdapt } = playerResponse.streamingData;
  const allFmtsRaw = dedupeRawFormats([...(rawFmts ?? []), ...(rawAdapt ?? [])]);

  // 2. Collect unique n values and encrypted signatures
  const ns = new Set();
  const sigs = new Set();
  for (const fmt of allFmtsRaw) {
    try {
      let url = fmt.url;
      let s = null;
      const cipherText = fmt.signatureCipher || fmt.cipher;
      if (cipherText) {
        const cipher = new URLSearchParams(cipherText);
        url = cipher.get('url');
        s = cipher.get('s');
      }
      if (s) {
        sigs.add(s);
      }
      if (url) {
        const n = new URL(url).searchParams.get('n');
        if (n) ns.add(n);
      }
    } catch (_) {}
  }
  const uniqueNValues = [...ns];
  const uniqueSigValues = [...sigs];

  // 3. Decrypt n and sig values
  let nMap = {};
  let sigMap = {};
  let nSigOk = true;
  let nSigError = null;

  if (uniqueNValues.length > 0 || uniqueSigValues.length > 0) {
    if (!playerJsUrl) {
      nSigOk = false;
      nSigError = 'player.js URL不明';
    } else {
      try {
        statusEl.textContent = '復号ロジックを読み込み中...';

        // tv リクエストと並行で取得済み（または取得中）の player.js を待つ
        const playerJs = await playerJsPromise;
        if (!playerJs) throw new Error('player.js を取得できませんでした');

        statusEl.textContent = 'シグネチャを復号中...';
        
        // Wait for sandbox iframe to be ready
        await new Promise((resolve, reject) => {
          const handshakeTimeout = setTimeout(() => {
            clearInterval(pingInterval);
            window.removeEventListener('message', handlePong);
            reject(new Error('サンドボックスの起動に失敗しました（タイムアウト）'));
          }, 5000);

          const pingInterval = setInterval(() => {
            if (iframe && iframe.contentWindow) {
              iframe.contentWindow.postMessage({ action: 'ping' }, '*');
            }
          }, 50);

          function handlePong(e) {
            if (e.data && e.data.action === 'pong') {
              clearInterval(pingInterval);
              clearTimeout(handshakeTimeout);
              window.removeEventListener('message', handlePong);
              resolve();
            }
          }
          window.addEventListener('message', handlePong);
        });

        const decryptResult = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            window.removeEventListener('message', handleMessage);
            reject(new Error('復号タイムアウト（30秒）'));
          }, 30000);

          function handleMessage(e) {
            if (e.data && e.data.action === 'decryptResult') {
              clearTimeout(timeout);
              window.removeEventListener('message', handleMessage);
              if (e.data.success) {
                resolve({ nMap: e.data.nMap || {}, sigMap: e.data.sigMap || {} });
              } else {
                reject(new Error(e.data.error));
              }
            }
          }

          window.addEventListener('message', handleMessage);

          iframe.contentWindow.postMessage({
            action: 'decrypt',
            playerJs: playerJs,
            nValues: uniqueNValues,
            sigValues: uniqueSigValues
          }, '*');
        });

        nMap = decryptResult.nMap;
        sigMap = decryptResult.sigMap;
      } catch (e) {
        nSigOk = false;
        nSigError = '復号失敗: ' + e.message;
      }
    }
  }

  // 4. Resolve URLs and render sections
  const muxedItags = new Set((rawFmts ?? []).map(f => f.itag));
  const resolveStats = { unresolvedSig: 0, unresolvedN: 0, failed: 0 };
  const formats = allFmtsRaw.flatMap(fmt => {
    try {
      const url = resolveUrl(fmt, nMap, sigMap, resolveStats);
      const mime = fmt.mimeType ?? '';
      const isMuxed = muxedItags.has(fmt.itag);
      const hasVideo = mime.startsWith('video/') || Boolean(fmt.width || fmt.height);
      const hasAudio = mime.startsWith('audio/') || isMuxed || Boolean(fmt.audioQuality);
      const audio = hasAudio && !hasVideo ? parseAudioMeta(fmt, url) : {};
      return [{
        itag: fmt.itag, url,
        quality: formatQualityLabel(fmt),
        mimeType: mime, ext: mimeToExt(mime),
        contentLength: fmt.contentLength ? parseInt(fmt.contentLength) : null,
        isMuxed,
        hasVideo,
        hasAudio,
        source: fmt.source ?? null,
        potFree: isPotFreeSource(fmt.source),
        height: fmt.height ?? null, fps: fmt.fps ?? null, bitrate: fmt.bitrate ?? null,
        ...audio,
      }];
    } catch (_) {
      resolveStats.failed++;
      return [];
    }
  });

  if (formats.length === 0) {
    showError('ダウンロード可能なフォーマットが見つかりませんでした');
    return;
  }

  statusEl.style.display = 'none';
  titleEl.textContent = title;
  if (sourceChipEl) sourceChipEl.textContent = videoInfo.isShorts ? 'Shorts' : 'YouTube';
  if (durationEl) durationEl.textContent = videoInfo.durationLabel;
  if (lengthChipEl) lengthChipEl.textContent = `長さ: ${videoInfo.durationLabel}`;
  if (thumbEl) {
    thumbEl.alt = title;
    thumbEl.src = videoInfo.thumbnailUrl;
    thumbEl.onerror = () => {
      if (thumbEl.dataset.fallbackApplied === '1') return;
      thumbEl.dataset.fallbackApplied = '1';
      thumbEl.src = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    };
  }

  // 成功時はノイズになるので表示しない。失敗時のみ警告を出す。
  if (nSigOk) {
    nSigEl.style.display = 'none';
  } else {
    nSigEl.textContent = `✗ シグネチャ: 失敗 — ${nSigError ?? ''}`;
    nSigEl.className = 'nsig-fail';
    nSigEl.style.display = 'block';
  }

  // PO Token の捕獲状況（無いと20MB超のDLが失敗する）
  // PO Token は遅延生成（必要時のみ）なので起動時は表示しない。
  const potEl = document.getElementById('pot-status');
  if (potEl) potEl.style.display = 'none';

  const muxed     = formats.filter(f => f.isMuxed);
  const videoOnly = formats.filter(f => f.hasVideo && !f.isMuxed);
  const audioOnly = formats.filter(f => !f.hasVideo && f.hasAudio);

  renderSection('muxed', muxed, title);
  renderSection('video', videoOnly, title, 'divider-video');
  renderSection('audio', audioOnly, title, 'divider-audio');
  renderFormatPicker(formats, title, pickerEls);
  renderFormatDebug(formatDebug, playerFetchDebug, formats, resolveStats);

  function showError(msg) {
    statusEl.style.display = 'none';
    errorEl.style.display  = 'block';
    errorEl.textContent    = msg;
  }
});

function isYoutubeUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch (_) {
    return false;
  }
}

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (!(u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com'))) return null;

    if (u.pathname === '/watch') {
      return normalizeVideoId(u.searchParams.get('v'));
    }

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
      return normalizeVideoId(parts[1]);
    }

    return null;
  } catch (_) {
    return null;
  }
}

function isShortsUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/shorts/');
  } catch (_) {
    return false;
  }
}

function normalizeVideoId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
}

async function fetchWatchPageGlobals(videoId) {
  const html = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    credentials: 'include'
  }).then(resp => {
    if (!resp.ok) throw new Error(`watch page failed: ${resp.status}`);
    return resp.text();
  });

  const ytcfgData = extractYtcfgData(html);
  const pr = extractInitialPlayerResponse(html);
  let jsUrl = ytcfgData.PLAYER_JS_URL || null;

  if (!jsUrl) {
    const m = html.match(/"(?:jsUrl|PLAYER_JS_URL)"\s*:\s*"([^"]+\/player\/[^"]+\.js)"/);
    if (m) jsUrl = m[1].replace(/\\\//g, '/');
  }

  if (jsUrl && jsUrl.startsWith('//')) jsUrl = 'https:' + jsUrl;
  else if (jsUrl && jsUrl.startsWith('/')) jsUrl = 'https://www.youtube.com' + jsUrl;

  return {
    playerResponse: pr ? {
      videoDetails: pr.videoDetails ? {
        title: pr.videoDetails.title,
        lengthSeconds: pr.videoDetails.lengthSeconds || null,
        isLiveContent: Boolean(pr.videoDetails.isLiveContent),
        isLive: Boolean(pr.videoDetails.isLive),
        thumbnail: pr.videoDetails.thumbnail || null
      } : null,
      streamingData: pr.streamingData
    } : null,
    playerJsUrl: jsUrl,
    innertube: {
      apiKey: ytcfgData.INNERTUBE_API_KEY || null,
      context: ytcfgData.INNERTUBE_CONTEXT || null,
      clientName: ytcfgData.INNERTUBE_CONTEXT_CLIENT_NAME || null,
      clientVersion: ytcfgData.INNERTUBE_CLIENT_VERSION || ytcfgData.INNERTUBE_CONTEXT?.client?.clientVersion || null,
      visitorData: ytcfgData.VISITOR_DATA || ytcfgData.INNERTUBE_CONTEXT?.client?.visitorData || null
    }
  };
}

function mergePageGlobals(primary = {}, fallback = {}) {
  return {
    playerResponse: primary?.playerResponse?.streamingData ? primary.playerResponse : fallback.playerResponse,
    playerJsUrl: primary?.playerJsUrl || fallback.playerJsUrl || null,
    innertube: {
      ...(fallback?.innertube || {}),
      ...(primary?.innertube || {}),
      apiKey: primary?.innertube?.apiKey || fallback?.innertube?.apiKey || null,
      context: primary?.innertube?.context || fallback?.innertube?.context || null,
      clientVersion: primary?.innertube?.clientVersion || fallback?.innertube?.clientVersion || null,
      visitorData: primary?.innertube?.visitorData || fallback?.innertube?.visitorData || null
    }
  };
}

// "(3) 動画タイトル - YouTube" → "動画タイトル"。videoDetails が無い時のタイトル復元用。
function cleanYouTubeDocTitle(docTitle) {
  if (!docTitle) return null;
  let t = String(docTitle).replace(/^\(\d+\)\s*/, '');   // 未読通知数の接頭辞
  t = t.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim();    // 末尾の " - YouTube"
  return t && t.toLowerCase() !== 'youtube' ? t : null;
}

function buildVideoInfo(playerResponse, videoId, isShorts = false) {
  const details = playerResponse?.videoDetails || {};
  const thumbnailUrl = pickBestThumbnailUrl(details.thumbnail, videoId);
  // 配信中(isLive)のみ「LIVE」。終了済みLIVE(アーカイブ)は lengthSeconds が入るので実時間を出す。
  const durationLabel = formatDurationLabel(details.lengthSeconds, details.isLive);
  return {
    title: details.title || 'video',
    thumbnailUrl,
    durationLabel,
    isShorts
  };
}

function pickBestThumbnailUrl(thumbnail, videoId) {
  const thumbs = Array.isArray(thumbnail?.thumbnails) ? thumbnail.thumbnails : [];
  const best = thumbs.reduce((acc, cur) => {
    if (!acc) return cur;
    const accScore = (acc.width || 0) * (acc.height || 0);
    const curScore = (cur.width || 0) * (cur.height || 0);
    return curScore >= accScore ? cur : acc;
  }, null);
  if (best?.url) return best.url;
  if (videoId) return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
  return '';
}

function formatDurationLabel(seconds, isLive = false) {
  if (isLive) return 'LIVE';
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '--:--';
  const s = Math.floor(total % 60);
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function checkMaintenanceStatus(el, actionsEl, pillEl) {
  if (!el && !pillEl) return;

  const bundled = await fetchJson(chrome.runtime.getURL('src/generated/ytdlp-meta.json'));
  const latest = await getLatestMaintenanceStatus();
  const notice = buildMaintenanceNotice(bundled, latest);
  if (!notice) {
    setMaintenancePill(pillEl, 'latest', '最新', '同梱ロジックは最新互換性メタと同期しています');
    return;
  }

  setMaintenancePill(pillEl, notice.pillState, notice.pillText, notice.text);
  if (el) {
    el.textContent = notice.text;
    el.className = notice.className;
    el.style.display = 'block';
  }
  if (actionsEl) actionsEl.style.display = 'grid';
}

function setMaintenancePill(el, state, text, title = '') {
  if (!el) return;
  const textEl = el.querySelector('#maintenance-pill-text');
  el.className = `maint-pill maint-${state}`;
  el.title = title;
  if (textEl) textEl.textContent = text;
}

async function getLatestMaintenanceStatus() {
  const cacheKey = 'maintenanceStatusCache';
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    const entry = cached?.[cacheKey];
    if (entry?.fetchedAt && entry?.data && Date.now() - entry.fetchedAt < MAINTENANCE_STATUS_CACHE_MS) {
      return entry.data;
    }
  } catch (_) {}

  const latest = await fetchJson(MAINTENANCE_STATUS_URL, { cache: 'no-store' });
  if (latest?.schemaVersion !== 1) {
    throw new Error('invalid maintenance status schema');
  }

  try {
    await chrome.storage.local.set({ [cacheKey]: { fetchedAt: Date.now(), data: latest } });
  } catch (_) {}

  return latest;
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
  return resp.json();
}

function buildMaintenanceNotice(bundled, latest) {
  if (!bundled || !latest) return null;

  const currentVersion = chrome.runtime.getManifest().version;
  const min = latest.minimumRecommended || {};
  const reasons = [];

  if (latest.latestExtensionVersion && compareVersionText(latest.latestExtensionVersion, currentVersion) > 0) {
    reasons.push(`拡張 v${latest.latestExtensionVersion} が利用可能です`);
  }
  if (min.ytDlpRelease && compareVersionText(min.ytDlpRelease, bundled.ytDlpRelease) > 0) {
    reasons.push(`yt-dlp互換性メタ: ${bundled.ytDlpRelease || 'unknown'} → ${min.ytDlpRelease}`);
  }
  if (min.ejsVersion && compareVersionText(min.ejsVersion, bundled.ejsVersion) > 0) {
    reasons.push(`EJS solver: ${bundled.ejsVersion || 'unknown'} → ${min.ejsVersion}`);
  }

  const severity = latest.severity || (reasons.length ? 'recommended' : 'ok');
  if (severity === 'ok' && reasons.length === 0) return null;

  const className = severity === 'critical'
    ? 'maint-critical'
    : severity === 'info' ? 'maint-info' : 'maint-warn';
  const title = severity === 'critical' ? '更新が必要です' : severity === 'info' ? 'お知らせ' : '更新を推奨します';
  const pillState = severity === 'critical' ? 'required' : severity === 'info' ? 'latest' : 'recommended';
  const pillText = severity === 'critical' ? '要更新' : severity === 'info' ? '情報' : '更新推奨';
  const syncedMessage = '現在の同梱ロジックは最新互換性メタと同期しています。';
  const message = latest.messageJa && latest.messageJa !== syncedMessage ? latest.messageJa : null;

  return {
    className,
    pillState,
    pillText,
    text: [title, ...(message ? [message] : []), ...reasons].join('\n')
  };
}

function compareVersionText(a, b) {
  const pa = String(a || '').match(/\d+/g)?.map(Number) || [];
  const pb = String(b || '').match(/\d+/g)?.map(Number) || [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function extractYtcfgData(text) {
  const data = {};
  let offset = 0;

  while (offset < text.length) {
    const idx = text.indexOf('ytcfg.set(', offset);
    if (idx === -1) break;

    const start = text.indexOf('{', idx);
    if (start === -1) break;

    const end = findJsonObjectEnd(text, start);
    if (end === -1) break;

    try {
      Object.assign(data, JSON.parse(text.slice(start, end + 1)));
    } catch (_) {}

    offset = end + 1;
  }

  return data;
}

function extractInitialPlayerResponse(text) {
  const idx = text.indexOf('ytInitialPlayerResponse');
  if (idx === -1) return null;

  const start = text.indexOf('{', idx);
  if (start === -1) return null;

  const end = findJsonObjectEnd(text, start);
  if (end === -1) return null;

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function getClientNameHeader(clientName) {
  if (Number.isFinite(Number(clientName))) return String(clientName);
  const headers = YOUTUBE_CONFIG.clientNameHeaders || {};
  if (headers[clientName]) return headers[clientName];
  return '1';
}

// yt-dlp が pot 無しで使う既定クライアント = GVS_PO_TOKEN_POLICY 未定義のもの。
// これらのソース由来の直URLは PO Token 不要で20MBの壁を越えられる。
const POT_FREE_SOURCES = new Set(YOUTUBE_CONFIG.potFreeSources || ['android_vr', 'tv', 'tv_downgraded']);
function isPotFreeSource(source) {
  return POT_FREE_SOURCES.has(source);
}

// player.js を storage.local キャッシュ付きで取得（n/sig復号に使う 2.5MB 級）。
async function getCachedPlayerJs(playerJsUrl) {
  try {
    const cached = await chrome.storage.local.get(['playerJsUrl', 'playerJs']);
    if (cached.playerJsUrl === playerJsUrl && cached.playerJs) {
      return cached.playerJs;
    }
  } catch (e) {
    console.warn('[ytdl] player.js cache read failed:', e);
  }
  const resp = await fetch(playerJsUrl);
  if (!resp.ok) throw new Error(`player.js fetch failed: ${resp.status}`);
  const text = await resp.text();
  try {
    await chrome.storage.local.set({ playerJsUrl, playerJs: text });
  } catch (e) {
    console.warn('[ytdl] player.js cache write failed:', e);
  }
  return text;
}

async function fetchInnertubePlayerResponses(videoId, innertube = {}, statusEl = null, tabId = null, pot = null) {
  const clients = buildInnertubeClients(innertube);
  const responses = [];
  const debug = { clients: [], errors: [] };
  const errors = [];

  for (const client of clients) {
    try {
      if (statusEl) statusEl.textContent = `動画フォーマットを確認中... (${client.key})`;
      const response = await fetchInnertubePlayerResponse(videoId, innertube, client, tabId, pot);
      responses.push(response);
      const resolvable = countResolvableRawFormats(response);
      debug.clients.push({
        key: client.key,
        status: response.playabilityStatus || 'OK',
        formats: countRawFormats(response),
        resolvable,
        heights: getResolvableRawVideoHeights(response)
      });
      // 先頭クライアントが解決可能な adaptive 映像を返せば以降は叩かない＝高速化。
      // progressive(itag18 360p)だけを見て打ち切ってはいけない: SABR-only 応答でも
      // itag18 は生きたまま返るので、それを成功と誤認すると 360p で頭打ちになる。
      if (hasResolvableAdaptiveVideo(response)) break;
    } catch (e) {
      errors.push(`${client.key}: ${e.message}`);
      debug.errors.push(`${client.key}: ${e.message}`);
      console.warn(`[ytdl] ${client.key} player API failed:`, e);
    }
  }

  if (responses.length === 0 && errors.length > 0) {
    throw new Error(errors.join(' / '));
  }

  console.info('[ytdl] Innertube client summary:', debug);
  return { responses, debug };
}

function buildInnertubeClients(innertube = {}) {
  const pageClient = innertube.context?.client;
  const pageContext = innertube.context || {
    client: {
      clientName: 'WEB',
      clientVersion: innertube.clientVersion || DEFAULT_WEB_CLIENT_VERSION,
      hl: 'ja',
      gl: 'JP',
      visitorData: innertube.visitorData || undefined
    }
  };

  const profiles = YOUTUBE_CONFIG.innertubeClientProfiles || [];
  if (profiles.length === 0) {
    throw new Error('YouTube client config not loaded');
  }

  return profiles.map(profile => {
    if (profile.usePageContext) {
      return {
        key: profile.key,
        context: pageContext,
        clientName: innertube.clientName || pageClient?.clientName || profile.defaultClientName || 'WEB',
        clientVersion: innertube.clientVersion || pageClient?.clientVersion || profile.defaultClientVersion || DEFAULT_WEB_CLIENT_VERSION,
        usePlayerPot: Boolean(profile.usePlayerPot)
      };
    }

    const client = { ...(profile.contextClient || {}) };
    const clientVersion = profile.clientVersionFromPage
      ? innertube.clientVersion || pageClient?.clientVersion || profile.defaultClientVersion || DEFAULT_WEB_CLIENT_VERSION
      : profile.clientVersion || client.clientVersion || DEFAULT_WEB_CLIENT_VERSION;

    client.clientVersion = clientVersion;
    if (profile.includeVisitorData) {
      client.visitorData = innertube.visitorData || undefined;
    } else if (profile.includeVisitorDataFromPage) {
      client.visitorData = innertube.visitorData || pageClient?.visitorData || undefined;
    }

    return {
      key: profile.key,
      context: { client },
      clientName: profile.clientName || client.clientName || 'WEB',
      clientVersion,
      usePlayerPot: Boolean(profile.usePlayerPot)
    };
  });
}

async function fetchInnertubePlayerResponse(videoId, innertube = {}, clientConfig, tabId = null, pot = null) {
  const apiKey = innertube?.apiKey || DEFAULT_INNERTUBE_API_KEY;

  const context = clientConfig.context;
  const client = context.client || {};

  const sts = innertube?.sts || null;
  const visitorData = innertube?.visitorData || client.visitorData || null;

  let data;
  if (tabId) {
    data = await fetchInnertubePlayerInPage(tabId, videoId, apiKey, clientConfig, getClientNameHeader(clientConfig.clientName || client.clientName), pot, sts, visitorData);
  } else {
    data = await fetchInnertubePlayerFromExtension(videoId, apiKey, clientConfig, context, client, pot, sts, visitorData);
  }

  if (!data?.streamingData) {
    throw new Error(data?.playabilityStatus?.reason || data?.error || 'streamingData not found');
  }

  return markPlayerResponseSource({
    playabilityStatus: data.playabilityStatus?.status || 'OK',
    videoDetails: data.videoDetails ? {
      title: data.videoDetails.title,
      lengthSeconds: data.videoDetails.lengthSeconds || null,
      isLiveContent: Boolean(data.videoDetails.isLiveContent),
      isLive: Boolean(data.videoDetails.isLive),
      thumbnail: data.videoDetails.thumbnail || null
    } : null,
    streamingData: data.streamingData
  }, clientConfig.key);
}

async function fetchInnertubePlayerInPage(tabId, videoId, apiKey, clientConfig, clientNameHeader, pot = null, sts = null, visitorData = null) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [videoId, apiKey, clientConfig, clientNameHeader, pot, sts, visitorData],
    func: async (videoId, apiKey, clientConfig, clientNameHeader, pot, sts, visitorData) => {
      const context = clientConfig.context;
      const client = context.client || {};

      try {
        const reqBody = { context, videoId, contentCheckOk: true, racyCheckOk: true };
        // JSプレーヤー系クライアント(TVHTML5/WEB)は signatureTimestamp 必須 → playbackContext を付与
        reqBody.playbackContext = {
          contentPlaybackContext: Object.assign(
            { html5Preference: 'HTML5_PREF_WANTS' },
            sts ? { signatureTimestamp: sts } : {}
          )
        };
        // WebPO クライアント(tv等)には player pot を付与 → bot検問突破＆GVS pot不要化
        if (pot && clientConfig.usePlayerPot) {
          reqBody.serviceIntegrityDimensions = { poToken: pot };
        }
        const headers = {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(clientNameHeader),
          'X-YouTube-Client-Version': String(clientConfig.clientVersion || client.clientVersion || '')
        };
        if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
        const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(reqBody)
        });

        const text = await resp.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {}

        if (!resp.ok) {
          return {
            error: `Innertube player failed in page: ${resp.status}`,
            playabilityStatus: data?.playabilityStatus || null
          };
        }

        return data || { error: 'empty Innertube response' };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    }
  });

  const data = result?.result;
  if (data?.error) throw new Error(data.error);
  return data;
}

async function fetchInnertubePlayerFromExtension(videoId, apiKey, clientConfig, context, client, pot = null, sts = null, visitorData = null) {
  const reqBody = { context, videoId, contentCheckOk: true, racyCheckOk: true };
  reqBody.playbackContext = {
    contentPlaybackContext: Object.assign(
      { html5Preference: 'HTML5_PREF_WANTS' },
      sts ? { signatureTimestamp: sts } : {}
    )
  };
  if (pot && clientConfig.usePlayerPot) {
    reqBody.serviceIntegrityDimensions = { poToken: pot };
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': getClientNameHeader(clientConfig.clientName || client.clientName),
    'X-YouTube-Client-Version': String(clientConfig.clientVersion || client.clientVersion || '')
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(reqBody)
  });

  if (!resp.ok) {
    throw new Error(`Innertube player failed: ${resp.status}`);
  }

  return resp.json();
}

function pickBestPlayerResponse(responses) {
  const valid = responses.filter(r => r?.streamingData);
  if (valid.length === 0) return null;

  const best = valid.reduce((a, b) => countRawFormats(b) > countRawFormats(a) ? b : a);
  const mergedFormats = dedupeRawFormats(valid.flatMap(r => r.streamingData.formats ?? []));
  const mergedAdaptiveFormats = dedupeRawFormats(valid.flatMap(r => r.streamingData.adaptiveFormats ?? []));
  const details = valid.find(r => r.videoDetails?.title)?.videoDetails || best.videoDetails || null;

  return {
    videoDetails: details,
    streamingData: {
      ...best.streamingData,
      formats: mergedFormats,
      adaptiveFormats: mergedAdaptiveFormats
    }
  };
}

function markPlayerResponseSource(response, source) {
  if (!response?.streamingData) return response;

  return {
    ...response,
    source,
    streamingData: {
      ...response.streamingData,
      formats: (response.streamingData.formats ?? []).map(fmt => ({ ...fmt, source })),
      adaptiveFormats: (response.streamingData.adaptiveFormats ?? []).map(fmt => ({ ...fmt, source }))
    }
  };
}

function countRawFormats(response) {
  const sd = response?.streamingData;
  return (sd?.formats?.length ?? 0) + (sd?.adaptiveFormats?.length ?? 0);
}

function countResolvableRawFormats(response) {
  const sd = response?.streamingData;
  return [...(sd?.formats ?? []), ...(sd?.adaptiveFormats ?? [])]
    .filter(canResolveRawFormat)
    .length;
}

function getResolvableRawVideoHeights(response) {
  const sd = response?.streamingData;
  return [...new Set([...(sd?.formats ?? []), ...(sd?.adaptiveFormats ?? [])]
    .filter(canResolveRawFormat)
    .filter(fmt => fmt.height || fmt.qualityLabel)
    .map(fmt => fmt.qualityLabel || `${fmt.height}p`))]
    .sort(compareQualityText);
}

function canResolveRawFormat(fmt) {
  return Boolean(fmt.url || fmt.signatureCipher || fmt.cipher);
}

// SABR-only 応答の判別に使う。YouTube は adaptiveFormats を url も signatureCipher も無い
// メタデータだけの形(=serverAbrStreamingUrl 経由でしか再生できない)で返すことがあり、
// その場合でも progressive の itag18 だけは解決可能なまま返ってくる。
function hasResolvableAdaptiveVideo(response) {
  const sd = response?.streamingData;
  return (sd?.adaptiveFormats ?? []).some(fmt =>
    canResolveRawFormat(fmt) && (fmt.height || /^video\//.test(fmt.mimeType || '')));
}

function dedupeRawFormats(formats) {
  const byKey = new Map();

  for (const fmt of formats) {
    const key = [
      fmt.itag,
      fmt.mimeType,
      fmt.qualityLabel,
      fmt.height,
      fmt.fps,
      fmt.audioQuality,
      fmt.audioTrack?.id ?? '',   // 言語トラックを別物として扱う（吹替/オリジナル）
      fmt.isDrc ? 'drc' : ''
    ].join(':');
    const current = byKey.get(key);

    if (!current || rawFormatScore(fmt) > rawFormatScore(current)) {
      byKey.set(key, fmt);
    }
  }

  return [...byKey.values()];
}

function rawFormatScore(fmt) {
  return (isPotFreeSource(fmt.source) ? 32 : 0)   // pot不要ソースの直URLを最優先（20MBの壁回避）
    + (fmt.url ? 8 : 0)
    + (fmt.signatureCipher || fmt.cipher ? 4 : 0)
    + (fmt.contentLength ? 2 : 0)
    + (fmt.bitrate ? 1 : 0);
}

// ─── render ───────────────────────────────────────────────────────────────────

function renderSection(id, formats, videoTitle, dividerId) {
  if (formats.length === 0) return;

  document.getElementById(`section-${id}`).style.display = 'block';
  if (dividerId) document.getElementById(dividerId).style.display = 'block';

  formats.sort(compareFormats);

  const list = document.getElementById(`list-${id}`);
  for (const fmt of formats) {
    list.appendChild(buildItem(fmt, videoTitle));
  }
}

function renderFormatPicker(formats, videoTitle, els) {
  const videoFormats = formats.filter(fmt => fmt.hasVideo).sort(compareFormats);
  const audioFormats = formats.filter(fmt => !fmt.hasVideo && fmt.hasAudio).sort(compareAudioFormats);
  if (videoFormats.length === 0 && audioFormats.length === 0) return;

  fillSelect(els.resolutionSelect, buildFilterOptions(videoFormats, fmt => fmt.height ? `${fmt.height}p` : 'unknown'), '解像度すべて');
  fillSelect(els.fpsSelect, buildFilterOptions(videoFormats, fmt => fmt.fps ? `${fmt.fps}fps` : 'fps不明'), 'FPSすべて');
  fillSelect(els.extSelect, buildFilterOptions(videoFormats, fmt => fmt.ext.toUpperCase()), '拡張子すべて');

  const updateVideoOptions = () => {
    const selectedValue = els.videoSelect.value;
    const filtered = videoFormats.filter(fmt =>
      matchesFilter(els.resolutionSelect.value, fmt.height ? `${fmt.height}p` : 'unknown') &&
      matchesFilter(els.fpsSelect.value, fmt.fps ? `${fmt.fps}fps` : 'fps不明') &&
      matchesFilter(els.extSelect.value, fmt.ext.toUpperCase())
    );

    fillFormatSelect(els.videoSelect, filtered, formatVideoOption);
    if ([...els.videoSelect.options].some(opt => opt.value === selectedValue)) {
      els.videoSelect.value = selectedValue;
    }
    updatePickerState();
  };

  const updatePickerState = () => {
    const video = getSelectedFormat(els.videoSelect);
    const audio = getSelectedFormat(els.audioSelect);

    els.downloadVideo.disabled = !video;
    els.downloadAudio.disabled = !audio;
    els.downloadPair.disabled = !video && !audio;
    if (els.downloadMux) els.downloadMux.disabled = !(video && audio) || !!video.isMuxed;

    if (!els.qualityNote) return;

    const notes = [];
    if (video?.hasVideo && !video.isMuxed) {
      notes.push('選択中の高画質映像は音声なしです。音声DLまたは両方DLで音声ファイルも保存できます。');
    }
    if (video?.isMuxed) {
      notes.push('選択中の映像は音声込みです。別音声を選ぶ必要はありません。');
    }
    if (highestVideoHeight(formats) <= 360) {
      notes.push('この取得経路では360pまでしか返っていません。YouTube側の制限、PO Token、またはHLS/SABR配信のみの可能性があります。');
    }

    els.qualityNote.textContent = notes.join('\n');
    els.qualityNote.style.display = notes.length ? 'block' : 'none';
  };

  fillFormatSelect(els.audioSelect, audioFormats, formatAudioOption);
  updateVideoOptions();

  // 大容量muxの「2段階確認」状態。フォーマット/トリム選択を変えたらリセットする。
  let muxArmed = false;
  const resetMuxArm = () => {
    if (!muxArmed) return;
    muxArmed = false;
    if (els.downloadMux) els.downloadMux.textContent = '映像+音声を合成して保存';
    clearMuxProgress();
  };

  els.resolutionSelect.addEventListener('change', () => { resetMuxArm(); updateVideoOptions(); });
  els.fpsSelect.addEventListener('change', () => { resetMuxArm(); updateVideoOptions(); });
  els.extSelect.addEventListener('change', () => { resetMuxArm(); updateVideoOptions(); });
  els.videoSelect.addEventListener('change', () => { resetMuxArm(); updatePickerState(); });
  els.audioSelect.addEventListener('change', () => { resetMuxArm(); updatePickerState(); });

  els.downloadVideo.addEventListener('click', () => {
    const video = getSelectedFormat(els.videoSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    if (video) startDownload([{ kind: 'single', fmt: video, dlKind: video.isMuxed ? 'muxed' : 'video', trim }], videoTitle);
  });

  els.downloadAudio.addEventListener('click', () => {
    const audio = getSelectedFormat(els.audioSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    if (audio) startDownload([{ kind: 'single', fmt: audio, dlKind: 'audio', trim }], videoTitle);
  });

  els.downloadPair.addEventListener('click', () => {
    const video = getSelectedFormat(els.videoSelect);
    const audio = getSelectedFormat(els.audioSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    const items = [];
    if (video) items.push({ kind: 'single', fmt: video, dlKind: video.isMuxed ? 'muxed' : 'video', trim });
    if (audio && !video?.isMuxed) items.push({ kind: 'single', fmt: audio, dlKind: 'audio', trim });
    if (items.length) startDownload(items, videoTitle);
  });

  els.downloadMux.addEventListener('click', () => {
    const video = getSelectedFormat(els.videoSelect);
    const audio = getSelectedFormat(els.audioSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    if (!video || !audio) { showPickerMessage('映像と音声の両方を選択してください', 'error'); return; }
    if (video.isMuxed) { showPickerMessage('選択中の映像は既に音声込みです。合成は不要です。', 'error'); return; }

    // 大容量はffmpeg.wasmがOOMしやすい。だが alert/confirm はpopupを閉じてDL自体を不能にするので、
    // ブロッキングしないインライン2段階確認にする（1回目=警告表示, 2回目=実行）。
    const estTotal = (video.contentLength || 0) + (audio.contentLength || 0);
    if (estTotal > MUX_SOFT_LIMIT && !muxArmed) {
      const mb = Math.round(estTotal / 1024 / 1024);
      muxArmed = true;
      els.downloadMux.textContent = `それでも合成して保存（約${mb}MB）`;
      showPickerMessage(
        `⚠ 合計約${mb}MB。ブラウザのメモリ上限で合成が失敗する可能性があります。\n` +
        `映像/音声を個別にDLするか、低い解像度を推奨。もう一度押すと合成を試みます。`,
        'warn'
      );
      return;
    }
    muxArmed = false;
    els.downloadMux.textContent = '映像+音声を合成して保存';
    clearMuxProgress();
    startDownload([{ kind: 'mux', video, audio, trim }], videoTitle);
  });

  els.qualityPicker.style.display = 'grid';
  updatePickerState();
}

function fillSelect(select, options, allLabel) {
  select.replaceChildren();
  select.appendChild(new Option(allLabel, '__all__'));
  for (const option of options) {
    select.appendChild(new Option(option, option));
  }
}

function fillFormatSelect(select, formats, labelBuilder) {
  select.replaceChildren();
  formats.forEach((fmt, index) => {
    const opt = new Option(labelBuilder(fmt), String(index));
    opt._format = fmt;
    select.appendChild(opt);
  });
}

function buildFilterOptions(formats, mapper) {
  return [...new Set(formats.map(mapper))]
    .sort(compareFilterText);
}

function matchesFilter(selected, value) {
  return selected === '__all__' || selected === value;
}

function getSelectedFormat(select) {
  return select.selectedOptions[0]?._format ?? null;
}

// content.js がページ側で指定した切り出し範囲を入力欄に反映する。
// 保存されているのは表示テキストそのものなので、手入力した場合と同じ経路で解釈される。
async function applyTrimDraft(els, videoId) {
  try {
    const stored = await chrome.storage.local.get('trimDraft');
    const draft = stored?.trimDraft;
    if (!draft || draft.videoId !== videoId) return;
    if (draft.startText && els.trimStart) els.trimStart.value = draft.startText;
    if (draft.endText && els.trimEnd) els.trimEnd.value = draft.endText;
  } catch (e) {
    console.info('[ytdl] trim draft not applied:', e?.message || e);
  }
}

function getTrimRangeFromInputs(els) {
  const rangeRaw = els.trimRange?.value?.trim() || '';
  const rangeParts = rangeRaw ? parseTrimRangeText(rangeRaw) : null;
  if (rangeRaw && !rangeParts) {
    showPickerMessage('切り出し範囲は 5-10、0:05~0:10、1:02:03-1:03:00 の形式で入力してください', 'error');
    return false;
  }

  const startRaw = rangeParts ? rangeParts.start : (els.trimStart?.value?.trim() || '');
  const endRaw = rangeParts ? rangeParts.end : (els.trimEnd?.value?.trim() || '');
  if (!startRaw && !endRaw) return null;

  const start = startRaw ? parseTimeInput(startRaw) : 0;
  const end = endRaw ? parseTimeInput(endRaw) : null;
  if (start == null || (end == null && endRaw)) {
    showPickerMessage('切り出し範囲は 0:05 または 1:02:03 の形式で入力してください', 'error');
    return false;
  }
  if (end != null && end <= start) {
    showPickerMessage('切り出し終了時刻は開始時刻より後にしてください', 'error');
    return false;
  }
  return {
    start,
    end,
    startText: formatSecondsForFfmpeg(start),
    endText: end == null ? null : formatSecondsForFfmpeg(end),
    durationText: end == null ? null : formatSecondsForFfmpeg(end - start)
  };
}

function parseTrimRangeText(value) {
  const normalized = value
    .replace(/[〜～~]/g, '-')
    .replace(/[–—]/g, '-')
    .trim();
  const match = normalized.match(/^(.+?)(?:\s*-\s*|\s+to\s+|\s+)(.+)$/i);
  if (!match) return null;
  return { start: match[1].trim(), end: match[2].trim() };
}

function parseTimeInput(value) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+(?:\.\d+)?$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}

function formatSecondsForFfmpeg(value) {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value - hours * 3600 - minutes * 60;
  const secText = seconds % 1 === 0
    ? String(seconds).padStart(2, '0')
    : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').padStart(2, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secText}`;
}

function trimSuffix(trim) {
  if (!trim) return '';
  const start = formatSecondsForFilename(trim.start);
  const end = trim.end == null ? 'end' : formatSecondsForFilename(trim.end);
  return `_clip_${start}-${end}`;
}

function formatSecondsForFilename(value) {
  return formatSecondsForFfmpeg(value).replace(/:/g, '-').replace(/\./g, '_');
}

function formatVideoOption(fmt) {
  const parts = [fmt.quality, formatKind(fmt), buildMeta(fmt)];
  return parts.filter(Boolean).join(' / ');
}

// YouTube はオートダビング等で1動画に複数言語の音声トラックを持つ。
// オリジナル音声を見分けるため audioTrack と URL の xtags(acont) を解析する。
// acont は locale 非依存の信号: original / dubbed-auto / dubbed / descriptive
function parseAudioMeta(rawFmt, resolvedUrl) {
  const at = rawFmt.audioTrack || {};
  const displayName = at.displayName || '';
  const language = (at.id || '').split('.')[0] || null;

  let acont = null;
  try {
    const xtags = new URL(resolvedUrl).searchParams.get('xtags');
    const m = xtags && /(?:^|[:&;,])acont=([^:&;,]+)/.exec(xtags);
    if (m) acont = m[1];
  } catch (_) {}

  const dn = displayName.toLowerCase();
  const isDescriptive = acont === 'descriptive' || dn.includes('descriptive');
  const isOriginalAudio = acont === 'original' || (!acont && dn.includes('original'));
  const isDubbed = /^dubbed/.test(acont || '') || (!isOriginalAudio && !isDescriptive && /dub/.test(dn));

  return {
    audioTrackId: at.id || null,
    audioTrackName: displayName || null,
    language,
    audioContent: acont,
    isOriginalAudio,
    isDefaultAudio: !!at.audioIsDefault,
    isDescriptive,
    isDubbed,
  };
}

// 並び順の優先度（大きいほど上）: オリジナル > 通常 > デフォルト吹替 > 自動吹替 > 説明音声
function audioTrackRank(fmt) {
  if (fmt.isDescriptive) return -10;
  if (fmt.isOriginalAudio) return 10;
  if (fmt.isDubbed) return fmt.isDefaultAudio ? -1 : -2;
  return 0;
}

function audioTrackLabel(fmt) {
  if (!fmt.audioTrackName && !fmt.language) return '';
  let tag = fmt.audioTrackName || fmt.language || '';
  if (fmt.isOriginalAudio) tag += ' [原]';
  else if (fmt.isDescriptive) tag += ' [説明]';
  else if (fmt.isDubbed) tag += ' [吹替]';
  return tag.trim();
}

function formatAudioOption(fmt) {
  const label = fmt.quality || 'audio';
  const track = audioTrackLabel(fmt);
  return [track, label, buildMeta(fmt)].filter(Boolean).join(' / ');
}

// ─── ダウンロードのウィンドウ委譲（popup を閉じても継続させる）────────────────────
// MV3 のツールバー popup はフォーカスを失うと閉じ、実行中のJS(チャンクDL/合成)が中断する。
// そこで「直DL以外」は独立ウィンドウ(popup.html?job=ID, type:'popup')に処理を移す。
// 直DL(chrome.downloads で素のURL)はブラウザのDLマネージャが継続するのでその場で実行。

function isDirectItem(item) {
  return item.kind === 'single' && item.fmt.isMuxed && !item.trim;
}

function startDownload(items, videoTitle) {
  if (items.every(isDirectItem)) {
    // 全て直DL（ブラウザが継続管理）→ ウィンドウ不要、その場で実行
    for (const it of items) downloadFormat(it.fmt, videoTitle, it.dlKind, it.trim);
    return;
  }
  dispatchDownloadJob({ items, videoTitle });
}

async function dispatchDownloadJob(job) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  job.ctx = { tabId: _tabId, videoId: _videoId, visitorData: _visitorData };
  try {
    await chrome.storage.session.set({ ['ochaJob:' + id]: job });
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/popup.html') + '?job=' + id,
      type: 'popup',
      width: 480,
      height: 280,
      focused: true
    });
  } catch (e) {
    // ウィンドウを開けない環境ではその場で実行（旧挙動: popupを閉じると中断）
    console.warn('[ytdl] download window dispatch failed, running inline:', e);
    runJobItems(job.items, job.videoTitle).catch(err => {
      console.warn('[ytdl] inline job failed:', err);
      showPickerMessage(`ダウンロードに失敗しました: ${err && err.message || err}`, 'error');
    });
  }
}

async function runJobItems(items, videoTitle) {
  let lastError = null;
  for (const it of items) {
    try {
      if (it.kind === 'mux') {
        await muxAndDownload(it.video, it.audio, videoTitle, {}, it.trim);
      } else {
        await downloadFormat(it.fmt, videoTitle, it.dlKind, it.trim);
      }
    } catch (e) {
      lastError = e; // 各関数内で既に通知済み。残りのitemは続行する
    }
  }
  if (lastError) throw lastError;
}

// ダウンロード専用ウィンドウ(?job=ID)の本体
async function runDownloadWorker(jobId) {
  const key = 'ochaJob:' + jobId;
  const statusEl = document.getElementById('status');
  // このウィンドウは進捗を見せるためだけに開く。ブランドも版もメンテ表示も要らない。
  // 残すのは「今なにをしているか」と進捗バーだけ。
  document.querySelector('.hero')?.style.setProperty('display', 'none');
  document.querySelector('header')?.style.setProperty('display', 'none');
  const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  ['maintenance-pill', 'nsig-status', 'pot-status', 'maintenance-status', 'maintenance-actions', 'quality-picker', 'format-debug', 'quality-note'].forEach(hide);
  document.body.classList.add('worker');

  let job = null;
  try {
    const stored = await chrome.storage.session.get(key);
    job = stored[key];
    chrome.storage.session.remove(key);
  } catch (_) {}

  if (!job || !Array.isArray(job.items)) {
    if (statusEl) statusEl.textContent = 'ダウンロードジョブが見つかりませんでした';
    return;
  }

  _tabId = job.ctx?.tabId ?? null;
  _videoId = job.ctx?.videoId ?? null;
  _visitorData = job.ctx?.visitorData ?? null;

  // ワーカーは拡張ページなので YouTube の --yt-spec-* も <html dark> も見えない。
  // どちらのテーマかはページ側が job に入れて渡してくる。
  if (job.theme) document.documentElement.setAttribute('data-yt-theme', job.theme);

  if (statusEl) statusEl.textContent = job.videoTitle || 'ダウンロード';
  document.title = (job.videoTitle || 'download').slice(0, 60);

  const bar = document.getElementById('job-progress');
  if (bar) { bar.style.display = 'block'; bar.classList.add('indeterminate'); }

  try {
    await runJobItems(job.items, job.videoTitle);
    if (bar) { bar.classList.remove('indeterminate'); bar.firstElementChild.style.width = '100%'; }
    setMuxProgress('✓ 完了。まもなく閉じます');
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    if (bar) bar.style.display = 'none';
    clearMuxProgress();
    if (statusEl) statusEl.textContent = '失敗: ' + (e && e.message || e) + '（このウィンドウは自動で閉じます）';
    // 失敗時もウィンドウを放置しない（理由を読めるよう長めの猶予）。手動でも閉じられる。
    setTimeout(() => window.close(), 12000);
  }
}

// blob を保存し、DL完了まで待つ（成功で resolve、失敗は理由付きで reject）。
// ワーカーウィンドウは完了まで開いたまま＝blob URL が有効なうちに確実に書き込まれる。
function saveBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(blob);
    let settled = false;
    let downloadId = null;

    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 8000);
      if (ok) resolve(true);
      else reject(new Error(reason || '保存に失敗しました'));
    };

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') done(true);
      else if (delta.state.current === 'interrupted') done(false, '保存中断: ' + (delta.error?.current || '不明'));
    }

    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id == null) {
        done(false, chrome.runtime.lastError?.message || 'downloads API エラー');
        return;
      }
      downloadId = id;
      chrome.downloads.onChanged.addListener(onChanged);
      // レース対策: onChanged 登録前に完了/中断していた場合を拾う
      chrome.downloads.search({ id }, (items) => {
        const it = items && items[0];
        if (it?.state === 'complete') done(true);
        else if (it?.state === 'interrupted') done(false, '保存中断: ' + (it.error || '不明'));
      });
    });
  });
}

async function downloadFormat(fmt, videoTitle, kind, trim = null) {
  try {
    const filename = buildFilename(videoTitle, fmt, kind, trim);

    // progressive/muxed (itag18 等) は素のGETに応答するので直DLでOK
    if (fmt.isMuxed && !trim) {
      chrome.downloads.download({ url: fmt.url, filename, saveAs: false }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[ytdl] Download failed:', chrome.runtime.lastError.message, fmt);
        }
      });
      return;
    }

    // adaptive(DASH) は部分レンジ必須（Rangeなし or 全体レンジは403）→ チャンクDL
    const label = kind === 'audio' ? '音声' : '映像';
    setMuxProgress(`${label}をダウンロード中...（ウィンドウを閉じないでください）`);
    const bytes = await fetchFormatBytes(fmt, p => setMuxProgress(`${label}DL中... ${p}%（閉じないで）`));
    const outputBytes = trim
      ? await trimSingleStream(bytes, fmt, trim)
      : bytes;
    setMuxProgress('保存中...');

    const blob = new Blob([outputBytes], { type: fmt.mimeType || 'application/octet-stream' });
    await saveBlob(blob, filename);
    clearMuxProgress();
  } catch (e) {
    clearMuxProgress();
    console.warn('[ytdl] Download failed:', e, fmt);
    throw e; // 失敗はワーカーウィンドウのステータスに表示される
  }
}

// ─── chunked range download ─────────────────────────────────────────────────
// gvs の adaptive URL は「厳密な部分レンジ」のみ200を返す。Rangeなしも全体レンジも403。
// yt-dlp と同じく URL末尾に &range=START-END を付けた10MBチャンクで取得する。
// 403/429 はレート制限なので、リクエストを増やさず指数バックオフで再試行する
// （以前の「半分割リトライ」はリクエスト数を増やして制限を悪化させるため廃止）。

// PO Token 取得の唯一の差し替え点。
// これが無いと pot必須クライアントの adaptive は20MB以降が403になる。
//
// 【将来】自前サーバで pot provider を動かす場合は POT_PROVIDER_URL を設定するだけ。
//   サーバは content_binding(visitorData) を受け取り {po_token} を返す
//   （bgutil-ytdlp-pot-provider 互換のJSON）。
// 【現状】ページが生成した pot を background.js が横取りして storage.session に保存。
const POT_PROVIDER_URL = YOUTUBE_CONFIG.potProviderUrl || null; // 例: 'https://your-server.example/get_pot'

let _pot = null;
let _visitorData = null;
let _videoId = null;
let _tabId = null;
let _lastPotError = null; // 直近のPO Token生成失敗理由（UIに表示する）

let _potPromise = null;
function ensurePot() {
  if (_pot) return Promise.resolve(_pot);
  if (_potPromise) return _potPromise; // 並列DL中の多重生成を防ぐ
  _potPromise = _ensurePotOnce().finally(() => { _potPromise = null; });
  return _potPromise;
}

async function _ensurePotOnce() {
  if (_pot) return _pot;

  // 1) 将来: 自前サーバの pot provider
  if (POT_PROVIDER_URL) {
    try {
      const r = await fetch(POT_PROVIDER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_binding: _visitorData })
      });
      const j = await r.json();
      if (j && j.po_token) { _pot = j.po_token; return _pot; }
    } catch (e) {
      console.warn('[ytdl] pot provider failed:', e);
    }
  }

  // この _pot は GVS(googlevideo) ダウンロードURLに &pot= として付ける用途。
  // GVS pot は visitorData にバインドされている必要がある（video_id バインドは player pot 用）。

  // 2) 本命: ページが実再生で使った GVS pot を background.js が横取り保存したもの。
  //    visitorData バインドの正真正銘の GVS pot なので最も確実（要・動画を数秒再生）。
  try {
    const { gvsPot } = await chrome.storage.session.get('gvsPot');
    if (gvsPot) { _pot = gvsPot; return _pot; }
  } catch (_) {}

  // 3) フォールバック: ブラウザ内で WebPO を生成（住宅IP・BotGuardの最適環境）。
  //    GVS 用なので visitorData にバインド（POT_PROVIDER の content_binding と同じ）。
  try {
    const t = await generatePoTokenInBrowser(_visitorData || _videoId || '');
    if (t) { _pot = t; return _pot; }
  } catch (e) {
    console.warn('[ytdl] in-browser pot generation failed:', e);
  }

  return _pot;
}

// ─── in-browser PO Token 生成（bgutils-js を youtube.com ページの MAIN world で実行）──
// sandbox だと BotGuard が「本物のブラウザでない」と判断して WebPO を出さない(PMD:Undefined)。
// 本物の youtube.com ページ上(MAIN world)で実行すると、正しい環境・Cookie・Origin になり、
// fetch も youtube origin 直なのでプロキシ不要・CORS問題も無い。
// 唯一の懸念は MAIN world での new Function(eval) がページCSPに弾かれないか（弾かれたらエラーで判明）。

async function generatePoTokenInBrowser(identifier) {
  if (!_tabId) { _lastPotError = 'tabId 無し'; return null; }
  try {
    // 1) bgutils を MAIN world に注入（window.BG を立てる）
    await chrome.scripting.executeScript({
      target: { tabId: _tabId },
      world: 'MAIN',
      files: ['vendor/bgutils/bgutils.js']
    });

    // 2) MAIN world で WebPO を生成
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: _tabId },
      world: 'MAIN',
      args: ['O43z0dpjhgX20SCx4KAo', identifier || ''],
      func: async (requestKey, identifier) => {
        try {
          if (!window.BG) return { error: 'bgutils未ロード(window.BG無し)' };
          const bgConfig = {
            requestKey,
            fetch: (u, o) => fetch(u, o),
            globalObj: window,
            identifier
          };
          const challenge = await window.BG.Challenge.create(bgConfig);
          if (!challenge) return { error: 'challenge取得失敗' };
          const js = challenge.interpreterJavascript
            && challenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
          if (!js) return { error: 'interpreter無し' };
          // YouTube は Trusted Types を強制 → 文字列の eval/Function は弾かれる。
          // default ポリシーを作れれば全 sink が透過する（VM内部の eval も含め最強）。
          // 作れなければ named ポリシーで TrustedScript を作り eval に渡す。
          let toScript = (s) => s;
          let policyKind = 'none';
          try {
            if (window.trustedTypes && window.trustedTypes.createPolicy) {
              let pol;
              try {
                pol = window.trustedTypes.createPolicy('default', { createScript: (s) => s, createScriptURL: (s) => s });
                policyKind = 'default';
              } catch (_) {
                pol = window.trustedTypes.createPolicy('ocha-bg-' + Math.random().toString(36).slice(2), { createScript: (s) => s });
                policyKind = 'named';
              }
              toScript = (s) => pol.createScript(s);
            }
          } catch (e) {
            return { error: 'TTポリシー作成不可: ' + (e && e.message || e) };
          }
          try {
            (0, eval)(toScript(js));
          } catch (e) {
            return { error: `eval失敗(policy=${policyKind}): ` + (e && e.message || e) };
          }
          const r = await window.BG.PoToken.generate({
            program: challenge.program,
            globalName: challenge.globalName,
            bgConfig
          });
          return { poToken: r.poToken };
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      }
    });

    const out = res && res.result;
    if (out && out.poToken) return out.poToken;
    _lastPotError = ((out && out.error) || '不明') + ' [page]';
    return null;
  } catch (e) {
    _lastPotError = 'executeScript失敗: ' + (e && e.message || e);
    return null;
  }
}

function rangedUrl(url, start, end) {
  let u = url + (url.includes('?') ? '&' : '?') + `range=${start}-${end}`;
  if (_pot && !/[?&]pot=/.test(u)) u += '&pot=' + encodeURIComponent(_pot);
  return u;
}

const POT_FREE_LIMIT = 20 * 1024 * 1024; // pot無しで取得できる先頭バイト数

async function fetchFormatBytes(fmt, onProgress) {
  const total = fmt.contentLength || null;

  // pot不要ソース(tv等)は20MBの壁なし＝そのままDL。pot必須ソース(iOS等)は
  // WebPO pot が効かないので、20MB超なら pot不要の画質(tv)を選ぶよう促す。
  if (!fmt.potFree && total && total > POT_FREE_LIMIT) {
    throw new Error('この画質はPO Token必須クライアント由来でフルDLできません。別の画質（tv由来）を選んでください');
  }

  if (!total) {
    const r = await fetch(fmt.url);
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  const chunkSize = Math.min(RANGE_CHUNK_SIZE, Math.max(1, Math.ceil(total / 2)));

  // チャンク範囲を列挙し、複数同時に取得して高速化（ブラウザ同様の並列接続）。
  const ranges = [];
  for (let start = 0; start < total; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize, total) - 1]);
  }

  const out = new Uint8Array(total);
  let done = 0;
  let next = 0;
  const CONCURRENCY = Math.min(4, ranges.length);

  async function worker() {
    while (next < ranges.length) {
      const [s, e] = ranges[next++];
      const part = await fetchRange(fmt.url, s, e, fmt);
      out.set(part, s);
      done += part.length;
      if (onProgress) onProgress(Math.floor((done / total) * 100));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (done !== total) throw new Error(`サイズ不一致: ${done}/${total}`);
  return out;
}

async function fetchRange(url, start, end, fmt) {
  const backoffs = [0, 1000, 3000, 7000, 15000]; // 各試行前の待機(ms)
  let lastStatus = 0;
  let triedPot = false;

  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await delay(backoffs[attempt]);
    let r;
    try {
      r = await fetch(rangedUrl(url, start, end)); // _pot があれば &pot= が付く
    } catch (e) {
      lastStatus = -1;
      continue;
    }

    if (r.status === 200 || r.status === 206) {
      const ct = r.headers.get('content-type') || '';
      if (!isExpectedMediaType(ct, fmt)) throw new Error(`想定外のContent-Type: ${ct || 'unknown'}`);
      return new Uint8Array(await r.arrayBuffer());
    }

    lastStatus = r.status;

    // 20MB超で403かつ未だpot未取得なら「必要になった時だけ」遅延生成して即再試行
    if (r.status === 403 && start >= POT_FREE_LIMIT && !_pot && !triedPot) {
      triedPot = true;
      setMuxProgress('PO Tokenを生成中...');
      await ensurePot();
      clearMuxProgress();
      if (_pot) { attempt--; continue; } // potを付けてこのチャンクを再試行（試行数は消費しない）
    }

    if (r.status !== 403 && r.status !== 429 && r.status < 500) break; // 恒久的エラーは即中断
  }

  let hint = '';
  if (lastStatus === 403 && start >= POT_FREE_LIMIT) {
    hint = _pot
      ? '（PO Tokenが無効/期限切れの可能性。YouTube動画を再生し直してから再試行してください）'
      : '（PO Tokenが必要です。YouTube動画を数秒再生してから再試行してください）';
  } else if (lastStatus === 403 || lastStatus === 429) {
    hint = '（レート制限の可能性。数分待つか解像度を下げて再試行してください）';
  }
  throw new Error(`レンジ取得失敗 ${start}-${end}: HTTP ${lastStatus}${hint}`);
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ─── mux (ffmpeg.wasm via sandbox) ──────────────────────────────────────────

let _wasmBinary = null;

async function getWasmBinary() {
  if (_wasmBinary) return _wasmBinary;
  const r = await fetch(chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'));
  if (!r.ok) throw new Error('ffmpeg-core.wasm の読み込みに失敗');
  _wasmBinary = await r.arrayBuffer();
  return _wasmBinary;
}

function muxerHandshake() {
  const iframe = document.getElementById('muxer-iframe');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      window.removeEventListener('message', onMsg);
      reject(new Error('合成サンドボックスの起動に失敗しました'));
    }, 5000);
    const interval = setInterval(() => {
      iframe?.contentWindow?.postMessage({ action: 'ping' }, '*');
    }, 50);
    function onMsg(e) {
      if (e.data && e.data.action === 'pong') {
        clearInterval(interval);
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        resolve({ coreReady: !!e.data.coreReady, iframe });
      }
    }
    window.addEventListener('message', onMsg);
  });
}

// muxer サンドボックス(ffmpeg.wasm)へのタスク送信を共通化。
// buildMessage(reqId) が postMessage 本体を返す。transfer は転送する ArrayBuffer 群。
async function runMuxerTask(buildMessage, transfer, progressLabel) {
  const { coreReady, iframe } = await muxerHandshake();
  const wasmBinary = coreReady ? null : await getWasmBinary();
  const reqId = 'mtask_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      reject(new Error(`${progressLabel}タイムアウト（5分）`));
    }, 300000);

    function onMsg(e) {
      const d = e.data;
      if (!d || d.reqId !== reqId) return;
      if (d.action === 'muxProgress') {
        const m = /time=(\S+)/.exec(d.line || '');
        if (m) setMuxProgress(`${progressLabel}... ${m[1]}`);
        return;
      }
      if (d.action === 'muxResult') {
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        if (d.success) resolve(new Uint8Array(d.data));
        else reject(new Error(d.error));
      }
    }
    window.addEventListener('message', onMsg);

    const msg = buildMessage(reqId);
    if (wasmBinary) msg.wasmBinary = wasmBinary; // 転送せずコピー（キャッシュ維持）
    iframe.contentWindow.postMessage(msg, '*', transfer);
  });
}

async function muxStreams(videoBytes, audioBytes, names, trim = null) {
  return runMuxerTask((reqId) => {
    const msg = {
      action: 'mux',
      reqId,
      video: videoBytes.buffer,
      audio: audioBytes.buffer,
      videoName: names.video,
      audioName: names.audio,
      outName: names.out
    };
    if (trim) msg.trim = { start: trim.startText, end: trim.endText, duration: trim.durationText };
    return msg;
  }, [videoBytes.buffer, audioBytes.buffer], '合成中');
}

async function trimSingleStream(bytes, fmt, trim) {
  const inputName = `input.${fmt.ext || 'mp4'}`;
  const fsOutName = `out.${fmt.ext || 'mp4'}`;
  setMuxProgress('切り出し中...（ウィンドウを閉じないでください）');
  return runMuxerTask((reqId) => ({
    action: 'trim',
    reqId,
    input: bytes.buffer,
    inputName,
    outName: fsOutName,
    trim: { start: trim.startText, end: trim.endText, duration: trim.durationText }
  }), [bytes.buffer], '切り出し中');
}

function chooseMuxContainer(video, audio) {
  const v = video.ext, a = audio.ext;
  if (v === 'mp4' && (a === 'm4a' || a === 'mp4')) {
    return { ext: 'mp4', video: 'video.mp4', audio: 'audio.m4a', out: 'out.mp4', mime: 'video/mp4' };
  }
  if (v === 'webm' && (a === 'webm' || a === 'opus')) {
    return { ext: 'webm', video: 'video.webm', audio: 'audio.webm', out: 'out.webm', mime: 'video/webm' };
  }
  // 混在（mp4映像+webm音声 等）は mkv が無劣化copyで安全
  return { ext: 'mkv', video: `video.${v}`, audio: `audio.${a}`, out: 'out.mkv', mime: 'video/x-matroska' };
}

async function muxAndDownload(video, audio, videoTitle, els, trim = null) {
  // 容量超過の警告は popup側(downloadMuxハンドラ)でインライン2段階確認済み。
  // ここは委譲ウィンドウ/フォールバックで動くため、ブロッキングダイアログ(alert/confirm)は使わない。
  // 想定外の入力は throw して runDownloadWorker のステータス表示で通知する。
  // 合計が大きい場合の OOM は下の catch が「メモリ不足」として扱う。
  if (!video || !audio) throw new Error('映像と音声の両方が必要です');
  if (video.isMuxed) throw new Error('選択中の映像は既に音声込みです（合成は不要）');

  const buttons = [els.downloadVideo, els.downloadAudio, els.downloadPair, els.downloadMux];
  buttons.forEach(b => { if (b) b.disabled = true; });

  try {
    setMuxProgress('映像をダウンロード中...');
    let vb = await fetchFormatBytes(video, p => setMuxProgress(`映像DL中... ${p}%`));
    setMuxProgress('音声をダウンロード中...');
    let ab = await fetchFormatBytes(audio, p => setMuxProgress(`音声DL中... ${p}%`));

    const cont = chooseMuxContainer(video, audio);
    setMuxProgress('合成中...（ウィンドウを閉じないでください）');
    const out = await muxStreams(vb, ab, cont, trim);
    vb = ab = null; // 転送済みだが参照を明示的に解放

    setMuxProgress('保存中...');
    const blob = new Blob([out], { type: cont.mime });
    const filename = `${sanitize(videoTitle)}_${sanitize(video.quality)}_muxed${trimSuffix(trim)}.${cont.ext}`;
    await saveBlob(blob, filename);
    setMuxProgress('✓ 合成完了');
    setTimeout(clearMuxProgress, 4000);
  } catch (e) {
    clearMuxProgress();
    console.warn('[ytdl] Mux failed:', e);
    const msg = String(e && e.message || e);
    if (/allocation failed|out of memory|memory/i.test(msg)) {
      throw new Error('メモリ不足で合成できませんでした。低い解像度を選ぶか個別にDLしてください');
    }
    throw e;
  } finally {
    buttons.forEach(b => { if (b) b.disabled = false; });
  }
}

function setMuxProgress(text) {
  const el = document.getElementById('mux-progress');
  if (el) { el.textContent = text; el.style.display = 'block'; el.style.color = ''; }
  syncJobProgress(text);
}

// 進捗はすべてこの表示を通り、DL中は "NN%" を含む。バーはそれを拾うだけにして、
// 呼び出し側には手を入れない。割合が出ない工程(合成/保存)は不定形で流す。
function syncJobProgress(text) {
  const bar = document.getElementById('job-progress');
  if (!bar || bar.style.display !== 'block') return;
  const fill = bar.firstElementChild;
  const pct = /(\d+)%/.exec(text || '');
  if (pct) {
    bar.classList.remove('indeterminate');
    fill.style.width = `${Math.min(100, Number(pct[1]))}%`;
  } else {
    bar.classList.add('indeterminate');
    fill.style.width = '';
  }
}

function clearMuxProgress() {
  const el = document.getElementById('mux-progress');
  if (el) { el.style.display = 'none'; el.textContent = ''; el.style.color = ''; }
}

// popup内のpicker直下メッセージ(検証エラー/容量警告)。alert/confirmはpopupを閉じてしまうため使わない。
// #mux-progress を流用し、色だけ用途で切り替える(warn=金, error=赤)。
function showPickerMessage(text, kind) {
  const el = document.getElementById('mux-progress');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  el.style.color = kind === 'warn' ? 'var(--gold)' : kind === 'error' ? 'var(--err)' : '';
}

function isExpectedMediaType(contentType, fmt) {
  const type = (contentType || '').toLowerCase();
  if (fmt.hasVideo && type.startsWith('video/')) return true;
  if (fmt.hasAudio && !fmt.hasVideo && type.startsWith('audio/')) return true;
  return fmt.isMuxed && (type.startsWith('video/') || type.startsWith('audio/'));
}

function highestVideoHeight(formats) {
  return formats.reduce((max, fmt) => fmt.hasVideo ? Math.max(max, fmt.height ?? 0) : max, 0);
}

function renderFormatDebug(el, debug, formats, resolveStats = null) {
  if (!el || !debug) return;

  const sourceSummary = Object.entries(groupFormatsBySource(formats))
    .map(([source, sourceFormats]) => {
      const heights = [...new Set(sourceFormats
        .filter(fmt => fmt.hasVideo && fmt.height)
        .map(fmt => `${fmt.height}p`))]
        .sort(compareQualityText);
      return `${source}: ${sourceFormats.length}件${heights.length ? ` (${heights.join(', ')})` : ''}`;
    });

  const clientSummary = (debug.clients ?? [])
    .map(client => `${client.key}: 表示可能${client.resolvable}/${client.formats}件${client.heights?.length ? ` (${client.heights.join(', ')})` : ''}`);

  const errors = (debug.errors ?? []).slice(0, 3);
  const lines = [
    ...clientSummary,
    ...sourceSummary.map(line => `表示: ${line}`),
    ...(resolveStats?.unresolvedSig ? [`署名未復号で除外: ${resolveStats.unresolvedSig}件`] : []),
    ...(resolveStats?.unresolvedN ? [`n未復号: ${resolveStats.unresolvedN}件`] : []),
    ...errors.map(line => `失敗: ${line}`)
  ];

  if (lines.length === 0) return;

  el.textContent = lines.join('\n');
  // 問題がある時だけ表示（正常時はノイズになるので隠す）。
  const hasIssue = errors.length > 0 || resolveStats?.unresolvedSig || highestVideoHeight(formats) <= 360;
  el.style.display = hasIssue ? 'block' : 'none';
}

function groupFormatsBySource(formats) {
  return formats.reduce((groups, fmt) => {
    const source = fmt.source || 'unknown';
    groups[source] ??= [];
    groups[source].push(fmt);
    return groups;
  }, {});
}

function buildItem(fmt, videoTitle) {
  const li = document.createElement('li');
  li.className = 'fmt-item';

  const meta = buildMeta(fmt);
  li.innerHTML = `
    <div class="fmt-left">
      <span class="fmt-quality">${fmt.quality}</span>
      <span class="fmt-meta">${meta}</span>
    </div>
    <div class="fmt-actions">
      <button class="copy-btn" title="URLをコピー">コピー</button>
      <button class="dl-btn">DL</button>
    </div>
  `;

  li.querySelector('.copy-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(fmt.url);
    const btn = li.querySelector('.copy-btn');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
  });

  li.querySelector('.dl-btn').addEventListener('click', () => {
    const trim = getTrimRangeFromInputs({
      trimRange: document.getElementById('trim-range-input'),
      trimStart: document.getElementById('trim-start-input'),
      trimEnd: document.getElementById('trim-end-input')
    });
    if (trim === false) return;
    const kind = fmt.isMuxed ? 'muxed' : fmt.hasVideo ? 'video' : 'audio';
    startDownload([{ kind: 'single', fmt, dlKind: kind, trim }], videoTitle);
  });

  return li;
}

function buildMeta(fmt) {
  const parts = [fmt.ext.toUpperCase()];
  if (fmt.fps)           parts.push(`${fmt.fps}fps`);
  if (fmt.contentLength) parts.push(`${(fmt.contentLength / 1024 / 1024).toFixed(1)} MB`);
  if (fmt.source)        parts.push(fmt.source);
  return parts.join(' · ');
}

function formatQualityLabel(fmt) {
  if (fmt.qualityLabel) return fmt.qualityLabel;
  if (fmt.height) return `${fmt.height}p`;
  if (fmt.audioQuality) return fmt.audioQuality.replace(/^AUDIO_QUALITY_/, '').toLowerCase();
  return `itag-${fmt.itag}`;
}

function buildFilename(videoTitle, fmt, kind = null, trim = null) {
  const parts = [sanitize(videoTitle)];
  if (kind) parts.push(kind);
  parts.push(sanitize(fmt.quality));
  if (fmt.fps && fmt.hasVideo) parts.push(`${fmt.fps}fps`);
  if (!fmt.hasVideo && fmt.hasAudio && fmt.language) {
    parts.push(fmt.language + (fmt.isOriginalAudio ? '-orig' : fmt.isDubbed ? '-dub' : ''));
  }
  return `${parts.filter(Boolean).join('_')}${trimSuffix(trim)}.${fmt.ext}`;
}

function compareFormats(a, b) {
  return (b.height ?? 0) - (a.height ?? 0)
    || (b.fps ?? 0) - (a.fps ?? 0)
    || Number(b.isMuxed) - Number(a.isMuxed)
    || (b.bitrate ?? 0) - (a.bitrate ?? 0);
}

function compareAudioFormats(a, b) {
  return audioTrackRank(b) - audioTrackRank(a)        // オリジナル音声を先頭に
    || (b.bitrate ?? 0) - (a.bitrate ?? 0)
    || String(a.ext).localeCompare(String(b.ext))
    || String(a.source ?? '').localeCompare(String(b.source ?? ''));
}

function compareQualityText(a, b) {
  const numA = parseInt(a, 10);
  const numB = parseInt(b, 10);
  if (Number.isFinite(numA) && Number.isFinite(numB)) return numB - numA;
  return String(a).localeCompare(String(b));
}

function compareFilterText(a, b) {
  if (a === 'unknown' || a === 'fps不明') return 1;
  if (b === 'unknown' || b === 'fps不明') return -1;
  return compareQualityText(a, b);
}

function formatKind(fmt) {
  if (fmt.isMuxed) return '動画+音声';
  if (fmt.hasVideo) return '映像のみ';
  if (fmt.hasAudio) return '音声のみ';
  return '不明';
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function resolveUrl(fmt, nMap, sigMap, stats = null) {
  let url = fmt.url;
  let s = null;
  let sp = 'sig';
  
  const cipherText = fmt.signatureCipher || fmt.cipher;
  if (cipherText) {
    const cipher = new URLSearchParams(cipherText);
    url = cipher.get('url');
    s = cipher.get('s');
    sp = cipher.get('sp') || 'sig';
  }
  
  if (!url) throw new Error('URL not found');
  
  const u = new URL(url);

  // 1. Resolve standard signature (sig)
  if (s) {
    const decryptedSig = sigMap[s];
    if (!decryptedSig || decryptedSig === s) {
      if (stats) stats.unresolvedSig++;
      throw new Error('signature not decrypted');
    }
    u.searchParams.set(sp, decryptedSig);
  }

  // 2. Resolve n-signature
  const n = u.searchParams.get('n');
  if (n && nMap[n] && nMap[n] !== n) {
    u.searchParams.set('n', nMap[n]);
  } else if (n && stats) {
    stats.unresolvedN++;
  }

  url = u.toString();
  
  return url;
}

function mimeToExt(mime) {
  if (mime.startsWith('audio/') && mime.includes('mp4')) return 'm4a';
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('opus') || mime.includes('ogg')) return 'opus';
  return 'mp4';
}
