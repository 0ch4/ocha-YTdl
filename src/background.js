importScripts('shared/maintenance.js');

// ─── 更新推奨ステータスの定期チェック ────────────────────────────────────────
// popup を開かない人でもページ内UI(content.js)の切り出しボタンで気づけるように、
// popup を開いた時だけでなくここでも定期的に確認して chrome.storage.local に置く。
// content.js はそれを読むだけ(自前で fetch はしない)。
const MAINTENANCE_ALARM = 'ocha-maintenance-check';

async function refreshMaintenanceNotice() {
  try {
    await OchaMaintenance.refreshNotice();
  } catch (e) {
    console.info('[ytdl-bg] Maintenance status check skipped:', e?.message || e);
  }
}

chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MAINTENANCE_ALARM) refreshMaintenanceNotice();
});

// content.js は raw.githubusercontent.com への host_permissions を持つ同じ拡張の一部なので、
// キャッシュが無い(インストール直後で alarm 未発火)場合は OchaMaintenance.refreshNotice() を
// 直接呼べる。ここへメッセージを中継する必要はない。

// ─── PO Token capture ────────────────────────────────────────────────────────
// YouTube の動画再生は googlevideo へのリクエストに &pot=<PO Token> を付ける。
// PO Token 無しだと adaptive ストリームは先頭~20MB しか落とせない(403)。
// ページが生成・使用している pot を横取りして storage.session に保存し、
// popup のダウンロード時に同じセッションのURLへ流用する。
// WebPO pot は visitorData/datasync にバインドされフォーマット非依存。

let _lastPot = null;
let _seen = 0, _potHits = 0;

function savePot(pot, where, tabId) {
  if (!pot || pot === _lastPot) return;
  _lastPot = pot;
  _potHits++;
  chrome.storage.session.set({ gvsPot: pot, gvsPotTs: Date.now(), gvsPotTabId: tabId });
  console.log(`[ytdl-bg] PO Token captured from ${where} (len=${pot.length}):`, pot.slice(0, 24) + '…');
}

// SABR の videoplayback は POST で、pot が URL ではなく protobuf ボディ側に
// 入ることがある。pot は base64url 文字列なので、ボディから最長の base64url 連続を
// 取り出して候補とする（URL に pot があればそちらを優先）。
function extractPotFromBody(requestBody) {
  try {
    const raw = requestBody?.raw;
    if (!raw || !raw.length) return null;
    let bin = '';
    for (const part of raw) {
      if (!part.bytes) continue;
      const bytes = new Uint8Array(part.bytes);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    }
    const matches = bin.match(/[A-Za-z0-9_-]{80,}={0,2}/g);
    if (!matches) return null;
    // 最長の base64url 連続を pot 候補とする
    return matches.reduce((a, b) => (b.length > a.length ? b : a));
  } catch (_) {
    return null;
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    _seen++;
    try {
      const urlPot = new URL(details.url).searchParams.get('pot');
      if (urlPot) {
        savePot(urlPot, 'URL', details.tabId);
        return;
      }
      if (details.method === 'POST' && details.requestBody) {
        const bodyPot = extractPotFromBody(details.requestBody);
        if (bodyPot) savePot(bodyPot, 'POST body', details.tabId);
      }
    } catch (_) {}
    if (_seen % 20 === 0) console.log(`[ytdl-bg] googlevideo requests seen=${_seen}, pot captured=${_potHits}`);
  },
  { urls: ['*://*.googlevideo.com/*'] },
  ['requestBody']
);

// ─── ページ内UIからのダウンロード依頼 ────────────────────────────────────────
// content script は storage.session に書けず(untrusted context)、windows も開けない。
// また googlevideo は content script からは取得できない(クロスオリジンのリダイレクト先が
// ACAO を返さず、MV3 の content script には host_permissions による CORS 免除が無い)。
// なのでページ側は「何を落とすか」だけを送り、実行は従来どおり popup.html?job= の
// ワーカーウィンドウが担う。tabId はここで sender から取れる。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'ocha:download') return;

  (async () => {
    try {
      const job = msg.job || {};
      if (!Array.isArray(job.items) || job.items.length === 0) {
        throw new Error('ジョブが空です');
      }
      job.ctx = { ...(job.ctx || {}), tabId: sender.tab?.id ?? null };

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await chrome.storage.session.set({ ['ochaJob:' + id]: job });
      await chrome.windows.create({
        url: chrome.runtime.getURL('src/popup.html') + '?job=' + id,
        type: 'popup',
        width: 480,
        height: 280,
        focused: true
      });
      sendResponse({ ok: true });
    } catch (e) {
      console.warn('[ytdl-bg] download dispatch failed:', e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;   // 非同期で応答する
});

chrome.runtime.onInstalled.addListener(() => {
  refreshActiveTab();
  refreshMaintenanceNotice();
});

chrome.runtime.onStartup.addListener(() => {
  refreshActiveTab();
  refreshMaintenanceNotice();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError) return;
    updateAction(tabId, tab?.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateAction(tabId, changeInfo.url || tab?.url);
});

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) updateAction(tab.id, tab.url);
}

function updateAction(tabId, url) {
  const youtube = isYoutubeUrl(url);
  const videoId = extractYouTubeVideoId(url);

  if (youtube) {
    chrome.action.enable(tabId);
    chrome.action.setBadgeText({ tabId, text: videoId ? 'YT' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#cc0000' });
    chrome.action.setTitle({
      tabId,
      title: videoId ? 'YT Downloader: この動画で使用可能' : 'YT Downloader: YouTubeで有効'
    });
    return;
  }

  chrome.action.disable(tabId);
  chrome.action.setBadgeText({ tabId, text: '' });
  chrome.action.setTitle({ tabId, title: 'YT Downloader: YouTubeでのみ使用可能' });
}

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
    if (!isYoutubeUrl(url)) return null;

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
