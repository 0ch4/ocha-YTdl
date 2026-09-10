const YOUTUBE_CONFIG = globalThis.OCHA_YTDL_YOUTUBE_CONFIG || {};
const DEFAULT_INNERTUBE_API_KEY = YOUTUBE_CONFIG.defaultInnertubeApiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const DEFAULT_WEB_CLIENT_VERSION = YOUTUBE_CONFIG.defaultWebClientVersion || '2.20260114.08.00';
const UPDATE_GUIDE_URL = OchaMaintenance.UPDATE_GUIDE_URL;

document.addEventListener('DOMContentLoaded', async () => {
  // ?job=ID で開かれた場合は「ダウンロード専用ウィンドウ」として動作し、
  // 通常のUI抽出フローはスキップ（popupを閉じてもDL/合成が継続するようにするため）。
  const jobId = new URLSearchParams(location.search).get('job');
  if (jobId) { await OchaDownload.runDownloadWorker(jobId); return; }

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
  // ツールバーから開いた popup も、開いている YouTube ページのテーマに合わせる
  // （ワーカーウィンドウは job.theme で同じ data-yt-theme を受け取る）。
  await applyYtThemeFromTab(tab);
  const videoId = extractYouTubeVideoId(tab?.url);
  const isShorts = isShortsUrl(tab?.url);
  OchaDownload.setContext({ tabId: tab?.id ?? null }); // PO Token をページMAIN worldで生成するのに使う

  if (!isYoutubeUrl(tab?.url)) {
    statusEl.textContent = 'YouTubeを開いてください';
    return;
  }

  if (!videoId && !extractPlaylistId(tab?.url)) {
    statusEl.textContent = 'YouTubeの動画またはショート動画ページを開いてください';
    return;
  }

  // プレイリストページの検出
  const playlistId = extractPlaylistId(tab?.url);
  const isPlaylistPage = !videoId && playlistId;
  if (isPlaylistPage) {
    statusEl.style.display = 'none';
    setupPlaylistUI(playlistId, tab);
    return;
  }

  // 動画ページ + プレイリスト付き（&list=...）
  if (videoId && playlistId && !isShorts) {
    setupPlaylistUI(playlistId, tab);
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

  OchaDownload.setContext({
    visitorData: pageGlobals?.innertube?.visitorData || null,
    videoId
  });
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
    const fetchResult = await fetchInnertubePlayerResponses(videoId, pageGlobals?.innertube, statusEl, tab.id);
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
        altUrls: (fmt._altUrls || []).filter(a => a.url),
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
  renderHistory();

  document.getElementById('clear-history')?.addEventListener('click', async () => {
    await OchaDownload.clearHistory();
    renderHistory();
  });

  function showError(msg) {
    statusEl.style.display = 'none';
    errorEl.style.display  = 'block';
    errorEl.textContent    = msg;
  }
});

async function renderHistory() {
  const section = document.getElementById('section-history');
  const list = document.getElementById('list-history');
  if (!section || !list) return;
  const items = await OchaDownload.getHistory();
  if (!items.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.replaceChildren();
  for (const h of items.slice(0, 10)) {
    const li = document.createElement('li');
    li.className = 'fmt-item';
    const left = document.createElement('div');
    left.className = 'fmt-left';
    const titleEl = document.createElement('span');
    titleEl.className = 'fmt-quality';
    titleEl.style.fontSize = '12px';
    titleEl.style.overflow = 'hidden';
    titleEl.style.textOverflow = 'ellipsis';
    titleEl.style.whiteSpace = 'nowrap';
    titleEl.style.maxWidth = '220px';
    titleEl.textContent = h.title || h.filename || '';
    const metaEl = document.createElement('span');
    metaEl.className = 'fmt-meta';
    const ago = formatAgo(h.ts);
    metaEl.textContent = h.status === 'ok'
      ? `${h.quality || ''} · ${ago}`
      : `失敗: ${h.error || '不明'} · ${ago}`;
    if (h.status !== 'ok') metaEl.style.color = 'var(--err)';
    left.append(titleEl, metaEl);
    li.append(left);
    list.appendChild(li);
  }
}

function formatAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

function isYoutubeUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch (_) {
    return false;
  }
}

// ツールバーから開いた popup の見た目を、開いている YouTube ページのテーマに合わせる。
// 拡張ページからは <html dark> も --yt-spec-* も見えないので、ページの MAIN world で
// 判定して data-yt-theme に載せる（値は popup.html 側のライト/ダークトークンに対応）。
// 検出に失敗したら既定(ダーク)のまま。ワーカーウィンドウはここではなく job.theme を使う。
async function applyYtThemeFromTab(tab) {
  try {
    if (!tab?.id || !isYoutubeUrl(tab.url)) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => document.documentElement.hasAttribute('dark') ? 'dark' : 'light'
    });
    const theme = results?.[0]?.result;
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-yt-theme', theme);
    }
  } catch (_) {
    // 権限やタブの状態で失敗しても、既定(ダーク)で表示すれば害はない
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

  const bundled = await OchaMaintenance.fetchJson(chrome.runtime.getURL('src/generated/ytdlp-meta.json'));
  const latest = await OchaMaintenance.getLatestStatus();
  const notice = OchaMaintenance.buildNotice(bundled, latest, chrome.runtime.getManifest().version);
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

// innertubeClientProfiles の並び順 = 優先順位（先頭ほど高優先）。dedupeRawFormats の
// 同点判定で使う。API応答のcontentLength/bitrate有無の偶然でスコアが動いても、
// この明示的な優先順位が「先に並べたクライアントを優先する」意図を保証する
// (2026-08: visionosをandroid_vrより先に並べても、スコアだけに頼ると壁ありの
// android_vr が偶然勝つ余地があった)。
const CLIENT_PRIORITY = new Map(
  (YOUTUBE_CONFIG.innertubeClientProfiles || []).map((p, i) => [p.key, (YOUTUBE_CONFIG.innertubeClientProfiles.length - i)])
);
function clientPriority(source) {
  return CLIENT_PRIORITY.get(source) ?? 0;
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
      // android_vr は 2026-08-18 にサーバ側で死んだ(直URLらしきものを返すが403になるだけ)
      // ので保険としての自動追い打ちはやめ、プロファイル順で最後(最終フォールバック)に
      // 回した(ユーザー指示)。よって通常はここで素直に打ち切ってよい。
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

// pot不要ソース(android_vr/visionos等)は同itagでも複数クライアントから直URLが取れる。
// スコアが同点だと片方しか残らないが、選ばれなかった方も「壁に当たった時の代替URL」
// として current._altUrls に積んでおく(fetchRangeが403時に切り替える用途)。
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

    if (!current) {
      byKey.set(key, fmt);
      continue;
    }

    const scoreFmt = rawFormatScore(fmt);
    const scoreCurrent = rawFormatScore(current);
    // スコアが同点の場合は挿入順の偶然に頼らず、明示的なクライアント優先順位で決める
    // (同じpot不要ソースでもAPI応答のフィールド有無でスコアが動くことがあるため)。
    const fmtWins = scoreFmt !== scoreCurrent
      ? scoreFmt > scoreCurrent
      : clientPriority(fmt.source) > clientPriority(current.source);
    const winner = fmtWins ? fmt : current;
    const loser = winner === fmt ? current : fmt;
    const altUrls = [...(winner._altUrls || []), ...(loser._altUrls || [])];
    if (isPotFreeSource(loser.source) && loser.url && loser.source !== winner.source) {
      altUrls.push({ source: loser.source, url: loser.url });
    }
    if (altUrls.length) winner._altUrls = altUrls;
    byKey.set(key, winner);
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
    OchaDownload.clearMuxProgress();
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
    if (video) OchaDownload.startDownload([{ kind: 'single', fmt: video, dlKind: video.isMuxed ? 'muxed' : 'video', trim }], videoTitle);
  });

  els.downloadAudio.addEventListener('click', () => {
    const audio = getSelectedFormat(els.audioSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    if (audio) OchaDownload.startDownload([{ kind: 'single', fmt: audio, dlKind: 'audio', trim }], videoTitle);
  });

  els.downloadPair.addEventListener('click', () => {
    const video = getSelectedFormat(els.videoSelect);
    const audio = getSelectedFormat(els.audioSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    const items = [];
    if (video) items.push({ kind: 'single', fmt: video, dlKind: video.isMuxed ? 'muxed' : 'video', trim });
    if (audio && !video?.isMuxed) items.push({ kind: 'single', fmt: audio, dlKind: 'audio', trim });
    if (items.length) OchaDownload.startDownload(items, videoTitle);
  });

  els.downloadMux.addEventListener('click', () => {
    const video = getSelectedFormat(els.videoSelect);
    const audio = getSelectedFormat(els.audioSelect);
    const trim = getTrimRangeFromInputs(els);
    if (trim === false) return;
    if (!video || !audio) { OchaDownload.showPickerMessage('映像と音声の両方を選択してください', 'error'); return; }
    if (video.isMuxed) { OchaDownload.showPickerMessage('選択中の映像は既に音声込みです。合成は不要です。', 'error'); return; }

    // 大容量はffmpeg.wasmがOOMしやすい。だが alert/confirm はpopupを閉じてDL自体を不能にするので、
    // ブロッキングしないインライン2段階確認にする（1回目=警告表示, 2回目=実行）。
    const estTotal = (video.contentLength || 0) + (audio.contentLength || 0);
    if (estTotal > OchaDownload.MUX_SOFT_LIMIT && !muxArmed) {
      const mb = Math.round(estTotal / 1024 / 1024);
      muxArmed = true;
      els.downloadMux.textContent = `それでも合成して保存（約${mb}MB）`;
      OchaDownload.showPickerMessage(
        `⚠ 合計約${mb}MB。ブラウザのメモリ上限で合成が失敗する可能性があります。\n` +
        `映像/音声を個別にDLするか、低い解像度を推奨。もう一度押すと合成を試みます。`,
        'warn'
      );
      return;
    }
    muxArmed = false;
    els.downloadMux.textContent = '映像+音声を合成して保存';
    OchaDownload.clearMuxProgress();
    OchaDownload.startDownload([{ kind: 'mux', video, audio, trim }], videoTitle);
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
    OchaDownload.showPickerMessage('切り出し範囲は 5-10、0:05~0:10、1:02:03-1:03:00 の形式で入力してください', 'error');
    return false;
  }

  const startRaw = rangeParts ? rangeParts.start : (els.trimStart?.value?.trim() || '');
  const endRaw = rangeParts ? rangeParts.end : (els.trimEnd?.value?.trim() || '');
  if (!startRaw && !endRaw) return null;

  const start = startRaw ? parseTimeInput(startRaw) : 0;
  const end = endRaw ? parseTimeInput(endRaw) : null;
  if (start == null || (end == null && endRaw)) {
    OchaDownload.showPickerMessage('切り出し範囲は 0:05 または 1:02:03 の形式で入力してください', 'error');
    return false;
  }
  if (end != null && end <= start) {
    OchaDownload.showPickerMessage('切り出し終了時刻は開始時刻より後にしてください', 'error');
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

  const left = document.createElement('div');
  left.className = 'fmt-left';

  const qualityEl = document.createElement('span');
  qualityEl.className = 'fmt-quality';
  qualityEl.textContent = fmt.quality;

  const metaEl = document.createElement('span');
  metaEl.className = 'fmt-meta';
  metaEl.textContent = buildMeta(fmt);

  left.append(qualityEl, metaEl);

  const actions = document.createElement('div');
  actions.className = 'fmt-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'tonal chip';
  copyBtn.style.fontSize = '11px';
  copyBtn.style.padding = '0 10px';
  copyBtn.title = 'URLをコピー';
  copyBtn.textContent = 'コピー';

  const dlBtn = document.createElement('button');
  dlBtn.className = 'filled';
  dlBtn.style.height = '32px';
  dlBtn.style.borderRadius = '16px';
  dlBtn.style.padding = '0 14px';
  dlBtn.style.fontSize = '11px';
  dlBtn.textContent = 'DL';

  actions.append(copyBtn, dlBtn);
  li.append(left, actions);

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(fmt.url);
    copyBtn.textContent = '✓';
    setTimeout(() => { copyBtn.textContent = 'コピー'; }, 1500);
  });

  dlBtn.addEventListener('click', () => {
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

// ─── プレイリスト一括ダウンロード ─────────────────────────────
// /playlist?list=ID または /watch?v=...&list=ID のときに有効。
// Innertube browse エンドポイントでプレイリスト項目を取得し、
// 各動画を最高画質の muxed (itag18) で順次キューする。

function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('list');
  } catch (_) { return null; }
}

async function fetchPlaylistItems(playlistId, tabId) {
  const cfg = globalThis.OCHA_YTDL_YOUTUBE_CONFIG;
  const apiKey = cfg?.defaultInnertubeApiKey || DEFAULT_INNERTUBE_API_KEY;
  const clientVersion = cfg?.defaultWebClientVersion || DEFAULT_WEB_CLIENT_VERSION;

  const body = {
    context: { client: { clientName: 'WEB', clientVersion, hl: 'ja', gl: 'JP' } },
    browseId: 'VL' + playlistId
  };

  // ページ MAIN world から叩く（same-origin なので CORS 問題なし）
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [apiKey, body],
    func: async (apiKey, body) => {
      try {
        const resp = await fetch(
          `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        );
        return await resp.json();
      } catch (e) { return { error: e?.message || String(e) }; }
    }
  });

  const data = result?.result;
  if (!data || data.error) throw new Error(data?.error || 'プレイリスト取得失敗');

  // YouTube の browse 応答は構造が多層で版によって変わる。
  // 決まったパスを辿るより、playlistVideoRenderer を再帰的に探す方が確実。
  const items = [];
  const seen = new Set();

  function walkPlaylistVideos(node, depth) {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) {
      for (const child of node) walkPlaylistVideos(child, depth + 1);
      return;
    }
    // playlistVideoRenderer
    const pvr = node.playlistVideoRenderer;
    if (pvr?.videoId && !seen.has(pvr.videoId)) {
      seen.add(pvr.videoId);
      items.push({
        videoId: pvr.videoId,
        title: pvr?.title?.runs?.[0]?.text || pvr?.title?.simpleText || pvr.videoId,
        index: items.length + 1
      });
    }
    // gridVideoRenderer (一部のレイアウト)
    const gvr = node.gridVideoRenderer;
    if (gvr?.videoId && !seen.has(gvr.videoId)) {
      seen.add(gvr.videoId);
      items.push({
        videoId: gvr.videoId,
        title: gvr?.title?.runs?.[0]?.text || gvr?.title?.simpleText || gvr.videoId,
        index: items.length + 1
      });
    }
    for (const key of Object.keys(node)) {
      if (key === 'playlistVideoRenderer' || key === 'gridVideoRenderer') continue;
      walkPlaylistVideos(node[key], depth + 1);
    }
  }

  walkPlaylistVideos(data, 0);

  // continuation トークンも再帰的に探す
  function findContinuationToken(node, depth) {
    if (!node || typeof node !== 'object' || depth > 30) return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const t = findContinuationToken(child, depth + 1);
        if (t) return t;
      }
      return null;
    }
    const cont = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (cont) return cont;
    const next = node.continuationCommand?.token;
    if (next) return next;
    for (const key of Object.keys(node)) {
      const t = findContinuationToken(node[key], depth + 1);
      if (t) return t;
    }
    return null;
  }

  let token = findContinuationToken(data, 0);
  let pages = 0;
  while (token && pages < 3) {
    pages++;
    const [more] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [apiKey, token, clientVersion],
      func: async (apiKey, token, clientVersion) => {
        try {
          const resp = await fetch(
            `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                context: { client: { clientName: 'WEB', clientVersion, hl: 'ja', gl: 'JP' } },
                continuation: token
              })
            }
          );
          return await resp.json();
        } catch (e) { return { error: e?.message || String(e) }; }
      }
    });
    const md = more?.result;
    if (!md || md.error) break;
    walkPlaylistVideos(md, 0);
    token = findContinuationToken(md, 0);
  }

  return items;
}

// プレイリスト動画1本分のフォーマットを取得してジョブを投げる
async function queuePlaylistDownload(videoId, title, tabId, visitorData) {
  const cfg = globalThis.OCHA_YTDL_YOUTUBE_CONFIG;
  const profile = cfg?.innertubeClientProfiles?.find(p => p.key === 'visionos');
  if (!profile) throw new Error('visionos client not found');

  const headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': String(cfg.clientNameHeaders[profile.clientName]),
    'X-YouTube-Client-Version': profile.clientVersion
  };
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

  const client = { ...profile.contextClient };
  if (visitorData) client.visitorData = visitorData;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [cfg.defaultInnertubeApiKey, { context: { client }, videoId, contentCheckOk: true, racyCheckOk: true }, headers],
    func: async (apiKey, body, headers) => {
      try {
        const resp = await fetch(
          `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
          { method: 'POST', headers, body: JSON.stringify(body) }
        );
        return await resp.json();
      } catch (e) { return { error: e?.message || String(e) }; }
    }
  });

  const data = result?.result;
  if (!data || data.error || data?.playabilityStatus?.status !== 'OK') {
    throw new Error(data?.playabilityStatus?.reason || data?.error || '取得失敗');
  }

  const sd = data?.streamingData;
  if (!sd) throw new Error('streamingData なし');

  // progressive (muxed) があればそれを、なければ映像+音声をペアで
  const progressive = (sd.formats || []).filter(f => f.url);
  if (progressive.length) {
    const best = progressive.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const mime = best.mimeType || '';
    const fmt = {
      itag: best.itag, url: best.url,
      quality: best.qualityLabel || best.quality || String(best.itag),
      mimeType: mime,
      ext: /webm/.test(mime) ? 'webm' : 'mp4',
      isMuxed: true, hasVideo: true, hasAudio: true,
      source: 'visionos', potFree: true,
      height: best.height || null, fps: best.fps || null,
      bitrate: best.bitrate || 0,
      contentLength: Number(best.contentLength) || null
    };
    await OchaDownload.dispatchDownloadJob({
      items: [{ kind: 'single', fmt, dlKind: 'muxed', trim: null }],
      videoTitle: title,
      ctx: { tabId, videoId, visitorData }
    });
    return;
  }

  // progressive が無い場合は adaptive から選ぶ（映像+音声の mux）
  const adaptive = (sd.adaptiveFormats || []).filter(f => f.url);
  const video = adaptive.filter(f => (f.mimeType || '').startsWith('video/'))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const audio = adaptive.filter(f => (f.mimeType || '').startsWith('audio/'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!video || !audio) throw new Error('フォーマット不足');

  const mk = (f, isVid) => ({
    itag: f.itag, url: f.url,
    quality: f.qualityLabel || f.quality || String(f.itag),
    mimeType: f.mimeType || '',
    ext: /webm/.test(f.mimeType || '') ? 'webm' : /mp4/.test(f.mimeType || '') ? (isVid ? 'mp4' : 'm4a') : 'bin',
    isMuxed: false, hasVideo: isVid, hasAudio: !isVid,
    source: 'visionos', potFree: true,
    height: f.height || null, fps: f.fps || null,
    bitrate: f.bitrate || 0,
    contentLength: Number(f.contentLength) || null
  });

  await OchaDownload.dispatchDownloadJob({
    items: [{ kind: 'mux', video: mk(video, true), audio: mk(audio, false), trim: null }],
    videoTitle: title,
    ctx: { tabId, videoId, visitorData }
  });
}

function setupPlaylistUI(playlistId, tab) {
  const section = document.getElementById('playlist-section');
  const infoEl = document.getElementById('playlist-info');
  const fetchBtn = document.getElementById('playlist-fetch');
  const dlBtn = document.getElementById('playlist-download');
  const progressEl = document.getElementById('playlist-progress');
  if (!section || !fetchBtn || !dlBtn) return;

  section.style.display = 'block';
  infoEl.textContent = `リスト: ${playlistId}`;
  dlBtn.disabled = true;
  dlBtn.textContent = '全件保存';

  let items = [];

  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    fetchBtn.textContent = '取得中...';
    progressEl.style.display = 'block';
    progressEl.textContent = 'プレイリストを読み込み中...';
    try {
      items = await fetchPlaylistItems(playlistId, tab.id);
      if (!items.length) throw new Error('動画が見つかりませんでした');
      infoEl.textContent = `${items.length}件の動画`;
      dlBtn.disabled = false;
      progressEl.textContent = `${items.length}件取得しました。「全件保存」を押してください。`;
    } catch (e) {
      progressEl.textContent = '取得失敗: ' + (e?.message || e);
      fetchBtn.disabled = false;
      fetchBtn.textContent = '一覧を取得';
    }
  });

  dlBtn.addEventListener('click', async () => {
    if (!items.length) return;
    dlBtn.disabled = true;
    fetchBtn.disabled = true;
    const visitorData = null; // ページから取得済みなら使う
    let ok = 0, fail = 0;
    for (const item of items) {
      progressEl.textContent = `${item.index}/${items.length}: ${item.title.slice(0, 40)}...`;
      try {
        await queuePlaylistDownload(item.videoId, item.title, tab.id, visitorData);
        ok++;
      } catch (e) {
        fail++;
        console.warn(`[ytdl] playlist item failed: ${item.videoId}`, e);
      }
      // レート制限回避のため少し待つ
      await new Promise(r => setTimeout(r, 800));
    }
    progressEl.textContent = `完了: ${ok}件成功, ${fail}件失敗`;
    dlBtn.textContent = '保存開始済み';
  });
}
