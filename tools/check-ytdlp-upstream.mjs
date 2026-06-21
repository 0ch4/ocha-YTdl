import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const META_PATH = path.join(ROOT, 'src/generated/ytdlp-meta.json');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const LATEST_PATH = path.join(ROOT, 'docs/compat/latest.json');
const YTDLP_LATEST_RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

async function main() {
  const [bundled, manifest, currentLatest] = await Promise.all([
    readJson(META_PATH),
    readJson(MANIFEST_PATH),
    readJson(LATEST_PATH).catch(() => null),
  ]);

  const release = await fetchJson(YTDLP_LATEST_RELEASE_API);
  const upstreamRelease = release.tag_name || release.name || null;
  if (!upstreamRelease) throw new Error('Could not determine latest yt-dlp release');

  const needsYtDlpUpdate = compareVersionText(upstreamRelease, bundled.ytDlpRelease) > 0;
  const severity = needsYtDlpUpdate ? 'recommended' : 'ok';
  const messageJa = needsYtDlpUpdate
    ? `yt-dlp ${upstreamRelease} が公開されています。YouTube抽出ロジックの追従を推奨します。`
    : '現在の同梱ロジックは最新互換性メタと同期しています。';
  const messageEn = needsYtDlpUpdate
    ? `yt-dlp ${upstreamRelease} is available. Updating the bundled YouTube extraction metadata is recommended.`
    : 'Bundled logic is in sync with the latest compatibility metadata.';

  const next = {
    schemaVersion: 1,
    generatedAt: currentLatest?.generatedAt || new Date(0).toISOString(),
    latestExtensionVersion: manifest.version,
    minimumRecommended: {
      ytDlpRelease: upstreamRelease,
      ejsVersion: bundled.ejsVersion,
    },
    severity,
    messageJa,
    messageEn,
    upstream: {
      ytDlpRelease: upstreamRelease,
      ytDlpUrl: release.html_url || `https://github.com/yt-dlp/yt-dlp/releases/tag/${upstreamRelease}`,
      publishedAt: release.published_at || null,
    },
  };

  if (!sameMeaningfulStatus(currentLatest, next)) {
    next.generatedAt = new Date().toISOString();
    await writeFile(LATEST_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Updated ${path.relative(ROOT, LATEST_PATH)}: ${severity}`);
    return;
  }

  console.log('No compatibility metadata update needed');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fetchJson(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ocha-YTdl-compat-check',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`fetch failed ${resp.status}: ${url}`);
  }
  return resp.json();
}

function sameMeaningfulStatus(a, b) {
  if (!a) return false;
  const normalize = value => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.generatedAt;
    return copy;
  };
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
