# ocha-YTdl

A Chrome Manifest V3 extension that adds a **切り出し** (clip) button to the YouTube watch page. Mark a range straight off the player, pick a quality, and save. No server and no external tools — the download and the mux both run in the browser.

## Install locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository folder.

## Updating

Because this is an unpacked extension, Chrome does not automatically pull updates from GitHub.

Japanese update instructions for ZIP overwrite and `git pull` installs are available in [docs/UPDATE_JA.md](docs/UPDATE_JA.md).

For Git-based installs, run this from the repository:

```powershell
powershell -ExecutionPolicy Bypass -File tools\update-local.ps1
```

After updating files, reload `ocha-YTdl` from `chrome://extensions`.

## Usage

Open a watch page and a **切り出し** (clip) button appears beside like and share.

![The clip button added to the watch page](docs/images/clip-button.png)

Pressing it opens a panel below.

1. **Range** (optional) — seek the video and press `現在位置` (current position) to set the start and end. No typing timestamps. Leave it empty to save the whole video.
2. **Save** — choose quality, container and audio, then press `保存` (save).
3. A small window opens, downloads and muxes, and closes itself when done.

That window is independent of the page, so **moving to another video mid-download does not interrupt it**.

## When a video will not load, use the toolbar icon

The in-page panel only uses the clients that need no PO Token and no signature work (`android_vr` and `visionos`). When those are refused for a video, the panel says so.

Press the ocha-YTdl toolbar icon instead. That path generates a PO Token, resolves `n` and signature challenges, and falls back across several clients, so it can often fetch what the page panel cannot. It also lists every format, including video-only and audio-only.

![The panel opened from the toolbar icon](docs/images/sc.png)

## Features

- Supports regular YouTube watch pages and Shorts URLs.
- Marks a clip range from the player position, in the page.
- Saves a chosen quality, container and audio track, muxed in the browser with ffmpeg.wasm.
- Runs downloads in an independent window, so leaving the page does not interrupt them.
- The toolbar panel lists every format: muxed video+audio, video-only and audio-only.
- Attempts multiple YouTube Innertube clients to expose adaptive formats such as 720p and 1080p when available.
- Resolves YouTube `n` and signature challenges in a sandboxed page.
- Attempts PO Token generation and capture to improve high-resolution format access.
- Both the in-page UI and the download window follow YouTube's light and dark themes.
- Checks hosted compatibility metadata JSON and shows an update recommendation when bundled YouTube extraction logic may be stale.

## Layout

```text
manifest.json
src/
  background.js
  config/
    youtube.js
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
  update-local.ps1
  update-ytdlp-vendor.mjs
docs/
  UPDATE_JA.md
  compat/
    latest.json
  images/
    sc.png
```

The extension is intentionally build-free. All paths in `manifest.json` and HTML files are relative to this repository layout.

## Compatibility Metadata

YouTube extraction changes frequently in yt-dlp. This extension does not execute remote JavaScript or WebAssembly at runtime; it only runs code bundled in the extension package.

Instead, it compares bundled metadata in `src/generated/ytdlp-meta.json` with hosted JSON metadata at `docs/compat/latest.json` and displays an update recommendation when the bundled logic may be stale. This is data-only JSON fetching, not remote code execution.

Values that tend to change with YouTube, such as the API key fallback, Innertube client definitions, client header IDs, and PO Token hooks, are centralized in `src/config/youtube.js`.

The repository includes a GitHub Actions workflow that runs `tools/update-ytdlp-vendor.mjs` on a schedule. It reads the `yt-dlp-ejs` version required by the latest yt-dlp release, imports the EJS core from the PyPI wheel, applies the Chrome-extension patch, and opens a pull request for `vendor/yt.solver.core.js`, `src/generated/ytdlp-meta.json`, and `docs/compat/latest.json`.

To run the same update locally:

```bash
node tools/update-ytdlp-vendor.mjs --sync-compat
```

## Notes

YouTube commonly serves 720p/1080p as video-only adaptive formats. Downloaded high-resolution files may not include audio.

The extension can save video and audio separately. It can also mux the selected video and audio through ffmpeg.wasm in `sandbox/muxer.html`. It uses stream copy without re-encoding; compatible combinations are saved as `mp4`, and other combinations are saved as `mkv`.

When a time range is entered, the extension downloads the selected input first and clips it through ffmpeg.wasm in `sandbox/muxer.html` with `-c copy`. Accepted examples include `5-10`, `0:05~0:10`, and `1:02:03-1:03:00`. This avoids re-encoding, but the exact start point may shift slightly depending on keyframe placement.

Muxing runs in browser memory. Large inputs can fail because of memory limits, so choose a lower resolution or download video and audio separately if muxing fails.

Some high-resolution formats return `403` for plain GET requests and only work with HTTP Range requests. When detected, this extension downloads those formats in parallel ranged chunks and saves them as a Blob.

URLs that only allow the first range and reject later ranges cannot be saved. The extension rejects them before starting the download.

Some formats may require YouTube-side PO Tokens or streaming protocols that are not directly downloadable as a single file from a browser extension. This extension attempts both PO Token generation and capture from googlevideo requests, but high-resolution access can still fail when YouTube changes its behavior.

If only 360p is shown, check the fetch summary near the bottom of the popup. If `android` or `ios` did not return 720p/1080p, the limitation is likely coming from YouTube's response or a temporary API failure.

To probe format URLs locally:

```bash
node tools/probe-formats.mjs https://www.youtube.com/shorts/c504uRvrT-s
```

## Vendored code

- `vendor/meriyah.min.js`: Meriyah JavaScript parser.
- `vendor/astring.min.js`: Astring JavaScript code generator.
- `vendor/bgutils/`: PO Token / BotGuard helpers.
- `vendor/ffmpeg/`: ffmpeg.wasm used for muxing video and audio.
- `vendor/yt.solver.core.js`: EJS core imported from the `yt-dlp-ejs` wheel and patched for Chrome extension Trusted Types handling.
