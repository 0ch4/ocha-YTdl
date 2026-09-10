/*
 * リリース用パッケージングスクリプト。
 * dist/ocha-YTdl-v{version}.zip を作る。ソースは変更しない。
 *
 * 使い方: node tools/package-release.mjs
 *
 * minify は簡易版（コメント・空白除去）。
 * ビルド工程なしの構成を壊さないよう、リリース時のみこのスクリプトを走らせる。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const distDir = join(root, 'dist');
const stageDir = join(distDir, `ocha-YTdl-v${version}`);

console.log(`Packaging ocha-YTdl v${version}`);

// ── staging ディレクトリ作成 ──────────────────────────────
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// manifest / icons / sandbox / vendor はそのままコピー
for (const dir of ['icons', 'sandbox', 'vendor']) {
  cpSync(join(root, dir), join(stageDir, dir), { recursive: true });
}
cpSync(join(root, 'manifest.json'), join(stageDir, 'manifest.json'));
if (existsSync(join(root, 'THIRD_PARTY.md'))) {
  cpSync(join(root, 'THIRD_PARTY.md'), join(stageDir, 'THIRD_PARTY.md'));
}

// ── src/ をコピーしてから JS を minify ────────────────────
cpSync(join(root, 'src'), join(stageDir, 'src'), { recursive: true });

// 簡易 minify: ブロックコメント・行コメント・行末空白を除去。
// 文字列リテラル内の // や /* は誤爆しうるので、リリース前テスト必須。
// 厳密な minify が必要になったら terser 等に差し替えること。
function minifyJs(code) {
  // ブロックコメント除去（文字列外と仮定）
  let out = code.replace(/\/\*[\s\S]*?\*\//g, '');
  // 行コメント除去（行末の // ... ）
  out = out.replace(/([^:'"`\\])\/\/[^\n]*/g, '$1');
  // 連続空行を1つに
  out = out.replace(/\n{3,}/g, '\n\n');
  // 行末空白除去
  out = out.replace(/[ \t]+$/gm, '');
  return out.trim() + '\n';
}

const jsFiles = [
  'src/background.js',
  'src/content.js',
  'src/popup.js',
  'src/config/youtube.js',
  'src/shared/maintenance.js',
  'src/worker/download.js'
];

for (const rel of jsFiles) {
  const p = join(stageDir, rel);
  if (!existsSync(p)) continue;
  const orig = readFileSync(p, 'utf8');
  const min = minifyJs(orig);
  writeFileSync(p, min, 'utf8');
  const saved = orig.length - min.length;
  console.log(`  minified ${rel}: ${orig.length} → ${min.length} (-${saved})`);
}

// ── ZIP 作成 ──────────────────────────────────────────────
const zipName = `ocha-YTdl-v${version}.zip`;
const zipPath = join(distDir, zipName);
if (existsSync(zipPath)) rmSync(zipPath);

try {
  // PowerShell の Compress-Archive を使う（Windows 標準）
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'pipe' }
  );
  console.log(`\nCreated: ${zipPath}`);
} catch (e) {
  // fallback: tar (Windows 10+ にも tar がある)
  try {
    execSync(`tar -a -cf "${zipPath}" -C "${stageDir}" .`, { stdio: 'pipe' });
    console.log(`\nCreated (tar): ${zipPath}`);
  } catch (e2) {
    console.error('ZIP creation failed. Stage dir is at:', stageDir);
    process.exit(1);
  }
}

console.log('Done.');
