import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const META_PATH = path.join(ROOT, 'src/generated/ytdlp-meta.json');
const LATEST_PATH = path.join(ROOT, 'docs/compat/latest.json');
const SOLVER_PATH = path.join(ROOT, 'vendor/yt.solver.core.js');
const CONFIG_PATH = path.join(ROOT, 'src/config/youtube.js');
const SYNCED_MESSAGE_JA = '現在の同梱ロジックは最新互換性メタと同期しています。';
const SYNCED_MESSAGE_EN = 'Bundled logic is in sync with the latest compatibility metadata.';

const YTDLP_REPO = 'yt-dlp/yt-dlp';
// クライアント定義だけは master を追う。上流はリリースを待たずに版を上げるため、
// リリースだけを見ていると半年遅れる（2026.07.04 の時点で中身は 2026.01 世代のままだった）。
// ejs/solver は逆に、公開済みホイールと一致している必要があるのでリリース固定。
const CLIENTS_REF = 'master';
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

  const rawFile = (ref, file) => `https://raw.githubusercontent.com/${YTDLP_REPO}/${ref}/${file}`;
  const clientsHead = await fetchJson(`https://api.github.com/repos/${YTDLP_REPO}/commits/${CLIENTS_REF}`);
  const clientsCommit = clientsHead.sha;
  if (!clientsCommit) throw new Error(`Could not resolve ${YTDLP_REPO}@${CLIENTS_REF}`);

  const [commit, pyproject, basePy, videoPy] = await Promise.all([
    resolveGitHubTagCommit(YTDLP_REPO, ytDlpRelease),
    fetchText(rawFile(ytDlpRelease, 'pyproject.toml')),
    fetchText(rawFile(clientsCommit, 'yt_dlp/extractor/youtube/_base.py')),
    fetchText(rawFile(clientsCommit, 'yt_dlp/extractor/youtube/_video.py')),
  ]);

  const bundledConfig = await readBundledConfig();
  const upstreamClients = parseUpstreamClients(basePy);
  const defaultClients = parseDefaultClients(videoPy);
  const excludedClients = readIntentionalExclusions(bundledConfig, upstreamClients, defaultClients);
  const clientDrift = diffClients(bundledConfig, upstreamClients, defaultClients, excludedClients);
  const clientsInSync = clientDrift.length === 0;
  // master の SHA は毎日変わるので生成物には書かない（毎日無意味な差分が出るため）。ログにだけ残す。
  console.log(`Clients compared against ${CLIENTS_REF} (${clientsCommit.slice(0, 7)}): ${clientsInSync ? 'in sync' : `${clientDrift.length} drifted`}`);
  for (const entry of clientDrift) console.log(`  drift: ${entry.summaryEn}`);
  for (const entry of excludedClients) console.log(`  excluded on purpose: ${entry.client}`);

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
    // 実際に定義を突き合わせて一致した時だけ追従先を刻む。ずれている間は null。
    youtubeClientsRevision: clientsInSync ? CLIENTS_REF : null,
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
      severity: clientsInSync ? 'ok' : 'recommended',
      messageJa: clientsInSync
        ? SYNCED_MESSAGE_JA
        : `Innertubeクライアント定義が yt-dlp ${CLIENTS_REF} とずれています: ${clientDrift.map(entry => entry.summaryJa).join(' / ')}`,
      messageEn: clientsInSync
        ? SYNCED_MESSAGE_EN
        : `Innertube client definitions have drifted from yt-dlp ${CLIENTS_REF}: ${clientDrift.map(entry => entry.summaryEn).join(' / ')}`,
      clientDrift,
      excludedClients,
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

// ─── Innertube クライアント定義の突き合わせ ──────────────────────────
// リリース番号を追うだけでは、実際に壊れる箇所(クライアント定義)のズレに気づけない。
// 上流の定義を実際にパースして比較する。パースに失敗したら黙って「同期済み」と
// 報告するのではなく throw して CI を落とすこと。

function parseUpstreamClients(source) {
  const start = source.indexOf('INNERTUBE_CLIENTS = {');
  if (start === -1) throw new Error('Could not find INNERTUBE_CLIENTS in yt-dlp _base.py');
  const end = source.indexOf('\n}\n', start);
  if (end === -1) throw new Error('Could not find the end of INNERTUBE_CLIENTS in yt-dlp _base.py');
  const block = source.slice(start, end);

  const heads = [];
  const keyPattern = /^ {4}'([a-z0-9_]+)': \{$/gm;
  for (let match = keyPattern.exec(block); match; match = keyPattern.exec(block)) {
    heads.push({ key: match[1], index: match.index });
  }

  const clients = new Map();
  heads.forEach((head, i) => {
    const body = block.slice(head.index, i + 1 < heads.length ? heads[i + 1].index : block.length);
    const clientName = body.match(/'clientName':\s*'([^']+)'/)?.[1];
    const clientVersion = body.match(/'clientVersion':\s*'([^']+)'/)?.[1];
    if (clientName && clientVersion) clients.set(head.key, { clientName, clientVersion });
  });

  if (clients.size === 0) {
    throw new Error('Parsed zero clients from yt-dlp _base.py; the upstream format probably changed');
  }
  return clients;
}

function parseDefaultClients(source) {
  const defaults = new Set();
  for (const name of ['_DEFAULT_CLIENTS', '_DEFAULT_AUTHED_CLIENTS']) {
    const match = source.match(new RegExp(`${name} = \\(([^)]*)\\)`));
    if (!match) throw new Error(`Could not find ${name} in yt-dlp _video.py`);
    for (const client of match[1].matchAll(/'([a-z0-9_]+)'/g)) defaults.add(client[1]);
  }
  return defaults;
}

async function readBundledConfig() {
  const source = await readFile(CONFIG_PATH, 'utf8');
  // config は globalThis に代入するだけなので、仮の scope を渡して評価する
  const scope = {};
  new Function('globalThis', source)(scope);
  const config = scope.OCHA_YTDL_YOUTUBE_CONFIG;
  if (!config?.innertubeClientProfiles?.length) {
    throw new Error('Could not read innertubeClientProfiles from src/config/youtube.js');
  }
  return config;
}

// yt-dlp のキーと、うちの config のキーが名前として一致しない対応。
// 'web' は page_web(usePageContext: true, defaultClientName: 'WEB') が実体として担っている
// (contextはページの ytcfg から取得、版は defaultWebClientVersion で追従)。名前だけ見て
// 「未同梱」と誤判定しないよう、比較前に読み替える。
const UPSTREAM_KEY_TO_BUNDLED_KEY = { web: 'page_web' };

// 「上流の既定だが意図的に同梱しない」クライアントを config から読む。理由が書かれて
// いない除外は認めない(黙って警告を消す抜け穴にしないため)。上流に存在しないキーが
// 挙がっていたら綴り間違いか上流の改名なので throw する。
function readIntentionalExclusions(config, upstreamClients, defaultClients) {
  const excluded = [];
  for (const [client, note] of Object.entries(config.intentionallyUnbundledClients || {})) {
    if (!note?.reasonJa || !note?.reasonEn) {
      throw new Error(`intentionallyUnbundledClients.${client} needs both reasonJa and reasonEn`);
    }
    if (!upstreamClients.has(client)) {
      throw new Error(`intentionallyUnbundledClients.${client} is not a client in yt-dlp ${CLIENTS_REF}`);
    }
    if (!defaultClients.has(client)) {
      // 上流が既定から外した＝除外の記述はもう要らない。壊れてはいないので落とさず知らせる。
      console.log(`  stale exclusion: ${client} is no longer a yt-dlp default client; drop it from intentionallyUnbundledClients`);
      continue;
    }
    excluded.push({ client, reasonJa: note.reasonJa, reasonEn: note.reasonEn });
  }
  return excluded;
}

function diffClients(config, upstreamClients, defaultClients, excludedClients = []) {
  const drift = [];
  const bundledKeys = new Set(config.innertubeClientProfiles.map(profile => profile.key));
  const excludedKeys = new Set(excludedClients.map(entry => entry.client));

  for (const profile of config.innertubeClientProfiles) {
    // page_web / web_safari はページから版を取るので固定値を持たない
    if (!profile.clientVersion) continue;
    const upstream = upstreamClients.get(profile.key);
    if (!upstream) continue;
    if (upstream.clientVersion !== profile.clientVersion) {
      drift.push({
        client: profile.key,
        bundled: profile.clientVersion,
        upstream: upstream.clientVersion,
        summaryJa: `${profile.key} ${profile.clientVersion} → ${upstream.clientVersion}`,
        summaryEn: `${profile.key} ${profile.clientVersion} -> ${upstream.clientVersion}`,
      });
    }
  }

  // page_web が担う 'web' は defaultWebClientVersion で追従しているので、そちらと突き合わせる。
  const webUpstream = upstreamClients.get('web');
  if (webUpstream && config.defaultWebClientVersion && config.defaultWebClientVersion !== webUpstream.clientVersion) {
    drift.push({
      client: 'page_web',
      bundled: config.defaultWebClientVersion,
      upstream: webUpstream.clientVersion,
      summaryJa: `page_web(defaultWebClientVersion) ${config.defaultWebClientVersion} → ${webUpstream.clientVersion}`,
      summaryEn: `page_web(defaultWebClientVersion) ${config.defaultWebClientVersion} -> ${webUpstream.clientVersion}`,
    });
  }

  // 上流が既定にしているクライアントを丸ごと積み忘れている場合(android_vr がこれだった)
  for (const key of defaultClients) {
    const bundledKey = UPSTREAM_KEY_TO_BUNDLED_KEY[key] || key;
    if (bundledKeys.has(bundledKey)) continue;
    if (excludedKeys.has(key)) continue; // 理由付きで除外済み(latest.json の excludedClients に出る)
    drift.push({
      client: key,
      bundled: null,
      upstream: upstreamClients.get(key)?.clientVersion || 'unknown',
      summaryJa: `${key} が未同梱 (yt-dlp の既定クライアント)`,
      summaryEn: `${key} is not bundled (a yt-dlp default client)`,
    });
  }

  return drift;
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
