# Third Party Code

This project vendors browser-ready JavaScript files under `vendor/` so the extension can run without a build step or runtime package manager.

## Meriyah

File: `vendor/meriyah.min.js`

Meriyah is a JavaScript parser. Check the upstream project for license and source:
https://github.com/meriyah/meriyah

## Astring

File: `vendor/astring.min.js`

Astring is a JavaScript code generator. Check the upstream project for license and source:
https://github.com/davidbonnet/astring

## FFmpeg (WebAssembly)

Files: `vendor/ffmpeg/ffmpeg-core.js`, `vendor/ffmpeg/ffmpeg-core.wasm`

Single-thread WebAssembly build of FFmpeg from the ffmpeg.wasm project (`@ffmpeg/core@0.12.10`,
UMD build). Used in the `sandbox/muxer.html` sandboxed page to mux separate video and audio
streams losslessly (`-c copy`). FFmpeg is licensed under LGPL/GPL; see upstream:
https://github.com/ffmpegwasm/ffmpeg.wasm and https://ffmpeg.org

## bgutils-js

File: `vendor/bgutils/bgutils.js`

Bundled browser build of `bgutils-js@3.2.0`, used for BotGuard / PO Token generation in
`sandbox/potgen.html` and page-context token generation fallback. Check the upstream project
for license and source:
https://github.com/LuanRT/BgUtils

## yt.solver.core.js

File: `vendor/yt.solver.core.js`

This file keeps its original SPDX header:

```text
SPDX-License-Identifier: Unlicense
```

It is imported from the `yt-dlp-ejs` wheel selected by the bundled yt-dlp release metadata, then patched for Chrome extension Trusted Types handling:
https://github.com/yt-dlp/ejs

The update path is automated by `tools/update-ytdlp-vendor.mjs`.
