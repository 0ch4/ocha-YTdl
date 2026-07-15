/*
 * YouTube の視聴ページに切り出し範囲の指定UIを差し込む。
 * 範囲はプレイヤーの再生位置から取るので、popup に時刻を手入力しなくてよくなる。
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

const state = { videoId: null, startText: null, endText: null, open: false };
let els = null;

function currentVideoId() {
  const url = new URL(location.href);
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const shorts = url.pathname.match(/^\/shorts\/([\w-]{5,})/);
  return shorts ? shorts[1] : null;
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
    wash: 'rgba(255,255,255,.05)'
  },
  light: {
    hover: 'rgba(0,0,0,.1)',
    rim: 'rgba(0,0,0,.05)',
    wash: 'rgba(255,255,255,.2)'
  }
};
const hosts = new Set();

function applyTheme() {
  const t = document.documentElement.hasAttribute('dark') ? THEME.dark : THEME.light;
  for (const host of hosts) {
    host.style.setProperty('--ocha-hover', t.hover);
    host.style.setProperty('--ocha-rim', t.rim);
    host.style.setProperty('--ocha-wash', t.wash);
  }
}

// テーマ切り替えは <html> の dark 属性の付け外しで起きる
new MutationObserver(applyTheme)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

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
  });
  button.appendChild(count);
  root.appendChild(button);
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

function buildPanel() {
  const host = el('div', { id: PANEL_HOST_ID });
  const root = host.attachShadow({ mode: 'open' });
  hosts.add(host);
  root.appendChild(styleSheet());
  const card = el('div', {},
    `${YT_FONT}margin:8px 0 0;padding:12px 16px;border-radius:12px;background:${YT_FILL};`
    + 'display:flex;flex-wrap:wrap;align-items:center;gap:10px 24px;');

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

  card.appendChild(start.row);
  card.appendChild(end.row);
  const note = el('span', {}, `color:${YT_DIM};font-size:12px;margin-left:auto;`);
  card.appendChild(note);
  root.appendChild(card);
  return { host, card, startValue: start.value, endValue: end.value, note };
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
    els.note.textContent = `長さ ${formatTime(end - start)} ・ 拡張アイコンから保存`;
  } else if (start != null || end != null) {
    els.note.textContent = '拡張アイコンから保存';
  } else {
    els.note.textContent = '再生位置から範囲を指定できます';
  }

  const label = startText || endText ? `${startText || '0:00'}〜${endText || ''}` : '';
  els.count.textContent = label;
  els.panelHost.style.display = state.open ? 'block' : 'none';
}

function mount() {
  const row = document.querySelector('#top-level-buttons-computed');
  const slot = document.querySelector('#middle-row');
  if (!row || !slot) return false;
  if (document.getElementById(BUTTON_HOST_ID) && document.getElementById(PANEL_HOST_ID)) return true;

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
  slot.appendChild(panel.host);
  applyTheme();

  els = {
    count: button.count,
    panelHost: panel.host,
    startValue: panel.startValue,
    endValue: panel.endValue,
    note: panel.note
  };
  render();
  return true;
}

async function init() {
  const videoId = currentVideoId();
  if (!videoId) return;
  if (videoId !== state.videoId) {
    // 別の動画に移ったら前の範囲は捨てる
    state.videoId = videoId;
    state.startText = null;
    state.endText = null;
    state.open = false;
    await restore();
  }
  if (!mount()) {
    // YouTube は SPA なので、行がまだ組み上がっていないことがある
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }
}

document.addEventListener('yt-navigate-finish', init);
init();
