'use strict';
/**
 * Downloads the Windows helper programs into ./bin (they get bundled into the
 * installer by electron-builder):
 *
 *   yt-dlp.exe            https://github.com/yt-dlp/yt-dlp
 *   deno.exe              https://github.com/denoland/deno   (JS runtime YouTube needs)
 *   ffmpeg.exe/ffprobe.exe  gyan.dev essentials build (BtbN GitHub build as fallback)
 *
 * Usage:
 *   node scripts/fetch-binaries.js            download anything missing
 *   node scripts/fetch-binaries.js --force    re-download everything
 *   node scripts/fetch-binaries.js --optional never fail (used by `npm start`)
 *
 * If your network blocks these downloads, just drop the four .exe files into
 * ./bin by hand.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const OPTIONAL = args.has('--optional');

const binDir = path.join(__dirname, '..', 'bin');
fs.mkdirSync(binDir, { recursive: true });

const has = (name) => fs.existsSync(path.join(binDir, name));

async function download(url, dest) {
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'music-player-setup' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let nextReport = 0.1;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    if (total && got / total >= nextReport) {
      process.stdout.write(`    ${Math.round((got / total) * 100)}%\n`);
      nextReport += 0.1;
    }
  });

  await pipeline(body, fs.createWriteStream(dest));
  if (fs.statSync(dest).size < 1024 * 1024) throw new Error(`Download looks incomplete: ${url}`);
}

async function withTemp(fn) {
  const tmp = path.join(binDir, `.download-${Date.now()}.tmp`);
  try {
    return await fn(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Pull specific files (matched by regex on the entry path) out of a zip. */
function extractFromZip(zipFile, wanted) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries();
  for (const [regex, outName] of wanted) {
    const entry = entries.find((e) => !e.isDirectory && regex.test(e.entryName));
    if (!entry) throw new Error(`"${outName}" not found inside the downloaded zip`);
    fs.writeFileSync(path.join(binDir, outName), entry.getData());
    console.log(`  extracted ${outName}`);
  }
}

const TASKS = [
  {
    label: 'yt-dlp',
    files: ['yt-dlp.exe'],
    run: () =>
      withTemp(async (tmp) => {
        await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', tmp);
        fs.copyFileSync(tmp, path.join(binDir, 'yt-dlp.exe'));
      }),
  },
  {
    label: 'Deno (JavaScript runtime for YouTube)',
    files: ['deno.exe'],
    run: () =>
      withTemp(async (tmp) => {
        await download(
          'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
          tmp
        );
        extractFromZip(tmp, [[/(^|\/)deno\.exe$/i, 'deno.exe']]);
      }),
  },
  {
    label: 'ffmpeg + ffprobe',
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    run: async () => {
      const sources = [
        'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
        'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
      ];
      let lastErr;
      for (const url of sources) {
        try {
          await withTemp(async (tmp) => {
            await download(url, tmp);
            extractFromZip(tmp, [
              [/(^|\/)bin\/ffmpeg\.exe$/i, 'ffmpeg.exe'],
              [/(^|\/)bin\/ffprobe\.exe$/i, 'ffprobe.exe'],
            ]);
          });
          return;
        } catch (err) {
          lastErr = err;
          console.warn(`  failed (${err.message}), trying next source...`);
        }
      }
      throw lastErr;
    },
  },
];

(async () => {
  if (process.platform !== 'win32' && !FORCE) {
    console.log('[binaries] Not on Windows - skipping (these are Windows .exe files).');
    return;
  }

  const todo = TASKS.filter((t) => FORCE || !t.files.every(has));
  if (!todo.length) {
    console.log('[binaries] yt-dlp, deno, ffmpeg and ffprobe are already in ./bin');
    return;
  }

  let failed = false;
  for (const task of todo) {
    console.log(`[binaries] ${task.label}`);
    try {
      await task.run();
    } catch (err) {
      failed = true;
      console.error(`[binaries] FAILED: ${task.label}: ${err.message}`);
      console.error(`           You can place ${task.files.join(', ')} into ./bin manually.`);
    }
  }

  if (failed && !OPTIONAL) process.exit(1);
  if (failed) console.warn('[binaries] Some files are missing - YouTube downloads will not work until they are added.');
  else console.log('[binaries] Done.');
})();
