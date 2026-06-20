document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const errorEl  = document.getElementById('error');
  const titleEl  = document.getElementById('video-title');
  const nSigEl   = document.getElementById('nsig-status');
  const iframe   = document.getElementById('solver-iframe');
  const qualityPicker = document.getElementById('quality-picker');
  const qualitySelect = document.getElementById('quality-select');
  const downloadSelected = document.getElementById('download-selected');
  const qualityNote = document.getElementById('quality-note');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = extractYouTubeVideoId(tab?.url);

  if (!isYoutubeUrl(tab?.url)) {
    statusEl.textContent = 'YouTubeを開いてください';
    return;
  }

  if (!videoId) {
    statusEl.textContent = 'YouTubeの動画またはショート動画ページを開いてください';
    return;
  }

  statusEl.textContent = '動画情報を取得中...';

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
          playerResponse: pr ? {
            videoDetails: pr.videoDetails ? { title: pr.videoDetails.title } : null,
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
    });
    pageGlobals = results?.[0]?.result;
  } catch (e) {
    showError(`動画情報の取得に失敗しました。ページをリロードしてから再試行してください。\n(${e.message})`);
    return;
  }

  try {
    if (!pageGlobals?.innertube?.apiKey || !pageGlobals?.playerResponse?.streamingData) {
      statusEl.textContent = '動画ページ情報を補完中...';
      pageGlobals = mergePageGlobals(pageGlobals, await fetchWatchPageGlobals(videoId));
    }
  } catch (e) {
    console.warn('[ytdl] Watch page fallback failed:', e);
  }

  let apiPlayerResponse = null;
  try {
    statusEl.textContent = '動画フォーマットを確認中...';
    apiPlayerResponse = await fetchInnertubePlayerResponses(videoId, pageGlobals?.innertube, statusEl);
  } catch (e) {
    console.warn('[ytdl] Innertube fallback failed:', e.message || e);
  }

  const playerResponse = pickBestPlayerResponse([...(apiPlayerResponse ?? []), pageGlobals?.playerResponse]);
  const playerJsUrl = pageGlobals?.playerJsUrl;

  if (!playerResponse?.streamingData) {
    showError('動画情報が見つかりません。ページを再読み込みしてください。');
    return;
  }

  const title = playerResponse.videoDetails?.title ?? 'video';
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
        
        let playerJs = null;
        try {
          const cached = await chrome.storage.local.get(['playerJsUrl', 'playerJs']);
          if (cached.playerJsUrl === playerJsUrl && cached.playerJs) {
            playerJs = cached.playerJs;
            console.log('[ytdl] Loaded player.js from cache');
          }
        } catch (e) {
          console.warn('[ytdl] Cache read failed:', e);
        }
        
        if (!playerJs) {
          statusEl.textContent = '復号ロジックをダウンロード中...';
          const playerResp = await fetch(playerJsUrl);
          if (!playerResp.ok) throw new Error(`fetch failed: ${playerResp.status}`);
          playerJs = await playerResp.text();
          
          try {
            await chrome.storage.local.set({ playerJsUrl, playerJs });
            console.log('[ytdl] Saved player.js to cache');
          } catch (e) {
            console.warn('[ytdl] Cache write failed:', e);
          }
        }

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
  const formats = allFmtsRaw.flatMap(fmt => {
    try {
      const url = resolveUrl(fmt, nMap, sigMap);
      const mime = fmt.mimeType ?? '';
      const isMuxed = muxedItags.has(fmt.itag);
      const hasVideo = mime.startsWith('video/') || Boolean(fmt.width || fmt.height);
      const hasAudio = mime.startsWith('audio/') || isMuxed || Boolean(fmt.audioQuality);
      return [{
        itag: fmt.itag, url,
        quality: formatQualityLabel(fmt),
        mimeType: mime, ext: mimeToExt(mime),
        contentLength: fmt.contentLength ? parseInt(fmt.contentLength) : null,
        isMuxed,
        hasVideo,
        hasAudio,
        height: fmt.height ?? null, fps: fmt.fps ?? null, bitrate: fmt.bitrate ?? null,
      }];
    } catch (_) { return []; }
  });

  if (formats.length === 0) {
    showError('ダウンロード可能なフォーマットが見つかりませんでした');
    return;
  }

  statusEl.style.display = 'none';
  titleEl.textContent = title;

  nSigEl.textContent = nSigOk ? '✓ シグネチャ: 復号OK' : `✗ シグネチャ: 失敗 — ${nSigError ?? ''}`;
  nSigEl.className   = nSigOk ? 'nsig-ok' : 'nsig-fail';
  nSigEl.style.display = 'block';

  const muxed     = formats.filter(f => f.isMuxed);
  const videoOnly = formats.filter(f => f.hasVideo && !f.isMuxed);
  const audioOnly = formats.filter(f => !f.hasVideo && f.hasAudio);

  renderSection('muxed', muxed, title);
  renderSection('video', videoOnly, title, 'divider-video');
  renderSection('audio', audioOnly, title, 'divider-audio');
  renderQualityPicker(formats.filter(f => f.hasVideo), title, {
    qualityPicker,
    qualitySelect,
    downloadSelected,
    qualityNote
  }, formats);

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
      videoDetails: pr.videoDetails ? { title: pr.videoDetails.title } : null,
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
  if (clientName === 'WEB') return '1';
  if (clientName === 'WEB_EMBEDDED_PLAYER') return '56';
  if (clientName === 'WEB_REMIX') return '67';
  if (clientName === 'ANDROID') return '3';
  if (clientName === 'IOS') return '5';
  if (clientName === 'TVHTML5') return '7';
  return '1';
}

async function fetchInnertubePlayerResponses(videoId, innertube = {}, statusEl = null) {
  const clients = buildInnertubeClients(innertube);
  const responses = [];
  const errors = [];

  for (const client of clients) {
    try {
      if (statusEl) statusEl.textContent = `動画フォーマットを確認中... (${client.key})`;
      const response = await fetchInnertubePlayerResponse(videoId, innertube, client);
      responses.push(response);
    } catch (e) {
      errors.push(`${client.key}: ${e.message}`);
      console.warn(`[ytdl] ${client.key} player API failed:`, e);
    }
  }

  if (responses.length === 0 && errors.length > 0) {
    throw new Error(errors.join(' / '));
  }

  return responses;
}

function buildInnertubeClients(innertube = {}) {
  const pageClient = innertube.context?.client;
  const pageContext = innertube.context || {
    client: {
      clientName: 'WEB',
      clientVersion: innertube.clientVersion || '2.20260114.08.00',
      hl: 'ja',
      gl: 'JP',
      visitorData: innertube.visitorData || undefined
    }
  };

  return [
    {
      key: 'page_web',
      context: pageContext,
      clientName: innertube.clientName || pageClient?.clientName || 'WEB',
      clientVersion: innertube.clientVersion || pageClient?.clientVersion || '2.20260114.08.00'
    },
    {
      key: 'tv',
      context: {
        client: {
          clientName: 'TVHTML5',
          clientVersion: '7.20260114.12.00',
          hl: 'ja',
          gl: 'JP'
        }
      },
      clientName: 'TVHTML5',
      clientVersion: '7.20260114.12.00'
    },
    {
      key: 'android',
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '21.02.35',
          androidSdkVersion: 30,
          userAgent: 'com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip',
          osName: 'Android',
          osVersion: '11',
          hl: 'ja',
          gl: 'JP'
        }
      },
      clientName: 'ANDROID',
      clientVersion: '21.02.35'
    },
    {
      key: 'ios',
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '21.02.3',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          userAgent: 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
          osName: 'iPhone',
          osVersion: '18.3.2.22D82',
          hl: 'ja',
          gl: 'JP'
        }
      },
      clientName: 'IOS',
      clientVersion: '21.02.3'
    },
    {
      key: 'web_safari',
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: innertube.clientVersion || pageClient?.clientVersion || '2.20260114.08.00',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)',
          hl: 'ja',
          gl: 'JP',
          visitorData: innertube.visitorData || pageClient?.visitorData || undefined
        }
      },
      clientName: 'WEB',
      clientVersion: innertube.clientVersion || pageClient?.clientVersion || '2.20260114.08.00'
    }
  ];
}

async function fetchInnertubePlayerResponse(videoId, innertube = {}, clientConfig) {
  if (!innertube?.apiKey) {
    throw new Error('INNERTUBE_API_KEY not found');
  }

  const context = clientConfig.context;
  const client = context.client || {};
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(innertube.apiKey)}&prettyPrint=false`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': getClientNameHeader(clientConfig.clientName || client.clientName),
      'X-YouTube-Client-Version': String(clientConfig.clientVersion || client.clientVersion || '')
    },
    body: JSON.stringify({
      context,
      videoId,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS'
        }
      },
      contentCheckOk: true,
      racyCheckOk: true
    })
  });

  if (!resp.ok) {
    throw new Error(`Innertube player failed: ${resp.status}`);
  }

  const data = await resp.json();
  if (!data?.streamingData) {
    throw new Error(data?.playabilityStatus?.reason || 'streamingData not found');
  }

  return {
    videoDetails: data.videoDetails ? { title: data.videoDetails.title } : null,
    streamingData: data.streamingData
  };
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

function countRawFormats(response) {
  const sd = response?.streamingData;
  return (sd?.formats?.length ?? 0) + (sd?.adaptiveFormats?.length ?? 0);
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
      fmt.audioQuality
    ].join(':');
    const current = byKey.get(key);

    if (!current || rawFormatScore(fmt) > rawFormatScore(current)) {
      byKey.set(key, fmt);
    }
  }

  return [...byKey.values()];
}

function rawFormatScore(fmt) {
  return (fmt.url ? 8 : 0)
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

function renderQualityPicker(formats, videoTitle, els, allFormats = formats) {
  if (formats.length === 0 || !els.qualityPicker || !els.qualitySelect || !els.downloadSelected) return;

  const sortedFormats = [...formats].sort(compareFormats);
  els.qualitySelect.replaceChildren();

  sortedFormats.forEach((fmt, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = `${fmt.quality} / ${formatKind(fmt)} / ${buildMeta(fmt)}`;
    els.qualitySelect.appendChild(opt);
  });

  const updateNote = () => {
    const fmt = sortedFormats[Number(els.qualitySelect.value)];
    if (!fmt || !els.qualityNote) return;

    if (fmt.hasVideo && !fmt.isMuxed) {
      els.qualityNote.textContent = '720p以上などの高画質は、YouTube側の仕様で音声なしの映像ファイルとして提供される場合があります。';
      els.qualityNote.style.display = 'block';
    } else if (highestVideoHeight(allFormats) <= 360) {
      els.qualityNote.textContent = 'この取得経路では360pまでしか返っていません。YouTube側の制限、PO Token、またはHLS/SABR配信のみの可能性があります。';
      els.qualityNote.style.display = 'block';
    } else {
      els.qualityNote.textContent = '';
      els.qualityNote.style.display = 'none';
    }
  };

  els.downloadSelected.addEventListener('click', () => {
    const fmt = sortedFormats[Number(els.qualitySelect.value)];
    if (!fmt) return;

    chrome.downloads.download({
      url: fmt.url,
      filename: buildFilename(videoTitle, fmt),
      saveAs: false
    });
  });

  els.qualitySelect.addEventListener('change', updateNote);
  updateNote();
  els.qualityPicker.style.display = 'grid';
}

function highestVideoHeight(formats) {
  return formats.reduce((max, fmt) => fmt.hasVideo ? Math.max(max, fmt.height ?? 0) : max, 0);
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

  const url = fmt.url;
  const filename = buildFilename(videoTitle, fmt);

  li.querySelector('.copy-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(url);
    const btn = li.querySelector('.copy-btn');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
  });

  li.querySelector('.dl-btn').addEventListener('click', () => {
    chrome.downloads.download({ url, filename, saveAs: false });
  });

  return li;
}

function buildMeta(fmt) {
  const parts = [fmt.ext.toUpperCase()];
  if (fmt.fps)           parts.push(`${fmt.fps}fps`);
  if (fmt.contentLength) parts.push(`${(fmt.contentLength / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(' · ');
}

function formatQualityLabel(fmt) {
  if (fmt.qualityLabel) return fmt.qualityLabel;
  if (fmt.height) return `${fmt.height}p`;
  if (fmt.audioQuality) return fmt.audioQuality.replace(/^AUDIO_QUALITY_/, '').toLowerCase();
  return `itag-${fmt.itag}`;
}

function buildFilename(videoTitle, fmt) {
  return `${sanitize(videoTitle)}_${sanitize(fmt.quality)}.${fmt.ext}`;
}

function compareFormats(a, b) {
  return (b.height ?? 0) - (a.height ?? 0)
    || (b.fps ?? 0) - (a.fps ?? 0)
    || Number(b.isMuxed) - Number(a.isMuxed)
    || (b.bitrate ?? 0) - (a.bitrate ?? 0);
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

function resolveUrl(fmt, nMap, sigMap) {
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
  
  try {
    const u = new URL(url);
    
    // 1. Resolve standard signature (sig)
    if (s) {
      const decryptedSig = sigMap[s] || s;
      u.searchParams.set(sp, decryptedSig);
    }
    
    // 2. Resolve n-signature
    const n = u.searchParams.get('n');
    if (n && nMap[n] && nMap[n] !== n) {
      u.searchParams.set('n', nMap[n]);
    }
    
    url = u.toString();
  } catch (_) {}
  
  return url;
}

function mimeToExt(mime) {
  if (mime.includes('mp4'))  return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('opus') || mime.includes('ogg')) return 'opus';
  return 'mp4';
}
