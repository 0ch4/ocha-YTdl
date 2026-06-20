# ocha-YTdl

Chrome Manifest V3 extension for inspecting and downloading YouTube video formats from the current tab.

![ocha-YTdl popup sample](docs/images/popup-sample.svg)

## Features

- Supports regular YouTube watch pages and Shorts URLs.
- Lists muxed video+audio, video-only, and audio-only formats.
- Provides separate selectors for resolution, FPS, extension, and audio format.
- Attempts multiple YouTube Innertube clients to expose adaptive formats such as 720p and 1080p when available.
- Resolves YouTube `n` and signature challenges in a sandboxed page.
- Enables the extension action on YouTube tabs and disables it elsewhere.

## Install locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository folder.

## Layout

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

The extension is intentionally build-free. All paths in `manifest.json` and HTML files are relative to this repository layout.

## Notes

YouTube commonly serves 720p/1080p as video-only adaptive formats. Downloaded high-resolution files may not include audio.

This extension saves video and audio as separate files. It does not mux them into a single MP4 inside the browser extension.

Some formats may require YouTube-side tokens or streaming protocols that are not directly downloadable as a single file from a browser extension.

If only 360p is shown, check the fetch summary near the bottom of the popup. If `android` or `ios` did not return 720p/1080p, the limitation is likely coming from YouTube's response or a temporary API failure.

To probe format URLs locally:

```bash
node tools/probe-formats.mjs https://www.youtube.com/shorts/c504uRvrT-s
```

## Vendored code

- `vendor/meriyah.min.js`: Meriyah JavaScript parser.
- `vendor/astring.min.js`: Astring JavaScript code generator.
- `vendor/yt.solver.core.js`: generated from yt-dlp ejs logic, with the original SPDX header preserved.
