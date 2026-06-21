# ocha-YTdl 更新手順

この拡張機能は Chrome Web Store 経由ではなく、`extension` フォルダまたはリポジトリフォルダを `chrome://extensions` から直接読み込む前提です。そのため、Chrome は GitHub 上の更新を自動では取り込みません。

更新方法は、最初に導入した方法に合わせて選んでください。

## 方法1: ZIP をダウンロードして上書き更新

Git を使っていない通常ユーザー向けです。

1. GitHub の ocha-YTdl リポジトリを開く
2. `Code` > `Download ZIP` から最新版をダウンロードする
3. ZIP を展開する
4. 現在 Chrome に読み込ませている古い ocha-YTdl フォルダをバックアップする
5. 古いフォルダの中身を、新しいフォルダの中身で置き換える
6. Chrome で `chrome://extensions` を開く
7. `ocha-YTdl` の再読み込みボタンを押す

フォルダ名や場所を変えた場合、Chrome が古いパスを参照したままになり、`ファイルにアクセスできませんでした` と表示されることがあります。その場合は古い `ocha-YTdl` を一度削除し、`パッケージ化されていない拡張機能を読み込む` から新しいフォルダを選び直してください。

## 方法2: git clone / git pull で更新

Git で導入したユーザー向けです。

```powershell
cd path\to\ocha-YTdl
git pull --ff-only
```

その後、Chrome で `chrome://extensions` を開き、`ocha-YTdl` の再読み込みボタンを押してください。

PowerShell を使う場合は、リポジトリ内で次のスクリプトも使えます。

```powershell
powershell -ExecutionPolicy Bypass -File tools\update-local.ps1
```

このスクリプトはローカル変更がある場合は上書きせず中断します。自分で編集したファイルがある場合は、先にバックアップするか `git stash` してください。

## ポップアップに更新通知が出た場合

更新通知が表示されているときは、ポップアップ内の `更新手順` ボタンからこのページを開けます。

ファイル更新後にポップアップ内の `再読み込み` ボタンを押すと、拡張機能を再読み込みできます。ただし、フォルダを移動した場合や Chrome が古いパスを見ている場合は、`chrome://extensions` から読み込み直してください。

## yt-dlp が更新されたときにメンテナがやること

通常は GitHub Actions が毎日 yt-dlp の最新リリースを確認し、`tools/update-ytdlp-vendor.mjs` で更新 PR を作成します。

このスクリプトは、yt-dlp の `pyproject.toml` が要求する `yt-dlp-ejs` バージョンを読み取り、PyPI wheel から EJS core を取得します。その後、Chrome 拡張向けの Trusted Types 対応パッチを当てて、`vendor/yt.solver.core.js`、`src/generated/ytdlp-meta.json`、`docs/compat/latest.json` を更新します。

メンテナ側の作業は次の流れです。

1. GitHub Actions が作った PR を確認する
2. `vendor/yt.solver.core.js` だけの機械的なEJS更新、またはメタデータ更新だけであれば、内容を確認してテストする
3. 通常動画、Shorts、360p、720p/1080p、音声のみ、映像+音声の合成をテストする
4. 問題なければ PR をマージする
5. ポップアップで更新推奨が出る、または YouTube 抽出が壊れた場合だけ yt-dlp の変更点を深掘りする
6. 自動更新で吸収できない場合は、`src/config/youtube.js` の YouTube クライアント定義/API key/PO Token 設定、または Range取得周りなど、影響箇所を手動で更新する
7. 拡張機能の仕様変更がある場合は `manifest.json`、`src/popup.html`、`src/generated/ytdlp-meta.json` のバージョン情報を更新する

手元で同じ更新を試す場合:

```bash
node tools/update-ytdlp-vendor.mjs --sync-compat
```

現状の構成では、拡張機能が実行時に yt-dlp のコードを自動取得することはしません。Manifest V3 と Chrome Web Store のリモートコード制限を避けるため、リモートから取得するのは互換性確認用の JSON のみです。
