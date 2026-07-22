/*
 * 更新推奨ステータスの判定ロジック。popup / background(定期チェック) / content(ページ内表示)
 * の3箇所から同じ判定を使うための共有先。ここへ切り出したのは「同じ判定を複数箇所に
 * コピーすると、そのうち一方だけ直してずれる」実例(Innertubeクライアント定義の突き合わせ)
 * が既にあったため。
 */
globalThis.OchaMaintenance = (() => {
  const STATUS_URL = 'https://raw.githubusercontent.com/0ch4/ocha-YTdl/main/docs/compat/latest.json';
  const STATUS_CACHE_MS = 24 * 60 * 60 * 1000;
  const UPDATE_GUIDE_URL = 'https://github.com/0ch4/ocha-YTdl/blob/main/docs/UPDATE_JA.md';
  const CACHE_KEY = 'maintenanceStatusCache';
  const SYNCED_MESSAGE_JA = '現在の同梱ロジックは最新互換性メタと同期しています。';

  async function fetchJson(url, options = {}) {
    const resp = await fetch(url, options);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    return resp.json();
  }

  async function getLatestStatus() {
    try {
      const cached = await chrome.storage.local.get(CACHE_KEY);
      const entry = cached?.[CACHE_KEY];
      if (entry?.fetchedAt && entry?.data && Date.now() - entry.fetchedAt < STATUS_CACHE_MS) {
        return entry.data;
      }
    } catch (_) {}

    const latest = await fetchJson(STATUS_URL, { cache: 'no-store' });
    if (latest?.schemaVersion !== 1) throw new Error('invalid maintenance status schema');

    try {
      await chrome.storage.local.set({ [CACHE_KEY]: { fetchedAt: Date.now(), data: latest } });
    } catch (_) {}

    return latest;
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

  function buildNotice(bundled, latest, currentVersion) {
    if (!bundled || !latest) return null;

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
    const message = latest.messageJa && latest.messageJa !== SYNCED_MESSAGE_JA ? latest.messageJa : null;

    return {
      severity,
      className,
      pillState,
      pillText,
      text: [title, ...(message ? [message] : []), ...reasons].join('\n')
    };
  }

  // background が定期チェックの結果を置く場所。popup/content はこれを読むだけでも良い。
  // notice 自体は「同期済みで表示するものが無い」時に null になるので、「まだ一度も
  // チェックしていない」との違いを wrapper の有無で区別する(素の null を保存すると
  // 両者が storage.get 上で見分けられなくなり、in-sync の度に無駄な再チェックが走る)。
  const NOTICE_CACHE_KEY = 'maintenanceNotice';

  async function refreshNotice() {
    const bundled = await fetchJson(chrome.runtime.getURL('src/generated/ytdlp-meta.json'));
    const latest = await getLatestStatus();
    const notice = buildNotice(bundled, latest, chrome.runtime.getManifest().version);
    await chrome.storage.local.set({ [NOTICE_CACHE_KEY]: { checkedAt: Date.now(), notice } });
    return notice;
  }

  // 未チェックと「チェック済みで通知なし」を区別するため、存在しなければ undefined を返す。
  async function getCachedNotice() {
    try {
      const stored = await chrome.storage.local.get(NOTICE_CACHE_KEY);
      const wrapper = stored?.[NOTICE_CACHE_KEY];
      return wrapper ? wrapper.notice : undefined;
    } catch (_) {
      return undefined;
    }
  }

  return {
    STATUS_URL,
    UPDATE_GUIDE_URL,
    NOTICE_CACHE_KEY,
    fetchJson,
    getLatestStatus,
    compareVersionText,
    buildNotice,
    refreshNotice,
    getCachedNotice
  };
})();
