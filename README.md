# ocha-YTdl

YouTube の現在開いている動画ページから、利用可能な動画/音声フォーマットを確認してダウンロードする Chrome Manifest V3 拡張機能です。

English README: [README_EN.md](README_EN.md)

![ocha-YTdl popup sample](docs/images/popup-sample.svg)

## 機能

- 通常の YouTube 動画ページと Shorts URL に対応
- 「動画 + 音声」「映像のみ」「音声のみ」のフォーマットを一覧表示
- 解像度、FPS、拡張子、音声フォーマットを個別に選択してダウンロード
- 720p/1080p などの adaptive format を取得するため、複数の YouTube Innertube クライアントを試行
- YouTube の `n` challenge / signature を sandbox ページ内で解決
- YouTube を開いているタブでは拡張機能アイコンを有効化し、それ以外では無効化

## ローカルインストール

1. Chrome で `chrome://extensions` を開く
2. `デベロッパー モード` を有効にする
3. `パッケージ化されていない拡張機能を読み込む` をクリック
4. このリポジトリのフォルダを選択する

## フォルダ構成

```text
manifest.json
src/
  background.js
  popup.html
  popup.js
sandbox/
  solver.html
vendor/
  astring.min.js
  meriyah.min.js
  yt.solver.core.js
```

この拡張機能はビルド工程なしで動作する構成です。`manifest.json` と HTML 内のパスは、このフォルダ構成を前提にした相対パスです。

## 注意点

YouTube では 720p/1080p などの高画質フォーマットが、音声なしの「映像のみ」として配信されることが多いです。その場合、拡張機能でダウンロードした高画質ファイルには音声が含まれません。

この拡張機能は、映像と音声を別ファイルとして保存します。ブラウザ拡張内で MP4 へ結合する処理は行いません。

また、一部のフォーマットは YouTube 側のトークンや、ブラウザ拡張だけでは単一ファイルとして扱いにくい配信方式を必要とする場合があります。

360p 以外が表示されない場合は、ポップアップ下部に表示される取得元サマリを確認してください。`android` または `ios` が 720p/1080p を返していない場合、YouTube 側の制限や一時的な API 失敗の可能性があります。

ローカルでフォーマット URL を検証する場合:

```bash
node tools/probe-formats.mjs https://www.youtube.com/shorts/c504uRvrT-s
```

## 同梱している依存ファイル

このリポジトリでは、ビルドなしで拡張機能を読み込めるように `vendor/` 配下へブラウザ向け JavaScript ファイルを同梱しています。

- `vendor/meriyah.min.js`: Meriyah JavaScript parser
- `vendor/astring.min.js`: Astring JavaScript code generator
- `vendor/yt.solver.core.js`: yt-dlp ejs logic 由来の生成ファイル

詳細は [THIRD_PARTY.md](THIRD_PARTY.md) を参照してください。
