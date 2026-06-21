import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const OUT_PATH = path.join(ROOT, 'docs/images/popup-sample.svg');
const args = new Map(process.argv.slice(2).flatMap(arg => {
  const idx = arg.indexOf('=');
  return idx === -1 ? [[arg, true]] : [[arg.slice(0, idx), arg.slice(idx + 1)]];
}));

const manifest = await readJson(MANIFEST_PATH);
const version = String(args.get('--version') || manifest.version || '0.0.0').replace(/^v/i, '');
const title = String(args.get('--title') || 'Sample YouTube Shorts Video');

const svg = renderSvg({
  version,
  title,
  duration: '9:41',
  badge: 'status: 最新',
  badgeColor: '#2196f3',
  badgeTextColor: '#e8f4ff',
  maintenanceText: '同梱ロジックは最新互換性メタと同期しています',
  titleLine2: 'Shorts / 1080p / 30fps',
  thumbLabel: 'SHORTS',
  formatSummary: '表示: ios: 12件 (360p, 720p, 1080p)',
  note: '合成中...（ウィンドウを閉じないでください）'
});

await writeFile(OUT_PATH, svg);
console.log(`Updated ${path.relative(ROOT, OUT_PATH)}`);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function renderSvg(data) {
  const esc = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640" role="img" aria-label="ocha-YTdl popup sample">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#121212"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#1a1a1a"/>
      <stop offset="100%" stop-color="#121212"/>
    </linearGradient>
    <linearGradient id="thumb" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ff3d3d"/>
      <stop offset="45%" stop-color="#c91e1e"/>
      <stop offset="100%" stop-color="#5b0f0f"/>
    </linearGradient>
    <linearGradient id="button" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#d10000"/>
      <stop offset="100%" stop-color="#a70000"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000" flood-opacity="0.42"/>
    </filter>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="960" height="640" fill="url(#bg)"/>
  <circle cx="150" cy="96" r="130" fill="#ff2a2a" opacity="0.08"/>
  <circle cx="830" cy="110" r="170" fill="#2196f3" opacity="0.08"/>
  <rect x="220" y="44" width="520" height="552" rx="20" fill="url(#panel)" stroke="#2a2a2a" filter="url(#shadow)"/>
  <g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">
    <text x="252" y="90" fill="#ff2222" font-size="26" font-weight="700">ocha-YTdl</text>
    <g transform="translate(548 66)">
      <rect x="0" y="0" width="136" height="26" rx="13" fill="#101f2e" stroke="#1f3d59"/>
      <circle cx="13" cy="13" r="5" fill="${esc(data.badgeColor)}"/>
      <text x="28" y="18" fill="${esc(data.badgeTextColor)}" font-size="12" font-weight="700">${esc(data.badge)}</text>
    </g>
    <text x="704" y="88" fill="#666" font-size="12" text-anchor="end">v${esc(data.version)}</text>

    <g transform="translate(252 112)">
      <rect x="0" y="0" width="456" height="178" rx="16" fill="#161616" stroke="#2b2b2b" filter="url(#softShadow)"/>
      <rect x="14" y="14" width="250" height="150" rx="14" fill="url(#thumb)"/>
      <rect x="28" y="22" width="70" height="22" rx="11" fill="rgba(0,0,0,0.55)"/>
      <text x="63" y="37" fill="#fff" font-size="11" font-weight="700" text-anchor="middle">${esc(data.thumbLabel)}</text>
      <rect x="14" y="132" width="250" height="32" rx="0" fill="rgba(0,0,0,0.28)"/>
      <rect x="14" y="160" width="250" height="5" rx="2.5" fill="rgba(255,255,255,0.18)"/>
      <rect x="14" y="160" width="170" height="5" rx="2.5" fill="#ff2222"/>
      <path d="M118 76 L118 120 L152 98 Z" fill="#fff" opacity="0.95"/>
      <rect x="206" y="142" width="46" height="20" rx="4" fill="rgba(0,0,0,0.76)"/>
      <text x="229" y="156" fill="#fff" font-size="11" font-weight="700" text-anchor="middle">${esc(data.duration)}</text>
      <g transform="translate(280 20)">
        <text x="0" y="0" fill="#f2f2f2" font-size="18" font-weight="700">${esc(data.title)}</text>
        <text x="0" y="27" fill="#a6a6a6" font-size="12">${esc(data.titleLine2)}</text>
        <g transform="translate(0 48)">
          <rect x="0" y="0" width="138" height="24" rx="12" fill="#202020" stroke="#333"/>
          <text x="18" y="16" fill="#e5e5e5" font-size="11" font-weight="700">Shorts</text>
          <rect x="146" y="0" width="94" height="24" rx="12" fill="#202020" stroke="#333"/>
          <text x="193" y="16" fill="#e5e5e5" font-size="11" font-weight="700" text-anchor="middle">1080p</text>
          <rect x="248" y="0" width="70" height="24" rx="12" fill="#202020" stroke="#333"/>
          <text x="283" y="16" fill="#e5e5e5" font-size="11" font-weight="700" text-anchor="middle">30fps</text>
        </g>
      </g>
    </g>

    <g transform="translate(252 314)">
      <text x="0" y="0" fill="#666" font-size="10" font-weight="700" letter-spacing="1.2">映像フォーマット</text>
      <rect x="0" y="12" width="456" height="56" rx="10" fill="#1a1a1a" stroke="#2a2a2a"/>
      <text x="16" y="35" fill="#f0f0f0" font-size="14" font-weight="600">1080p / MP4 / 30fps</text>
      <text x="16" y="52" fill="#8a8a8a" font-size="11">ios · 82.4 MB</text>
      <text x="430" y="41" fill="#a0a0a0" font-size="18" text-anchor="middle">▾</text>

      <text x="0" y="92" fill="#666" font-size="10" font-weight="700" letter-spacing="1.2">音声フォーマット</text>
      <rect x="0" y="104" width="456" height="56" rx="10" fill="#1a1a1a" stroke="#2a2a2a"/>
      <text x="16" y="127" fill="#f0f0f0" font-size="14" font-weight="600">medium / M4A</text>
      <text x="16" y="144" fill="#8a8a8a" font-size="11">ios · 6.1 MB</text>
      <text x="430" y="133" fill="#a0a0a0" font-size="18" text-anchor="middle">▾</text>
    </g>

    <g transform="translate(252 494)">
      <rect x="0" y="0" width="140" height="34" rx="8" fill="url(#button)"/>
      <text x="70" y="22" fill="#fff" font-size="12" font-weight="700" text-anchor="middle">映像DL</text>
      <rect x="152" y="0" width="140" height="34" rx="8" fill="url(#button)"/>
      <text x="222" y="22" fill="#fff" font-size="12" font-weight="700" text-anchor="middle">音声DL</text>
      <rect x="304" y="0" width="140" height="34" rx="8" fill="url(#button)"/>
      <text x="374" y="22" fill="#fff" font-size="12" font-weight="700" text-anchor="middle">両方DL</text>
      <rect x="0" y="46" width="456" height="40" rx="10" fill="#1565c0"/>
      <text x="228" y="71" fill="#fff" font-size="13" font-weight="700" text-anchor="middle">映像+音声を合成して保存</text>
      <text x="0" y="116" fill="#4caf50" font-size="11">${esc(data.note)}</text>
      <text x="0" y="140" fill="#777" font-size="10">${esc(data.formatSummary)}</text>
      <text x="0" y="164" fill="#64b5f6" font-size="10">${esc(data.maintenanceText)}</text>
    </g>
  </g>
</svg>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
