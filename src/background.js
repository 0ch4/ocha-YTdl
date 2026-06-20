chrome.runtime.onInstalled.addListener(() => {
  refreshActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  refreshActiveTab();
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
