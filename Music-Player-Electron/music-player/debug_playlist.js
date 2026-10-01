/**
 * Debug script: runs a full YouTube playlist job end-to-end with full logging.
 * Usage: node debug_playlist.js <playlist-url>
 */
'use strict';

const { createBinaries } = require('./binaries.js');
const { createDownloader, explain } = require('./downloader.js');
const path = require('path');
const os = require('os');
const fs = require('fs');

const url = process.argv[2] || 'https://www.youtube.com/playlist?list=PLOU2XLYxmsILe6_eGvDN3GyiodoV3qNSC';
const downloadsDir = path.join(os.tmpdir(), 'mp-debug-dl');
fs.mkdirSync(downloadsDir, { recursive: true });

const binaries = createBinaries({
  resourcesBinDir: path.join(__dirname, 'bin'),
  userBinDir: path.join(os.tmpdir(), 'mp-debug-bin'),
  log: (...a) => console.log('[binaries]', ...a),
});

const events = [];
const downloader = createDownloader({
  binaries,
  downloadsDir,
  log: (...a) => console.log('[dl-log]', ...a),
  publish: (evt) => {
    events.push(evt);
    if (evt.progress) {
      const p = evt.progress;
      console.log(`[progress] state=${p.state} current=${p.current}/${p.total} song="${p.currentSong}"`);
    } else if (evt.filename) {
      console.log(`[FILENAME] ${evt.filename} (sourceId=${evt.sourceId})`);
    } else if (evt.linked) {
      console.log(`[LINKED]   songId=${evt.songId} sourceId=${evt.sourceId} title="${evt.title}"`);
    } else if (evt.title && evt.message) {
      console.log(`[ERROR]    "${evt.title}" -> ${evt.message}`);
    } else {
      console.log(`[event]    ${JSON.stringify(evt)}`);
    }
  },
  pacing: { betweenSongsMs: [100, 200], restEvery: 999, restMs: [100, 200], retryMs: [100, 300] },
});

// Also patch getInfo directly to see what yt-dlp returns
const origRun = binaries.run.bind(binaries);
let getInfoCallCount = 0;
binaries.run = async function(args, opts) {
  if (args.includes('--flat-playlist')) {
    getInfoCallCount++;
    console.log(`[getInfo #${getInfoCallCount}] url=`, args[args.length - 1]);
    const r = await origRun(args, opts);
    console.log(`[getInfo #${getInfoCallCount}] exit=${r.code} stderr_tail=${r.stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
    const txt = r.stdout.trim();
    if (txt) {
      try {
        const info = JSON.parse(txt);
        console.log(`[getInfo #${getInfoCallCount}] _type=${info._type} entries_count=${info.entries ? info.entries.length : 'N/A'} title="${info.title}"`);
        if (info.entries && info.entries.length > 0) {
          const first = info.entries[0];
          console.log(`[getInfo #${getInfoCallCount}] first entry: id=${first.id} url=${first.url}`);
        }
      } catch(e) {
        console.log(`[getInfo #${getInfoCallCount}] JSON parse failed: ${e.message}`);
      }
    } else {
      console.log(`[getInfo #${getInfoCallCount}] EMPTY stdout!`);
    }
    return r;
  }
  return origRun(args, opts);
};

console.log('Starting playlist download debug for:', url);
downloader.enqueue(url, {});

// Wait for download to finish (or timeout after 5 mins for 1 song)
const start = Date.now();
const check = setInterval(() => {
  if (!downloader.isBusy()) {
    clearInterval(check);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\nDone in ${elapsed}s. Total events: ${events.length}`);
    process.exit(0);
  }
  if (Date.now() - start > 300000) {
    clearInterval(check);
    console.log('TIMEOUT after 5 minutes');
    process.exit(1);
  }
}, 500);
