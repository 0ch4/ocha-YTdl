# ocha-YTdl

YouTube の現在開いている動画ページから、利用可能な動画/音声フォーマットを確認してダウンロードする Chrome Manifest V3 拡張機能です。

English README: [README_EN.md](README_EN.md)

![ocha-YTdl popup sample](docs/images/popup-sample.svg)

## 機能

- 通常の YouTube 動画ページと Shorts URL に対応
- 「動画 + 音声」「映像のみ」「音声のみ」のフォーマットを一覧表示
- 解像度、FPS、拡張子、音声フォーマットを個別に選択してダウンロード
- 選択した映像と音声を、ブラウザ内の ffmpeg.wasm で合成して保存
- 720p/1080p などの adaptive format を取得するため、複数の YouTube Innertube クライアントを試行
- YouTube の `n` challenge / signature を sandbox ページ内で解決
- PO Token の生成・検出を試行し、高解像度フォーマットの取得成功率を改善
- YouTube を開いているタブでは拡張機能アイコンを有効化し、それ以外では無効化
- GitHub 上の互換性メタ JSON を確認し、YouTube 抽出ロジックの更新推奨を表示

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
  generated/
    ytdlp-meta.json
  popup.html
  popup.js
sandbox/
  muxer.html
  potgen.html
  solver.html
vendor/
  astring.min.js
  bgutils/
  ffmpeg/
  meriyah.min.js
  yt.solver.core.js
tools/
  check-ytdlp-upstream.mjs
  probe-formats.mjs
docs/
  compat/
    latest.json
  images/
    popup-sample.svg
```

この拡張機能はビルド工程なしで動作する構成です。`manifest.json` と HTML 内のパスは、このフォルダ構成を前提にした相対パスです。

## 互換性メタと更新推奨

YouTube 抽出周りは yt-dlp 側でも頻繁に変更されます。この拡張機能は実行時に外部 JavaScript/WASM を読み込まず、同梱済みコードだけで動作します。

代わりに、`src/generated/ytdlp-meta.json` と GitHub 上の `docs/compat/latest.json` を比較し、同梱ロジックが古い可能性がある場合だけポップアップに更新推奨を表示します。この取得は JSON データの確認のみで、リモートコード実行は行いません。

リポジトリでは GitHub Actions が `tools/check-ytdlp-upstream.mjs` を定期実行し、yt-dlp の最新リリースが同梱メタより新しい場合に `docs/compat/latest.json` を更新する PR を作成します。

## 注意点

YouTube では 720p/1080p などの高画質フォーマットが、音声なしの「映像のみ」として配信されることが多いです。その場合、拡張機能でダウンロードした高画質ファイルには音声が含まれません。

映像と音声は個別保存できます。また、選択した映像と音声の組み合わせは `sandbox/muxer.html` 上の ffmpeg.wasm で合成できます。再エンコードは行わず、可能な組み合わせでは `mp4`、それ以外は `mkv` として保存します。

合成処理はブラウザのメモリ上で実行されます。大きいファイルではメモリ不足で失敗する場合があるため、その場合は解像度を下げるか、映像と音声を個別に保存してください。

一部の高画質フォーマットは通常 GET では `403` になり、HTTP Range 付きリクエストでのみ取得できます。この拡張機能は該当する URL を検出した場合、Range を並列分割取得してから Blob として保存します。

ただし、先頭 Range だけ通って後続 Range が `403` になる URL は保存できません。その場合はダウンロード前に拒否します。

一部のフォーマットは YouTube 側の PO Token や、ブラウザ拡張だけでは単一ファイルとして扱いにくい配信方式を必要とする場合があります。この拡張機能は PO Token の生成と googlevideo リクエストからの検出を試行しますが、YouTube 側の変更により高解像度フォーマットの取得や保存に失敗することがあります。

360p 以外が表示されない場合は、ポップアップ下部に表示される取得元サマリを確認してください。`android` または `ios` が 720p/1080p を返していない場合、YouTube 側の制限や一時的な API 失敗の可能性があります。

ローカルでフォーマット URL を検証する場合:

```bash
node tools/probe-formats.mjs https://www.youtube.com/shorts/c504uRvrT-s
```

## 同梱している依存ファイル

このリポジトリでは、ビルドなしで拡張機能を読み込めるように `vendor/` 配下へブラウザ向け JavaScript ファイルを同梱しています。

- `vendor/meriyah.min.js`: Meriyah JavaScript parser
- `vendor/astring.min.js`: Astring JavaScript code generator
- `vendor/bgutils/`: PO Token / BotGuard 関連処理
- `vendor/ffmpeg/`: 映像と音声の合成に使う ffmpeg.wasm
- `vendor/yt.solver.core.js`: yt-dlp ejs logic 由来の生成ファイル

詳細は [THIRD_PARTY.md](THIRD_PARTY.md) を参照してください。
