$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot

try {
  git rev-parse --is-inside-work-tree | Out-Null

  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host "ローカル変更があります。上書きせず中断します。" -ForegroundColor Yellow
    git status --short
    Write-Host ""
    Write-Host "必要な変更をバックアップするか、git stash してから再実行してください。"
    exit 2
  }

  Write-Host "ocha-YTdl を更新します..."
  git fetch origin
  git pull --ff-only

  Write-Host ""
  Write-Host "更新完了。Chrome で chrome://extensions を開き、ocha-YTdl の再読み込みボタンを押してください。" -ForegroundColor Green
  Write-Host "ポップアップに更新通知が出ている場合は、ポップアップ内の「再読み込み」ボタンも使えます。"
} finally {
  Pop-Location
}
