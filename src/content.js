/*
 * YouTube の視聴ページに UI を差し込む。ここは画面だけを持つ。
 *
 *   このファイルがやること : 範囲指定(再生位置から)、画質選択、ジョブの送出
 *   このファイルがやらないこと: googlevideo からの取得、合成、保存
 *
 * ダウンロード本体は popup.html?job= のワーカーウィンドウが行う。理由は2つ:
 *   - content script は googlevideo を取得できない(下の fetchFormats 手前の注記参照)
 *   - popup 側に pot・20MBの壁・バックオフ・保存完了の検知などの知見が既にある
 * ここに二つ目の実装を作ると、YouTubeが何か変えるたびに二箇所直すことになる。
 * 一度それをやって、popup が既に知っていたことを4つ踏み直した。繰り返さないこと。
 *
 * 見た目は YouTube 側に合わせる。--yt-spec-* トークンを参照しているので、
 * ライト/ダークの切り替えにも追従する（カスタムプロパティは shadow 境界を越えて継承される）。
 *
 * DOM は createElement / textContent だけで組むこと。YouTube は
 * `require-trusted-types-for 'script'` を強制しており innerHTML は弾かれる。
 */

const BUTTON_HOST_ID = 'ocha-ytdl-action-host';
const PANEL_HOST_ID = 'ocha-ytdl-panel-host';
const TRIM_DRAFT_KEY = 'trimDraft';

const state = { videoId: null, startText: null, endText: null, open: false, formats: [] };
let els = null;

// ─── 更新推奨ステータス ─────────────────────────────────────────
// popup を開かない人でも気づけるように、切り出しボタンに小さな点を出す。
// 取得・判定は src/shared/maintenance.js に一本化(popup/background と共有)。
// ここでは background が定期チェックで置いたキャッシュを読むだけ(自前fetchは保険のみ)。
// undefined=未取得, null=同期済み(表示なし), object=通知あり。
let _maintenanceNotice = undefined;
const MAINTENANCE_DOT_COLOR = {
  critical: '#cf8b7e',    // popup --err と同じ(茶系のテラコッタ赤)
  recommended: '#C9B47A', // popup --gold と同じ
  info: '#8FB37C'         // 玉露グリーン
};

function currentVideoId() {
  const url = new URL(location.href);
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const shorts = url.pathname.match(/^\/shorts\/([\w-]{5,})/);
  return shorts ? shorts[1] : null;
}

// Shorts は DOM の作りが別物なので、watch 用の差し込みを流用できない。
// SPA なので location だけが確実な判定材料（watch の DOM は隠れたまま残る）。
function isWatchPage() {
  return new URL(location.href).pathname === '/watch';
}

function isShortsPage() {
  return /^\/shorts\//.test(new URL(location.href).pathname);
}

// Shorts は幅で見た目が変わる。広い時は操作列が動画の右に出て大きな余白が残り、
// 狭くなると操作列が動画に重なって余白が消える。YouTube の分岐点を数値で写すと
// 向こうが変えた時に外れるので、**実際に空いている幅を測って**決める。
const SHORTS_PANEL_MIN_WIDTH = 340;

function shortsLayout() {
  const bar = document.querySelector('reel-action-bar-view-model');
  const container = document.querySelector('.ytReelPlayerOverlayViewModelActionsContainer');
  if (!bar || !container) return null;
  const b = bar.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  const free = Math.round(c.right - b.right);      // 操作列の右に残っている余白
  return { bar, container, free, roomy: free >= SHORTS_PANEL_MIN_WIDTH };
}

function videoEl() {
  return document.querySelector('video.html5-main-video') || document.querySelector('video');
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

function parseTimeText(text) {
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

// muxer へ渡す時刻。popup.js の formatSecondsForFfmpeg と同じ HH:MM:SS 形式にする。
// 表示用の "0:06" をそのまま渡さないこと。
function formatForFfmpeg(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const sec = s % 1 === 0
    ? String(s).padStart(2, '0')
    : s.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

// popup 側の既存の入力欄にそのまま流し込めるよう、表示テキストのまま保存する。
async function persist() {
  try {
    if (!state.startText && !state.endText) {
      await chrome.storage.local.remove(TRIM_DRAFT_KEY);
      return;
    }
    await chrome.storage.local.set({
      [TRIM_DRAFT_KEY]: { videoId: state.videoId, startText: state.startText, endText: state.endText }
    });
  } catch (_) {
    // 拡張が再読み込みされた直後などにコンテキストが失われることがある
  }
}

async function restore() {
  try {
    const stored = await chrome.storage.local.get(TRIM_DRAFT_KEY);
    const draft = stored?.[TRIM_DRAFT_KEY];
    if (draft && draft.videoId === state.videoId) {
      state.startText = draft.startText || null;
      state.endText = draft.endText || null;
    }
  } catch (_) {}
}

function el(tag, props = {}, styles = '') {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (styles) node.setAttribute('style', styles);
  return node;
}

// ─── フォーマット取得 ───────────────────────────────────────
// android_vr は直URLを返し、n も sig も pot も要らない。この content script は
// www.youtube.com 上で動くので、youtubei への呼び出しは同一オリジンで安全。
//
// 【重要】googlevideo は違う。ここには「youtube.com オリジンには CORS を許可して
// いるので content script だけで完結する」と書いてあったが、それは誤り。許可される
// のは最初のホストだけで、**GVS は混雑時に予備ホストへリダイレクトし、その先は ACAO
// を返さない**（URL の mn= に予備ホストが列挙されている）。クロスオリジンのリダイレクト
// 後は Origin が null 扱いになるため CORS で遮断され、fetch が Failed to fetch になる。
// 実測ログ: rr3---sn-3pm7dnek → rr1---sn-oguelnlz へのリダイレクトで16チャンク中7個目が失敗。
// MV3 の content script は host_permissions による CORS 免除を持たないので、ここでは
// 回避不能。popup が無傷なのは拡張ページで CORS の対象外だから。
// → googlevideo への fetch は content script から行ってはいけない。

const CFG = () => globalThis.OCHA_YTDL_YOUTUBE_CONFIG;

// ページ内から使えるのは pot も sts も要らないクライアントだけ。
const PAGE_CLIENTS = ['android_vr', 'visionos'];

// visitorData が無いと LOGIN_REQUIRED（bot検問）になる。実測では Cookie でも sts でも
// UA でもなく、この X-Goog-Visitor-Id ヘッダの有無だけで OK と LOGIN_REQUIRED が
// 切り替わる。isolated world からは ytcfg を読めないが、ページのインライン script の
// textContent は読めるので、そこから拾う。
let _visitorData = null;
let _title = null;

// 応答から取れなかった時のフォールバック。popup.js:cleanYouTubeDocTitle と同じ扱い:
// document.title は未読通知があると "(4) タイトル - YouTube" になる。
function docTitle() {
  const t = String(document.title || '')
    .replace(/^\(\d+\)\s*/, '')                  // 未読通知数の接頭辞
    .replace(/\s*[-–—]\s*YouTube\s*$/i, '')
    .trim();
  return t && t.toLowerCase() !== 'youtube' ? t : null;
}

function visitorData() {
  if (_visitorData) return _visitorData;
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (!text.includes('visitorData')) continue;
    const m = text.match(/"visitorData":\s*"([^"]+)"/);
    if (!m) continue;
    _visitorData = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return _visitorData;
  }
  return null;
}

async function fetchFormats(videoId) {
  const cfg = CFG();
  const failures = [];

  for (const key of PAGE_CLIENTS) {
    const profile = cfg?.innertubeClientProfiles?.find(p => p.key === key);
    if (!profile) continue;
    try {
      return await fetchWithClient(videoId, profile, cfg);
    } catch (e) {
      failures.push(`${key}: ${e.message}`);
      console.info(`[ytdl] ${key} では取得できず`, e?.message || e);
    }
  }

  // 実測で確定しているのは「visitorData の有無だけが OK と LOGIN_REQUIRED を分ける」
  // ことだけ(有りで12/12、無しで1/12)。それ以外の原因は特定できていないので、
  // 分かっていないことを分かったように書かないこと。
  const blocked = failures.some(f => /LOGIN_REQUIRED/.test(f));
  if (blocked && !visitorData()) {
    throw new Error('visitorData をページから取得できませんでした。ページを再読み込みしてください');
  }
  throw new Error(blocked
    ? `取得を拒否されました（${failures.join(' / ')}）。拡張アイコンのパネルから試してください`
    : failures.join(' / ') || 'フォーマットを取得できません');
}

async function fetchWithClient(videoId, profile, cfg) {
  const visitor = visitorData();
  const headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': String(cfg.clientNameHeaders[profile.clientName]),
    'X-YouTube-Client-Version': profile.clientVersion
  };
  if (visitor) headers['X-Goog-Visitor-Id'] = visitor;

  const client = { ...profile.contextClient };
  if (visitor) client.visitorData = visitor;

  const resp = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(cfg.defaultInnertubeApiKey)}&prettyPrint=false`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        context: { client },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      })
    }
  );
  const data = await resp.json();
  const status = data?.playabilityStatus?.status;
  if (status && status !== 'OK') {
    throw new Error(`${status}: ${data.playabilityStatus.reason || ''}`);
  }
  const sd = data?.streamingData;
  if (!sd) throw new Error('streamingData がありません');

  // タイトルは応答のものを使う。document.title には未読通知の "(4) " が付くので
  // ファイル名にそのまま入ってしまう（popup.js:cleanYouTubeDocTitle も同じ理由で剥がす）。
  _title = data?.videoDetails?.title || _title;

  // ここで組み立てる形は popup.js:349-361 が作るものと同じ契約。ワーカー
  // (popup.html?job=) の runJobItems → fetchFormatBytes がそのまま消費する。
  // 特に source は必須: popup.js:358 が isPotFreeSource(source) で potFree を決め、
  // それが 20MB ガード(popup.js:1739)の分岐になる。source を落とすと pot必須扱いされ、
  // android_vr 由来なのに 20MB で弾かれる。
  const out = [];
  const take = (list, progressive) => {
    for (const f of list || []) {
      if (!f.url) continue;   // SABR-only 応答はここで落ちる
      const mime = f.mimeType || '';
      const isVideo = mime.startsWith('video/');
      out.push({
        itag: f.itag,
        url: f.url,
        quality: f.qualityLabel || f.quality || String(f.itag),
        mimeType: mime,
        ext: /webm/.test(mime) ? 'webm' : /mp4/.test(mime) ? 'mp4' : 'bin',
        isMuxed: Boolean(progressive && isVideo),
        hasVideo: isVideo,
        // progressive(itag18 等) は video/mp4 だが音声を含む
        hasAudio: !isVideo || progressive,
        source: profile.key,
        potFree: (CFG()?.potFreeSources || []).includes(profile.key),
        height: f.height || null,
        fps: f.fps || null,
        bitrate: f.bitrate || 0,
        qualityLabel: f.qualityLabel || null,
        audioQuality: f.audioQuality || null,
        contentLength: Number(f.contentLength) || null,
        codec: (mime.match(/codecs="([^"]+)"/) || [])[1] || ''
      });
    }
  };
  take(sd.formats, true);
  take(sd.adaptiveFormats, false);
  if (!out.length) throw new Error('取得できるフォーマットがありません');
  return out;
}

const YT_TEXT = 'var(--yt-spec-text-primary, #f1f1f1)';
const YT_DIM = 'var(--yt-spec-text-secondary, #aaa)';
const YT_FILL = 'var(--yt-spec-additive-background, rgba(255,255,255,.1))';
const YT_FONT = 'font-family:"Roboto","Arial",sans-serif;';

// 純正ボタンから実測した値。純正はいずれも難読化された変数(--t416e5931fc464589 等)を
// 経由しているが、あの名前はデプロイごとに変わるので参照してはいけない。
// テーマは <html> の dark 属性の有無で判定し、値はこちらで持つ。
const THEME = {
  dark: {
    // .ytSpecButtonShapeNextMono.ytSpecButtonShapeNextTonal:hover
    hover: 'rgba(255,255,255,.2)',
    // .contribYtLightShapeStaticRimLightTonal::before
    rim: 'rgba(255,255,255,.1)',
    // .contribYtLightShapeStaticWashLightTonal
    wash: 'rgba(255,255,255,.05)',
    // select を開いた時の項目。ここだけは不透明でなければならない:
    // --yt-spec-additive-background は半透明の白なので、OS が描く option の下地が
    // 透けて白くなり、白い文字と重なって読めなくなる。値は YouTube の実メニュー
    // 背景(rgb(33,33,33))から採った。
    menuBg: '#212121',
    menuFg: '#f1f1f1'
  },
  light: {
    hover: 'rgba(0,0,0,.1)',
    rim: 'rgba(0,0,0,.05)',
    wash: 'rgba(255,255,255,.2)',
    menuBg: '#fff',
    menuFg: '#0f0f0f'
  }
};
const hosts = new Set();

function applyTheme() {
  const t = document.documentElement.hasAttribute('dark') ? THEME.dark : THEME.light;
  for (const host of hosts) {
    host.style.setProperty('--ocha-hover', t.hover);
    host.style.setProperty('--ocha-rim', t.rim);
    host.style.setProperty('--ocha-wash', t.wash);
    host.style.setProperty('--ocha-menu-bg', t.menuBg);
    host.style.setProperty('--ocha-menu-fg', t.menuFg);
  }
}

// テーマ切り替えは <html> の dark 属性の付け外しで起きる
new MutationObserver(applyTheme)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

// 点は host(shadow root)側に都度探しに行く。専用の Set で参照を持ち回らないのは、
// SPA 再遷移で unmount → 再 mount を繰り返すたびに古い(既に外れた)要素の参照が
// 溜まっていくのを避けるため。hosts は mount/unmount が既に正しく管理している。
function applyMaintenanceNotice() {
  const notice = _maintenanceNotice;
  for (const host of hosts) {
    const dot = host.shadowRoot?.querySelector('.maint-dot');
    if (!dot) continue;
    if (notice) {
      dot.style.display = 'inline-block';
      dot.style.backgroundColor = MAINTENANCE_DOT_COLOR[notice.severity] || MAINTENANCE_DOT_COLOR.recommended;
      dot.title = notice.text;
    } else {
      dot.style.display = 'none';
      dot.title = '';
    }
  }
}

function buildMaintenanceDot(styles) {
  const dot = el('span', { className: 'maint-dot' },
    `display:none;width:6px;height:6px;border-radius:50%;cursor:pointer;${styles || ''}`);
  dot.addEventListener('click', e => {
    e.stopPropagation();
    window.open(OchaMaintenance.UPDATE_GUIDE_URL, '_blank', 'noopener');
  });
  return dot;
}

async function loadMaintenanceNotice() {
  try {
    let notice = await OchaMaintenance.getCachedNotice();
    if (notice === undefined) {
      // インストール直後などまだ background の定期チェック(alarm)が一度も走って
      // いない場合の保険。以後は alarm 任せにし、ページ読み込みのたびには叩かない。
      notice = await OchaMaintenance.refreshNotice().catch(() => null);
    }
    _maintenanceNotice = notice || null;
  } catch (_) {
    _maintenanceNotice = null;
  }
  applyMaintenanceNotice();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[OchaMaintenance.NOTICE_CACHE_KEY]) return;
  _maintenanceNotice = changes[OchaMaintenance.NOTICE_CACHE_KEY].newValue?.notice || null;
  applyMaintenanceNotice();
});

loadMaintenanceNotice();

function styleSheet() {
  // :hover は style 属性では表現できないので shadow root に <style> を持たせる。
  // textContent は TrustedHTML のシンクではないため Trusted Types に抵触しない。
  const style = document.createElement('style');
  style.textContent = `
    .pill, .chip, .ghost {
      ${YT_FONT}
      border: 0;
      color: ${YT_TEXT};
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      white-space: nowrap;
      position: relative;
      overflow: hidden;
      transition: background-color 0.1s ease;
    }
    .pill {
      height: 40px; border-radius: 20px; padding: 0 16px; gap: 6px;
      background: ${YT_FILL}; font-size: 14px;
    }
    .chip {
      height: 32px; border-radius: 16px; padding: 0 14px;
      background: ${YT_FILL}; font-size: 13px;
    }
    .ghost {
      height: 32px; border-radius: 16px; padding: 0 12px;
      background: transparent; color: ${YT_DIM}; font-size: 13px; font-weight: 400;
    }
    /* Shorts の操作列の項目。純正から実測: ボタン 48x48 / radius 24px /
       additive背景 / アイコン24x24 / 下に10pxのラベル、1項目 48x78 の縦積み。 */
    .reel-item {
      display: flex; flex-direction: column; align-items: center;
      width: 48px; cursor: pointer; background: none; border: 0; padding: 0;
      ${YT_FONT}
    }
    .reel-circle {
      width: 48px; height: 48px; border-radius: 24px;
      display: flex; align-items: center; justify-content: center;
      background: ${YT_FILL}; color: ${YT_TEXT};
      position: relative; overflow: hidden;
      transition: background-color 0.1s ease;
    }
    .reel-item:hover .reel-circle, .reel-item:focus-visible .reel-circle {
      background: var(--ocha-hover, ${THEME.dark.hover});
    }
    .reel-circle::before {
      content: ""; position: absolute; left: 0; bottom: 50%;
      width: 100%; height: 100%; border-radius: inherit;
      background: var(--ocha-wash, ${THEME.dark.wash});
      filter: blur(10px); pointer-events: none;
    }
    .reel-circle::after {
      content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 0.5px;
      background: linear-gradient(var(--ocha-rim, ${THEME.dark.rim}), transparent 75%);
      mask: linear-gradient(#fff 0, #fff 0) content-box exclude,
            linear-gradient(#fff 0, #fff 0) exclude;
      pointer-events: none;
    }
    .reel-label {
      font-size: 10px; font-weight: 400; color: ${YT_TEXT};
      margin-top: 4px; white-space: nowrap;
    }

    /* YouTube は素の select を使わないが、チップに寄せておけば行の中で浮かない */
    .sel {
      ${YT_FONT}
      height: 32px; border: 0; border-radius: 16px; padding: 0 10px;
      background: ${YT_FILL}; color: ${YT_TEXT};
      font-size: 13px; font-weight: 500; cursor: pointer;
      max-width: 220px;
    }
    .sel:hover, .sel:focus-visible { background: var(--ocha-hover, ${THEME.dark.hover}); }
    .sel:disabled { opacity: .5; cursor: default; }
    /* 展開した項目は OS が描くので、閉じている時の半透明の背景を継がせてはいけない。
       透けて白地になり、白文字と重なって読めなくなる。不透明色を明示する。 */
    .sel option {
      background: var(--ocha-menu-bg, ${THEME.dark.menuBg});
      color: var(--ocha-menu-fg, ${THEME.dark.menuFg});
    }
    .chip:disabled { opacity: .5; cursor: default; }
    .pill:hover, .chip:hover, .ghost:hover,
    .pill:focus-visible, .chip:focus-visible, .ghost:focus-visible {
      background: var(--ocha-hover, ${THEME.dark.hover});
    }

    /* 純正の tonal ボタンは面の上に yt-light-shape を重ねている。中身は2層で、
       上半分からにじむ「ウォッシュ」と、縁 0.5px だけの「リム」。
       ここでは要素を足さず疑似要素で同じものを描く。純正も shape が最後の子なので、
       アイコンや文字の上に乗るのは同じ挙動。 */
    .pill::before, .chip::before {          /* ウォッシュ: 上半分にはみ出す箱をぼかし、overflow で切る */
      content: "";
      position: absolute;
      left: 0; bottom: 50%;
      width: 100%; height: 100%;
      border-radius: inherit;
      background: var(--ocha-wash, ${THEME.dark.wash});
      filter: blur(10px);
      pointer-events: none;
    }
    .pill::after, .chip::after {            /* リム: padding 0.5px の輪だけをマスクで残す */
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 0.5px;
      background: linear-gradient(var(--ocha-rim, ${THEME.dark.rim}), transparent 75%);
      mask: linear-gradient(#fff 0, #fff 0) content-box exclude,
            linear-gradient(#fff 0, #fff 0) exclude;
      pointer-events: none;
    }
  `;
  return style;
}

// 隣の 共有 / 保存 はいずれも 24x24 のアイコンを伴うので、揃えないとここだけ浮く。
// innerHTML は使えないため createElementNS で組む。
function cutIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 '
    + '1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 '
    + '4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 '
    + '2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5'
    + '.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z');
  svg.appendChild(path);
  return svg;
}

function buildButton() {
  const host = el('div', { id: BUTTON_HOST_ID }, 'display:flex;align-items:center;margin-left:8px;');
  const root = host.attachShadow({ mode: 'open' });
  hosts.add(host);
  root.appendChild(styleSheet());
  // 純正ピルと同寸: 高さ40px / radius 20px / additive背景 / Roboto 14px 500 / padding 0 16px
  const button = el('button', { type: 'button', className: 'pill' });
  button.appendChild(cutIcon());
  button.appendChild(el('span', { textContent: '切り出し' }));
  const count = el('span', { textContent: '' }, `color:${YT_DIM};font-size:12px;font-weight:400;`);
  button.addEventListener('click', () => {
    state.open = !state.open;
    render();
    // 開くまで player API は叩かない。開いた時に一度だけ取る。
    if (state.open && !state.formats.length) loadFormats();
  });
  button.appendChild(count);
  root.appendChild(button);
  root.appendChild(buildMaintenanceDot('margin-left:8px;'));
  applyMaintenanceNotice();
  return { host, button, count };
}

function labelledRow(label, onSet, onClear) {
  const row = el('div', {}, 'display:flex;align-items:center;gap:10px;');
  row.appendChild(el('span', { textContent: label }, `color:${YT_DIM};font-size:13px;min-width:2.5em;`));
  const value = el('span', { textContent: '—' },
    `color:${YT_TEXT};font-size:14px;font-weight:500;min-width:4.5em;font-variant-numeric:tabular-nums;`);
  row.appendChild(value);
  const set = el('button', { type: 'button', textContent: '現在位置', className: 'chip' });
  set.addEventListener('click', onSet);
  row.appendChild(set);
  const clear = el('button', { type: 'button', textContent: '解除', className: 'ghost' });
  clear.addEventListener('click', onClear);
  row.appendChild(clear);
  return { row, value };
}

function buildSaveRow() {
  const row = el('div', {}, 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;');
  row.appendChild(el('span', { textContent: '保存' }, `color:${YT_DIM};font-size:13px;min-width:2.5em;`));

  const quality = el('select', { className: 'sel' });
  const ext = el('select', { className: 'sel' });
  const audio = el('select', { className: 'sel' });
  row.appendChild(quality);
  row.appendChild(ext);
  row.appendChild(audio);

  const save = el('button', { type: 'button', textContent: '保存', className: 'chip' });
  const note = el('span', { textContent: '' }, `color:${YT_DIM};font-size:12px;margin-left:auto;`);
  row.appendChild(note);
  row.appendChild(save);
  return { row, quality, ext, audio, save, note };
}

function buildPanel() {
  const host = el('div', { id: PANEL_HOST_ID });
  const root = host.attachShadow({ mode: 'open' });
  hosts.add(host);
  root.appendChild(styleSheet());
  const card = el('div', {},
    `${YT_FONT}margin:8px 0 0;padding:12px 16px;border-radius:12px;background:${YT_FILL};`
    + 'display:flex;flex-direction:column;gap:10px;');

  const trimRow = el('div', {}, 'display:flex;flex-wrap:wrap;align-items:center;gap:10px 24px;');

  const start = labelledRow('開始', () => {
    const video = videoEl();
    if (!video) return;
    state.startText = formatTime(video.currentTime);
    persist();
    render();
  }, () => { state.startText = null; persist(); render(); });

  const end = labelledRow('終了', () => {
    const video = videoEl();
    if (!video) return;
    state.endText = formatTime(video.currentTime);
    persist();
    render();
  }, () => { state.endText = null; persist(); render(); });

  trimRow.appendChild(start.row);
  trimRow.appendChild(end.row);
  const note = el('span', {}, `color:${YT_DIM};font-size:12px;margin-left:auto;`);
  trimRow.appendChild(note);
  card.appendChild(trimRow);

  const saveRow = buildSaveRow();
  card.appendChild(saveRow.row);

  root.appendChild(card);
  return {
    host, card, startValue: start.value, endValue: end.value, note,
    quality: saveRow.quality, ext: saveRow.ext, audio: saveRow.audio,
    save: saveRow.save, saveNote: saveRow.note
  };
}

// ─── 品質選択と保存 ─────────────────────────────────────────

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const o of options) select.appendChild(option(o.value, o.label));
  select.disabled = options.length === 0;
}

function selectedVideoFormat() {
  const height = els.quality.value;
  const ext = els.ext.value;
  return state.formats
    .filter(f => f.hasVideo && !f.hasAudio && String(f.height) === height && f.ext === ext)
    .sort((a, b) => b.bitrate - a.bitrate)[0] || null;
}

function selectedAudioFormat() {
  return state.formats.find(f => String(f.itag) === els.audio.value) || null;
}

function refreshExtOptions() {
  const height = els.quality.value;
  const at = state.formats.filter(f => f.hasVideo && !f.hasAudio && String(f.height) === height);
  // 同じ画質でも webm(VP9) は mp4(AV1) よりかなり重い。2160p では 342MB と 229MB
  // ほど違うので、既定は mp4 にする。配列順のままだと重い方が既定になってしまう。
  const exts = [...new Set(at.map(f => f.ext))].sort((a, b) => (a === 'mp4' ? -1 : b === 'mp4' ? 1 : 0));
  const keep = els.ext.value;
  fillSelect(els.ext, exts.map(e => {
    const size = at.filter(f => f.ext === e).sort((x, y) => y.bitrate - x.bitrate)[0]?.contentLength;
    return { value: e, label: size ? `${e} ${(size / 1048576).toFixed(0)}MB` : e };
  }));
  if (exts.includes(keep)) els.ext.value = keep;
}

function renderPicker() {
  if (!els || !state.formats.length) return;

  const heights = [...new Set(state.formats.filter(f => f.hasVideo && !f.hasAudio && f.height).map(f => f.height))]
    .sort((a, b) => b - a);
  fillSelect(els.quality, heights.map(h => {
    const best = state.formats.filter(f => f.hasVideo && !f.hasAudio && f.height === h)
      .sort((a, b) => (b.fps || 0) - (a.fps || 0))[0];
    // 表示は応答の qualityLabel を使う。height から作ると縦動画で破綻する:
    // Shorts は 1080x1920 なので height は 1920 だが、YouTube は短辺で 1080p と呼ぶ。
    const label = best?.qualityLabel || `${h}p`;
    return { value: String(h), label };
  }));

  const audios = state.formats.filter(f => f.hasAudio && !f.hasVideo).sort((a, b) => b.bitrate - a.bitrate);
  fillSelect(els.audio, audios.map(f => ({
    value: String(f.itag),
    label: `${f.ext} ${Math.round(f.bitrate / 1000)}k`
  })));

  refreshExtOptions();      // 画質ごとに使える形式は違う
  els.save.disabled = false;
}


// ダウンロード本体はここではやらない。googlevideo は content script からは
// 取れず(上の注記参照)、popup.html?job= のワーカーが pot・20MBガード・バックオフ・
// 合成・保存完了の検知まで既に持っている。ここはジョブを投げるだけにする。
// storage.session は untrusted context からは書けないので、SW に依頼する。
async function doSave() {
  const video = selectedVideoFormat();
  const audio = selectedAudioFormat();
  if (!video || !audio) { els.saveNote.textContent = 'フォーマットを選んでください'; return; }

  const s = parseTimeText(state.startText);
  const e = parseTimeText(state.endText);
  if (s != null && e != null && e <= s) { els.saveNote.textContent = '終了は開始より後にしてください'; return; }
  // popup.js 側の契約(readTrimInputs/muxStreams/trimSuffix)と同じ形にすること:
  // start/end は生の秒数(ファイル名生成の formatSecondsForFilename が算術する)、
  // startText/durationText が ffmpeg の -ss/-t にそのまま渡る "00:00:06" 形式の文字列。
  // 以前はここが逆(start に文字列、duration というキー名)になっていて、
  // ファイル名が NaN-NaN-... になり、かつ -t が渡らず終了位置が無視されていた。
  const trim = (s == null && e == null) ? null : {
    start: s ?? 0,
    end: e,
    startText: formatForFfmpeg(s ?? 0),
    endText: e == null ? null : formatForFfmpeg(e),
    durationText: (s != null && e != null) ? formatForFfmpeg(e - s) : null
  };

  els.save.disabled = true;
  els.saveNote.textContent = '準備中...';
  try {
    // 署名URLは expire を持つ。パネルを開いたまま放置された後でも通るよう、
    // 投げる直前に取り直す。
    const fresh = await fetchFormats(state.videoId);
    const pick = itag => fresh.find(f => f.itag === itag);
    const v = pick(video.itag) || video;
    const a = pick(audio.itag) || audio;

    const res = await chrome.runtime.sendMessage({
      type: 'ocha:download',
      job: {
        videoTitle: _title || docTitle() || 'video',
        items: [{ kind: 'mux', video: v, audio: a, trim }],
        ctx: { videoId: state.videoId, visitorData: visitorData() },
        // ワーカーは拡張ページなので YouTube のテーマを自力で知れない。ここで渡す。
        theme: document.documentElement.hasAttribute('dark') ? 'dark' : 'light'
      }
    });
    if (!res?.ok) throw new Error(res?.error || 'ダウンロードを開始できませんでした');
    els.saveNote.textContent = 'ダウンロードウィンドウで実行中';
  } catch (err) {
    els.saveNote.textContent = 'エラー: ' + (err?.message || err);
    console.error('[ytdl] dispatch failed:', err);
  } finally {
    els.save.disabled = false;
  }
}

// 狭い Shorts 用。選ばせる場所が無いので、最高画質の mp4 と最高音質で送る。
// 範囲は指定しようがないので全長。
async function quickSave(labelEl) {
  // パネルを開かないので、進捗はボタンのラベルに出すしかない
  const say = text => { if (labelEl) labelEl.textContent = text; };
  const restore = () => setTimeout(() => say('切り出し'), 4000);
  say('準備中');
  try {
    const formats = await fetchFormats(state.videoId);
    const video = formats.filter(f => f.hasVideo && !f.hasAudio)
      .sort((a, b) => (b.height - a.height) || (a.ext === 'mp4' ? -1 : 1) || (b.bitrate - a.bitrate))[0];
    const audio = formats.filter(f => f.hasAudio && !f.hasVideo)
      .sort((a, b) => b.bitrate - a.bitrate)[0];
    if (!video || !audio) throw new Error('フォーマットが見つかりません');

    const res = await chrome.runtime.sendMessage({
      type: 'ocha:download',
      job: {
        videoTitle: _title || docTitle() || 'video',
        items: [{ kind: 'mux', video, audio, trim: null }],
        ctx: { videoId: state.videoId, visitorData: visitorData() },
        theme: document.documentElement.hasAttribute('dark') ? 'dark' : 'light'
      }
    });
    if (!res?.ok) throw new Error(res?.error || 'ダウンロードを開始できませんでした');
    say('開始');
    restore();
  } catch (err) {
    say('失敗');
    restore();
    console.error('[ytdl] quick save failed:', err);
  }
}

async function loadFormats() {
  if (!els) return;
  els.save.disabled = true;
  els.saveNote.textContent = 'フォーマットを取得中...';
  try {
    state.formats = await fetchFormats(state.videoId);
    renderPicker();
    els.saveNote.textContent = '';
  } catch (e) {
    els.saveNote.textContent = '取得できません: ' + (e?.message || e);
    console.warn('[ytdl] format fetch failed:', e);
  }
}

function render() {
  if (!els) return;
  const { startText, endText } = state;
  els.startValue.textContent = startText || '—';
  els.endValue.textContent = endText || '—';

  const start = parseTimeText(startText);
  const end = parseTimeText(endText);
  if (start != null && end != null && end <= start) {
    els.note.textContent = '終了は開始より後にしてください';
  } else if (start != null && end != null) {
    els.note.textContent = `長さ ${formatTime(end - start)}`;
  } else if (start != null || end != null) {
    els.note.textContent = '片側だけなら残りは端まで';
  } else {
    els.note.textContent = '再生位置から範囲を指定できます';
  }

  const label = startText || endText ? `${startText || '0:00'}〜${endText || ''}` : '';
  els.count.textContent = label;
  els.panelHost.style.display = state.open ? 'block' : 'none';
}

function unmount() {
  for (const id of [BUTTON_HOST_ID, PANEL_HOST_ID]) {
    const host = document.getElementById(id);
    if (!host) continue;
    hosts.delete(host);
    host.remove();
  }
  els = null;
}

function mount() {
  if (isShortsPage()) return mountShorts();
  return mountWatch();
}

// 「存在する」と「実際に表示されている」は別。YouTube側の遷移中にホストだけが
// 非表示の親に取り残されると、存在チェックだけでは永久に気づけない
// (中身を作り直しても同じ非表示の親に置くだけで意味が無いため)。
// isConnected は詳細度チェック用、offsetParent は非表示(display:none 系)の検出用。
function isMounted() {
  const button = document.getElementById(BUTTON_HOST_ID);
  const panel = document.getElementById(PANEL_HOST_ID);
  // ボタンとパネルの両方が生きていて初めて「差し込まれている」とする。
  // 片方だけ(特にパネル)が YouTube 側の再描画で消えたケースは、ここで false を
  // 返して ensureMounted に再差し込みさせる。パネルは開いていない時に display:none に
  // なる(offsetParent が null)ため、offsetParent はボタンだけを見る。
  return !!(button && panel && button.isConnected && panel.isConnected && button.offsetParent);
}

// Shorts は操作列が縦で、パネルを置く余白は幅次第。広い時は動画の右に余白が残るので
// そこへ出し、狭くて操作列が動画に重なる時はボタンだけにする。分岐は実測した余白で決める。
function mountShorts() {
  const layout = shortsLayout();
  if (!layout) return false;
  if (isMounted()) return true;
  unmount();

  const host = el('div', { id: BUTTON_HOST_ID }, 'display:block;margin-top:16px;');
  const root = host.attachShadow({ mode: 'open' });
  hosts.add(host);
  root.appendChild(styleSheet());

  const item = el('button', { type: 'button', className: 'reel-item' });
  const circle = el('div', { className: 'reel-circle' });
  circle.appendChild(cutIcon());
  item.appendChild(circle);
  const reelLabel = el('span', { textContent: '切り出し', className: 'reel-label' });
  item.appendChild(reelLabel);
  item.style.position = 'relative';
  item.appendChild(buildMaintenanceDot('position:absolute;top:2px;right:2px;'));
  root.appendChild(item);
  applyMaintenanceNotice();
  layout.bar.appendChild(host);

  const panel = buildPanel();
  panel.host.setAttribute('style',
    'position:absolute;top:50%;transform:translateY(-50%);width:340px;max-width:calc(100% - 72px);left:60px;');
  layout.container.style.position = layout.container.style.position || 'relative';
  layout.container.appendChild(panel.host);

  item.addEventListener('click', () => {
    // 余白が無い幅では、開いても動画を覆うだけなので開かない。取得できたら
    // そのまま最高画質で送る。判定はその都度やる（幅は変わる）。
    if (!shortsLayout()?.roomy) {
      quickSave(reelLabel);
      return;
    }
    state.open = !state.open;
    render();
    if (state.open && !state.formats.length) loadFormats();
  });

  els = {
    count: el('span'),                    // Shorts のボタンには範囲を出す場所が無い
    panelHost: panel.host,
    startValue: panel.startValue,
    endValue: panel.endValue,
    note: panel.note,
    quality: panel.quality,
    ext: panel.ext,
    audio: panel.audio,
    save: panel.save,
    saveNote: panel.saveNote
  };
  els.quality.addEventListener('change', refreshExtOptions);
  els.save.addEventListener('click', doSave);
  els.save.disabled = true;
  applyTheme();
  render();
  return true;
}

function mountWatch() {
  // 差し込み先は watch ページの構造にしか無い。ID の存在だけで判断してはいけない:
  //   - Shorts にも #top-level-buttons-computed があるが、あれは
  //     ytd-shorts-player-controls > #right-controls、つまりプレイヤー右上の
  //     操作列(字幕/その他/全画面)で、高評価の行ではない。そこへ挿すとボタンが
  //     動画の上に出る。
  //   - Shorts にも #middle-row はあるが ytd-watch-flexy(display:none) の中なので
  //     パネルは永久に開かない。
  // 実際に watch ページを見ているかを URL で判定し、器も見えているものだけ使う。
  if (!isWatchPage()) return false;

  const row = document.querySelector('#top-level-buttons-computed');
  const slot = document.querySelector('#middle-row');
  if (!row || !slot) return false;
  // 隠れた watch DOM(Shorts が残していくもの)を拒否する。ただし #middle-row 自身の
  // 可視性で判断してはいけない: 空のとき display:none で、中身が入って初めて表示
  // される。watch ページの正常な状態がそれなので、器ではなく ytd-watch-flexy が
  // 生きているかを見る。Shorts ではそれが display:none になる。
  const flexy = slot.closest('ytd-watch-flexy');
  if (!row.offsetParent || !flexy || !flexy.offsetParent) return false;
  if (isMounted()) return true;

  for (const id of [BUTTON_HOST_ID, PANEL_HOST_ID]) {
    const stale = document.getElementById(id);
    if (stale) {
      hosts.delete(stale);
      stale.remove();
    }
  }

  const button = buildButton();
  const panel = buildPanel();
  row.appendChild(button.host);
  // 空の #middle-row が消えるのは `#middle-row.ytd-watch-metadata:empty { display:none }`
  // による。子を入れれば自動で表示されるので style は触らないこと。触ると撤去しても
  // インライン style が残り、空の帯が居座る。
  slot.appendChild(panel.host);
  applyTheme();

  els = {
    count: button.count,
    panelHost: panel.host,
    startValue: panel.startValue,
    endValue: panel.endValue,
    note: panel.note,
    quality: panel.quality,
    ext: panel.ext,
    audio: panel.audio,
    save: panel.save,
    saveNote: panel.saveNote
  };
  // 画質を変えると選べる形式が変わる
  els.quality.addEventListener('change', refreshExtOptions);
  els.save.addEventListener('click', doSave);
  els.save.disabled = true;
  render();
  return true;
}

let _lastKind = null;

async function init() {
  const videoId = currentVideoId();
  if (!videoId) { unmount(); return; }

  // watch と Shorts で差し込み先が違うので、種別が変わったら作り直す
  const kind = isShortsPage() ? 'shorts' : 'watch';
  if (kind !== _lastKind) { unmount(); _lastKind = kind; }
  if (videoId !== state.videoId) {
    // 別の動画に移ったら前の範囲は捨てる
    state.videoId = videoId;
    state.startText = null;
    state.endText = null;
    state.open = false;
    state.formats = [];
    _title = null;
    await restore();
  }
  mount();
}

// YouTube はナビゲーション後もアクション行を非同期に作り直すことがあり、その時に
// 差し込んだ要素ごと巻き添えで消える。一度置いて終わりにすると「リロードしないと
// ボタンが出ない」状態になるので、消えていたら置き直し続ける。
function ensureMounted() {
  // watch と Shorts では差し込み先が別物。ページ種別が変わったら、前の場所に
  // 居座らせず作り直す（watch の DOM は Shorts でも隠れて残るため）。
  if (!isWatchPage() && !isShortsPage()) { unmount(); return; }
  if (!currentVideoId()) return;
  if (isMounted()) return;
  mount();
}

let remountObserver = null;
let remountQueued = false;

function watchForRemount() {
  if (remountObserver) return;
  remountObserver = new MutationObserver(() => {
    // YouTube の DOM 変更は非常に多いので、実際の確認は1回にまとめる。
    // requestAnimationFrame は使わないこと。裏に回ったタブでは止まるので、
    // その間にボタンを消されると二度と戻らない（タブは頻繁に裏に回る）。
    if (remountQueued) return;
    remountQueued = true;
    setTimeout(() => {
      remountQueued = false;
      ensureMounted();
    }, 0);
  });
  // attributes も見る: 親要素の display/hidden がクラスやインラインstyleの変更だけで
  // 切り替わるケース(childList を伴わない)は childList 監視だけでは拾えない。
  remountObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'hidden', 'class']
  });

  // 保険: yt-navigate-finish の取りこぼしや、監視対象外のタイミングでの差し込みなど、
  // MutationObserver 単独では拾えないケースがある(shorts/watch どちらでも実際に発生し、
  // リロードするまでボタンが出ない報告があった)。原因を1つに絞れないので、低頻度の
  // ポーリングを平行して走らせて必ず自己修復させる。observe 同様、一度始めたら
  // ページが生きている限り回し続けて構わない(ensureMounted は既に何度呼んでも安全)。
  setInterval(ensureMounted, 800);
}

document.addEventListener('yt-navigate-finish', init);
init();
// セーフティネットは初期化の成否に関わらず必ず起動する。init が videoId 無しで
// 早期リターンしても、あとから SPA 遷移で watch/shorts に移れば ensureMounted が拾う。
watchForRemount();
