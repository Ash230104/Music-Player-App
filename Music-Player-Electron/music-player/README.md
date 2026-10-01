# Music Player (Windows desktop app)

Your existing HTML music player wrapped in Electron. Playlists and songs still
live in the same IndexedDB / localStorage as before; the Flask backend is
replaced by a small built-in local server, and yt-dlp, ffmpeg and Deno are
bundled so YouTube import works with nothing else installed.

## Run it

Requirements: Windows 10/11 (x64), Node.js 20+, an internet connection for the first run.

```
pip install spotifyscraper
npm install
npm start
```

The first `npm start` downloads `yt-dlp.exe`, `deno.exe`, `ffmpeg.exe` and
`ffprobe.exe` into `./bin` (about 200 MB, one time). If your network blocks
that, download the four files yourself and drop them into `./bin`.

## Build the installer

```
npm run dist            # dist\Music Player Setup 1.0.0.exe  (per-user installer)
npm run dist:portable   # single portable .exe
```

The installer isn't code-signed, so Windows SmartScreen will show a warning the
first time ("More info" > "Run anyway").

## Where your data lives

`%APPDATA%\Music Player\`

| Item | What it is |
|---|---|
| `IndexedDB`, `Local Storage` | your playlists and songs |
| `import_queue\` | drop audio files here, then File > Open import folder |
| `bin\yt-dlp.exe` | the auto-updating copy of yt-dlp |
| `downloads\` | temporary; emptied at every launch |

Uninstalling does **not** delete this folder.

**Moving your existing library in:** open the old browser version, export your
playlists from the homepage (`.musicdb.zip`), then use *Import Library* in the app.

## YouTube downloads

- yt-dlp updates itself in the background at most once a day. YouTube changes
  often, so this matters.
- If downloads start failing: **Downloader > Update yt-dlp**. If that doesn't
  help, **Downloader > Switch to nightly builds and update** (nightly gets fixes
  first).
- Links are queued and run one at a time. **Downloader > Cancel downloads**
  stops the current one.
- Failures now show up as a message in the app instead of silently doing nothing.

Only download things you have the right to download.

## What changed from the Flask version

- `app.py`, `Procfile`, `requirements.txt` and `help.txt` are no longer needed.
- Removed the startup code that ran `taskkill /IM ffmpeg.exe` / `pkill ffmpeg`. It
  killed every ffmpeg on the machine, not just yours. The app now only stops
  processes it started itself.
- No hard-coded `C:\Users\...` paths; nothing is required to be installed.
- `--no-check-certificates` is no longer used.
- Front-end libraries (JSZip, FileSaver, SortableJS) and the Poppins font are
  bundled locally instead of loaded from CDNs, so the app works offline.
- Small edits to the HTML: those script/font links, and downloader status/error
  messages shown as toasts (which now stay up for 7 seconds). `homepage.html`
  also loads Poppins now; it asked for it before but never loaded it.

## Good to know

- The app serves itself on `http://127.0.0.1:48731`. The port is fixed on
  purpose: browsers store IndexedDB per origin, so a changing port would look
  like an empty library. If another program is using that port, set
  `MUSIC_PLAYER_PORT` (a different port = a separate library).
- If you start a playlist download and then leave that playlist page, finished
  songs are held and added to whichever playlist page you open next. (Same as
  the Flask version.)

## Project layout

```
main.js          Electron entry: window, menu, updates, shutdown
server.js        Local server (same endpoints app.py had)
downloader.js    Download queue (port of download_logic())
binaries.js      Finds/runs/updates yt-dlp, ffmpeg, Deno
renderer/        homepage.html, index.html (+ generated vendor/)
scripts/         copy-vendor.js, fetch-binaries.js
build/           icon.ico / icon.png
bin/             yt-dlp.exe, deno.exe, ffmpeg.exe, ffprobe.exe (downloaded)
```
