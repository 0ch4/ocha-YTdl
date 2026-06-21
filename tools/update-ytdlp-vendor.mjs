import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const META_PATH = path.join(ROOT, 'src/generated/ytdlp-meta.json');
const LATEST_PATH = path.join(ROOT, 'docs/compat/latest.json');
const SOLVER_PATH = path.join(ROOT, 'vendor/yt.solver.core.js');

const YTDLP_REPO = 'yt-dlp/yt-dlp';
const EJS_PYPI_PROJECT = 'yt-dlp-ejs';
const USER_AGENT = 'ocha-YTdl-upstream-sync';

const args = new Set(process.argv.slice(2));
const syncCompat = args.has('--sync-compat');
const releaseArg = getArgValue('--yt-dlp-release');

async function main() {
  const manifest = await readJson(MANIFEST_PATH);
  const release = releaseArg
    ? await fetchJson(`https://api.github.com/repos/${YTDLP_REPO}/releases/tags/${releaseArg}`)
    : await fetchJson(`https://api.github.com/repos/${YTDLP_REPO}/releases/latest`);

  const ytDlpRelease = release.tag_name || releaseArg;
  if (!ytDlpRelease) throw new Error('Could not determine yt-dlp release tag');

  const [commit, pyproject] = await Promise.all([
    resolveGitHubTagCommit(YTDLP_REPO, ytDlpRelease),
    fetchText(`https://raw.githubusercontent.com/${YTDLP_REPO}/${ytDlpRelease}/pyproject.toml`),
  ]);

  const ejsVersion = extractRequiredEjsVersion(pyproject);
  const wheel = await fetchEjsWheel(ejsVersion);
  const solverCore = patchSolverCore(extractZipText(wheel.data, 'yt_dlp_ejs/yt/solver/core.min.js'));

  await writeIfChanged(SOLVER_PATH, `${solverCore.trimEnd()}\n`);

  const nextMeta = {
    schemaVersion: 1,
    extensionVersion: manifest.version,
    ytDlpRelease,
    ytDlpCommit: commit.slice(0, 7),
    ejsVersion,
    youtubeClientsRevision: ytDlpRelease,
    notes: [
      'Bundled metadata used for update recommendation checks only.',
      'Runtime code is loaded only from extension-packaged files.',
      `yt-dlp-ejs wheel sha256: ${wheel.sha256}`,
    ],
  };
  await writeJsonIfChanged(META_PATH, nextMeta);

  if (syncCompat) {
    const currentLatest = await readJson(LATEST_PATH).catch(() => null);
    const nextLatest = {
      schemaVersion: 1,
      generatedAt: currentLatest?.generatedAt || new Date(0).toISOString(),
      latestExtensionVersion: manifest.version,
      minimumRecommended: {
        ytDlpRelease,
        ejsVersion,
      },
      severity: 'ok',
      messageJa: '現在の同梱ロジックは最新互換性メタと同期しています。',
      messageEn: 'Bundled logic is in sync with the latest compatibility metadata.',
      upstream: {
        ytDlpRelease,
        ytDlpUrl: release.html_url || `https://github.com/${YTDLP_REPO}/releases/tag/${ytDlpRelease}`,
        publishedAt: release.published_at || null,
        youtubeChanges: extractYoutubeChanges(release.body || ''),
      },
    };
    if (!sameMeaningfulStatus(currentLatest, nextLatest)) {
      nextLatest.generatedAt = new Date().toISOString();
      await writeJsonIfChanged(LATEST_PATH, nextLatest, { forceGeneratedAt: true });
    }
  }

  console.log(`yt-dlp ${ytDlpRelease} (${commit.slice(0, 7)}), yt-dlp-ejs ${ejsVersion}`);
}

function getArgValue(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length) || null;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJsonIfChanged(file, value) {
  await writeIfChanged(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeIfChanged(file, next) {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === next) return false;
  await writeFile(file, next);
  console.log(`Updated ${path.relative(ROOT, file)}`);
  return true;
}

async function fetchJson(url) {
  const text = await fetchText(url, { accept: 'application/vnd.github+json' });
  return JSON.parse(text);
}

async function fetchText(url, { accept = '*/*' } = {}) {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`fetch failed ${resp.status}: ${url}`);
  return resp.text();
}

async function fetchBuffer(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`download failed ${resp.status}: ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function resolveGitHubTagCommit(repo, tag) {
  const ref = await fetchJson(`https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.object?.type === 'commit') return ref.object.sha;
  if (ref.object?.type === 'tag' && ref.object?.url) {
    const tagObject = await fetchJson(ref.object.url);
    if (tagObject.object?.sha) return tagObject.object.sha;
  }
  throw new Error(`Could not resolve commit for ${repo}@${tag}`);
}

function extractRequiredEjsVersion(pyproject) {
  const match = pyproject.match(/["']yt-dlp-ejs==([^"']+)["']/);
  if (!match) throw new Error('Could not find yt-dlp-ejs requirement in pyproject.toml');
  return match[1];
}

async function fetchEjsWheel(version) {
  const meta = await fetchJson(`https://pypi.org/pypi/${EJS_PYPI_PROJECT}/${version}/json`);
  const wheel = meta.urls.find(file =>
    file.packagetype === 'bdist_wheel'
    && file.filename.endsWith('-py3-none-any.whl')
  );
  if (!wheel) throw new Error(`Could not find ${EJS_PYPI_PROJECT} ${version} wheel`);

  const data = await fetchBuffer(wheel.url);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const expected = wheel.digests?.sha256;
  if (expected && sha256 !== expected) {
    throw new Error(`Wheel sha256 mismatch: expected ${expected}, got ${sha256}`);
  }
  return { data, sha256, filename: wheel.filename };
}

function extractZipText(zip, targetName) {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const totalEntries = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    if (name === targetName) {
      const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed.toString('utf8');
      if (method === 8) return inflateRawSync(compressed).toString('utf8');
      throw new Error(`Unsupported ZIP compression method ${method} for ${targetName}`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`File not found in wheel: ${targetName}`);
}

function findEndOfCentralDirectory(zip) {
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Invalid ZIP: end of central directory not found');
}

function patchSolverCore(code) {
  if (code.includes('__ytSolverPolicy')) return code;

  const original = 'function(e){const n={n:null,sig:null};return Function("_result",e)(n),n}';
  const replacement = 'function(e){const n={n:null,sig:null};let t;const o=("undefined"!=typeof globalThis&&globalThis.trustedTypes)||("undefined"!=typeof window&&window.trustedTypes);if(o&&o.createPolicy){const s="undefined"!=typeof window?window:"undefined"!=typeof self?self:globalThis;if(!s.__ytSolverPolicy)try{s.__ytSolverPolicy=o.createPolicy("yt-solver-eval",{createScript:e=>e})}catch(e){}const r=s.__ytSolverPolicy,i="(function(_result){\\n"+e+"\\n})";t=s.eval(r?r.createScript(i):i)}else t=Function("_result",e);return t(n),n}';

  if (!code.includes(original)) {
    throw new Error('Could not apply Trusted Types patch to EJS core bundle');
  }
  return code.replace(original, replacement);
}

function extractYoutubeChanges(body) {
  const lines = body.split(/\r?\n/);
  const changes = [];
  let inYoutubeSection = false;
  let youtubeIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (isYoutubeListHeading(trimmed)) {
      inYoutubeSection = true;
      youtubeIndent = line.search(/\S/);
      continue;
    }
    if (inYoutubeSection) {
      const indent = line.search(/\S/);
      if (/^#{1,6}\s+/.test(trimmed) || (trimmed && indent <= youtubeIndent && /^[-*]\s+\S/.test(trimmed))) {
        inYoutubeSection = false;
      } else if (trimmed && /^[-*]\s+/.test(trimmed)) {
        changes.push(cleanMarkdownListLine(trimmed));
      }
    }
  }

  if (changes.length) return changes.slice(0, 20);

  return lines
    .map(line => line.trim())
    .filter(line => /\b(youtube|ejs|po token|signature|nsig|player client|sabr)\b/i.test(line))
    .map(cleanMarkdownListLine)
    .filter(line => !/^youtube$/i.test(line))
    .slice(0, 20);
}

function isYoutubeListHeading(line) {
  return /^[-*]\s+\**youtube\**\b/i.test(line);
}

function cleanMarkdownListLine(line) {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
