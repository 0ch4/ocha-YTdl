/*
 * ダウンロード/合成/切り出しパイプライン。
 * popup.js（UI）と popup.html?job=（ワーカーウィンドウ）の両方から呼ばれる。
 * UI からは globalThis.OchaDownload 経由でアクセスする。
 *
 * 依存: config/youtube.js（OCHA_YTDL_YOUTUBE_CONFIG）
 */
globalThis.OchaDownload = (() => {
  const YOUTUBE_CONFIG = globalThis.OCHA_YTDL_YOUTUBE_CONFIG || {};
  const RANGE_CHUNK_SIZE = YOUTUBE_CONFIG.rangeChunkSize || (10 << 20);
  const MUX_SOFT_LIMIT = 1100 * 1024 * 1024;
  const POT_PROVIDER_URL = YOUTUBE_CONFIG.potProviderUrl || null;
  const POT_FREE_LIMIT = 20 * 1024 * 1024;
  const CHUNK_TIMEOUT_MS = 30000;

  // ── 共有状態 ──────────────────────────────────────────────
  let _pot = null;
  let _visitorData = null;
  let _videoId = null;
  let _tabId = null;
  let _lastPotError = null;
  let _potPromise = null;
  let _wasmBinary = null;

  function setContext({ visitorData, videoId, tabId }) {
    if (visitorData !== undefined) _visitorData = visitorData;
    if (videoId !== undefined) _videoId = videoId;
    if (tabId !== undefined) _tabId = tabId;
  }

  // ── PO Token ─────────────────────────────────────────────
  function ensurePot() {
    if (_pot) return Promise.resolve(_pot);
    if (_potPromise) return _potPromise;
    _potPromise = _ensurePotOnce().finally(() => { _potPromise = null; });
    return _potPromise;
  }

  async function _ensurePotOnce() {
    if (_pot) return _pot;

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

    try {
      const { gvsPot } = await chrome.storage.session.get('gvsPot');
      if (gvsPot) { _pot = gvsPot; return _pot; }
    } catch (_) {}

    try {
      const t = await generatePoTokenInBrowser(_visitorData || _videoId || '');
      if (t) { _pot = t; return _pot; }
    } catch (e) {
      console.warn('[ytdl] in-browser pot generation failed:', e);
    }

    return _pot;
  }

  async function generatePoTokenInBrowser(identifier) {
    if (!_tabId) { _lastPotError = 'tabId 無し'; return null; }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: _tabId },
        world: 'MAIN',
        files: ['vendor/bgutils/bgutils.js']
      });

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

  // ── fetch ────────────────────────────────────────────────
  function rangedUrl(url, start, end, potFree) {
    let u = url + (url.includes('?') ? '&' : '?') + `range=${start}-${end}`;
    if (!potFree && _pot && !/[?&]pot=/.test(u)) u += '&pot=' + encodeURIComponent(_pot);
    return u;
  }

  async function fetchFormatBytes(fmt, onProgress) {
    const total = fmt.contentLength || null;

    if (!fmt.potFree && total && total > POT_FREE_LIMIT) {
      throw new Error('この画質はPO Token必須クライアント由来でフルDLできません。別の画質（tv由来）を選んでください');
    }

    if (!total) {
      const res = await fetchChunkWithTimeout(fmt.url, CHUNK_TIMEOUT_MS);
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(res.buf);
    }

    const chunkSize = Math.min(RANGE_CHUNK_SIZE, Math.max(1, Math.ceil(total / 2)));

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
        const part = await fetchRange(fmt, s, e);
        out.set(part, s);
        done += part.length;
        if (onProgress) onProgress(Math.floor((done / total) * 100));
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (done !== total) throw new Error(`サイズ不一致: ${done}/${total}`);
    return out;
  }

  async function fetchChunkWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (r.status === 200 || r.status === 206) {
        const buf = await r.arrayBuffer();
        return { status: r.status, contentType: r.headers.get('content-type') || '', buf };
      }
      return { status: r.status, contentType: '', buf: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchRange(fmt, start, end) {
    const backoffs = [0, 1000, 3000, 7000, 15000];
    const MAX_POT_RETRIES = 2;
    let lastStatus = 0;
    let triedPot = false;
    let potRetries = 0;

    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      if (backoffs[attempt]) await delay(backoffs[attempt]);
      let res;
      try {
        res = await fetchChunkWithTimeout(rangedUrl(fmt.url, start, end, fmt.potFree), CHUNK_TIMEOUT_MS);
      } catch (e) {
        lastStatus = -1;
        continue;
      }

      if (res.status === 200 || res.status === 206) {
        if (!isExpectedMediaType(res.contentType, fmt)) throw new Error(`想定外のContent-Type: ${res.contentType || 'unknown'}`);
        return new Uint8Array(res.buf);
      }

      lastStatus = res.status;

      if (res.status === 403 && start >= POT_FREE_LIMIT && !_pot && !triedPot && !fmt.potFree) {
        triedPot = true;
        setMuxProgress('PO Tokenを生成中...');
        await ensurePot();
        clearMuxProgress();
        if (_pot && potRetries < MAX_POT_RETRIES) { potRetries++; attempt--; continue; }
      }

      if ((res.status === 403 || res.status === 429) && fmt.potFree && Array.isArray(fmt.altUrls) && fmt.altUrls.length) {
        const alt = fmt.altUrls.shift();
        if (alt && alt.url && alt.url !== fmt.url) {
          console.warn(`[ytdl] ${fmt.source}経路が${start}バイト付近で塞がれたため${alt.source}に切替`);
          fmt.url = alt.url;
          fmt.source = alt.source;
          attempt--;
          continue;
        }
      }

      if (res.status !== 403 && res.status !== 429 && res.status < 500) break;
    }

    let hint = '';
    if (lastStatus === 403 && start >= POT_FREE_LIMIT && !fmt.potFree) {
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

  // ── mux (ffmpeg.wasm via sandbox) ────────────────────────
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
      if (wasmBinary) msg.wasmBinary = wasmBinary;
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
    return { ext: 'mkv', video: `video.${v}`, audio: `audio.${a}`, out: 'out.mkv', mime: 'video/x-matroska' };
  }

  // ── save ─────────────────────────────────────────────────
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
        chrome.downloads.search({ id }, (items) => {
          const it = items && items[0];
          if (it?.state === 'complete') done(true);
          else if (it?.state === 'interrupted') done(false, '保存中断: ' + (it.error || '不明'));
        });
      });
    });
  }

  // ── progress ─────────────────────────────────────────────
  function setMuxProgress(text) {
    const el = document.getElementById('mux-progress');
    if (el) { el.textContent = text; el.style.display = 'block'; el.style.color = ''; }
    syncJobProgress(text);
  }

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

  function showPickerMessage(text, kind) {
    const el = document.getElementById('mux-progress');
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.color = kind === 'warn' ? 'var(--gold)' : kind === 'error' ? 'var(--err)' : '';
  }

  // ── download / mux orchestration ─────────────────────────
  async function downloadFormat(fmt, videoTitle, kind, trim = null, opts = {}) {
    const filename = buildFilename(videoTitle, fmt, kind, trim, opts);
    try {
      if (fmt.isMuxed && !trim) {
        chrome.downloads.download({ url: fmt.url, filename, saveAs: false }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[ytdl] Download failed:', chrome.runtime.lastError.message, fmt);
            recordHistory({ title: videoTitle, filename, quality: fmt.quality, kind, status: 'error', error: chrome.runtime.lastError.message });
          } else {
            recordHistory({ title: videoTitle, filename, quality: fmt.quality, kind, status: 'ok' });
          }
        });
        return;
      }

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
      recordHistory({ title: videoTitle, filename, quality: fmt.quality, kind, status: 'ok' });
    } catch (e) {
      clearMuxProgress();
      console.warn('[ytdl] Download failed:', e, fmt);
      recordHistory({ title: videoTitle, filename, quality: fmt.quality, kind, status: 'error', error: e?.message || String(e) });
      throw e;
    }
  }

  async function muxAndDownload(video, audio, videoTitle, els, trim = null, opts = {}) {
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
      vb = ab = null;

      setMuxProgress('保存中...');
      const blob = new Blob([out], { type: cont.mime });
      const filename = `${sanitize(videoTitle)}_${sanitize(video.quality)}_muxed${trimSuffix(trim)}.${cont.ext}`;
      await saveBlob(blob, filename);
      setMuxProgress('✓ 合成完了');
      recordHistory({ title: videoTitle, filename, quality: video.quality, kind: 'mux', status: 'ok' });
      setTimeout(clearMuxProgress, 4000);
    } catch (e) {
      clearMuxProgress();
      console.warn('[ytdl] Mux failed:', e);
      const msg = String(e && e.message || e);
      const friendly = /allocation failed|out of memory|memory/i.test(msg)
        ? 'メモリ不足で合成できませんでした。低い解像度を選ぶか個別にDLしてください'
        : msg;
      recordHistory({ title: videoTitle, filename: `${sanitize(videoTitle)}_muxed`, quality: video.quality, kind: 'mux', status: 'error', error: friendly });
      if (/allocation failed|out of memory|memory/i.test(msg)) {
        throw new Error('メモリ不足で合成できませんでした。低い解像度を選ぶか個別にDLしてください');
      }
      throw e;
    } finally {
      buttons.forEach(b => { if (b) b.disabled = false; });
    }
  }

  // ── job dispatch ─────────────────────────────────────────
  function isDirectItem(item) {
    return item.kind === 'single' && item.fmt.isMuxed && !item.trim;
  }

  function startDownload(items, videoTitle) {
    if (items.every(isDirectItem)) {
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
          await muxAndDownload(it.video, it.audio, videoTitle, {}, it.trim, it.opts || {});
        } else {
          await downloadFormat(it.fmt, videoTitle, it.dlKind, it.trim, it.opts || {});
        }
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
  }

  async function runDownloadWorker(jobId) {
    const key = 'ochaJob:' + jobId;
    const statusEl = document.getElementById('status');
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
      setTimeout(() => window.close(), 12000);
    }
  }

  // ── filename helpers ─────────────────────────────────────
  function formatSecondsForFfmpeg(value) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value - hours * 3600 - minutes * 60;
    const secText = seconds % 1 === 0
      ? String(seconds).padStart(2, '0')
      : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').padStart(2, '0');
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secText}`;
  }

  function formatSecondsForFilename(value) {
    return formatSecondsForFfmpeg(value).replace(/:/g, '-').replace(/\./g, '_');
  }

  function trimSuffix(trim) {
    if (!trim) return '';
    const start = formatSecondsForFilename(trim.start);
    const end = trim.end == null ? 'end' : formatSecondsForFilename(trim.end);
    return `_clip_${start}-${end}`;
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  }

  function buildFilename(videoTitle, fmt, kind = null, trim = null, opts = {}) {
    const parts = [];
    // プレイリストのナンバリング (例: "001_")
    if (opts.index != null) parts.push(String(opts.index).padStart(3, '0'));
    parts.push(sanitize(videoTitle));
    if (kind) parts.push(kind);
    parts.push(sanitize(fmt.quality));
    if (fmt.fps && fmt.hasVideo) parts.push(`${fmt.fps}fps`);
    if (!fmt.hasVideo && fmt.hasAudio && fmt.language) {
      parts.push(fmt.language + (fmt.isOriginalAudio ? '-orig' : fmt.isDubbed ? '-dub' : ''));
    }
    const name = `${parts.filter(Boolean).join('_')}${trimSuffix(trim)}.${fmt.ext}`;
    // プレイリストのフォルダ保存 (例: "プレイリスト名/001_タイトル_1080p.mp4")
    return opts.folder ? `${sanitize(opts.folder)}/${name}` : name;
  }

  function isExpectedMediaType(contentType, fmt) {
    const type = (contentType || '').toLowerCase();
    if (fmt.hasVideo && type.startsWith('video/')) return true;
    if (fmt.hasAudio && !fmt.hasVideo && type.startsWith('audio/')) return true;
    return fmt.isMuxed && (type.startsWith('video/') || type.startsWith('audio/'));
  }

  // ── history ──────────────────────────────────────────────
  const HISTORY_KEY = 'downloadHistory';
  const HISTORY_MAX = 50;

  async function recordHistory(entry) {
    try {
      const stored = await chrome.storage.local.get(HISTORY_KEY);
      const list = stored[HISTORY_KEY] || [];
      list.unshift({ ...entry, ts: Date.now() });
      if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
      await chrome.storage.local.set({ [HISTORY_KEY]: list });
    } catch (_) {}
  }

  async function getHistory() {
    try {
      const stored = await chrome.storage.local.get(HISTORY_KEY);
      return stored[HISTORY_KEY] || [];
    } catch (_) { return []; }
  }

  async function clearHistory() {
    try { await chrome.storage.local.remove(HISTORY_KEY); } catch (_) {}
  }

  // ── public API ───────────────────────────────────────────
  return {
    MUX_SOFT_LIMIT,
    setContext,
    startDownload,
    dispatchDownloadJob,
    runJobItems,
    runDownloadWorker,
    downloadFormat,
    muxAndDownload,
    saveBlob,
    fetchFormatBytes,
    setMuxProgress,
    clearMuxProgress,
    showPickerMessage,
    formatSecondsForFfmpeg,
    buildFilename,
    sanitize,
    trimSuffix,
    recordHistory,
    getHistory,
    clearHistory
  };
})();
