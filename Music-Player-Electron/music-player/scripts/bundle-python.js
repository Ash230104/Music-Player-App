'use strict';
/**
 * Downloads the Python 3.11 Windows embeddable runtime into ./python-embed
 * and installs spotifyscraper + httpx into it so spotify_scrape.py works
 * without requiring Python to be installed on the target machine.
 *
 * Usage:
 *   node scripts/bundle-python.js            -- set up if not already done
 *   node scripts/bundle-python.js --force    -- re-download everything
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const PYTHON_VERSION = '3.11.9';
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');

const embedDir = path.join(__dirname, '..', 'python-embed');
const pythonExe = path.join(embedDir, 'python.exe');
const pthFile = path.join(embedDir, `python311._pth`);
const sitePackages = path.join(embedDir, 'Lib', 'site-packages');

async function download(url, dest) {
  process.stdout.write(`  Downloading ${path.basename(url)}...\n`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'music-player-setup' },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let nextReport = 0.2;

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    if (total && got / total >= nextReport) {
      process.stdout.write(`    ${Math.round((got / total) * 100)}%\n`);
      nextReport += 0.2;
    }
  });

  await pipeline(body, fs.createWriteStream(dest));
}

async function main() {
  if (!FORCE && fs.existsSync(pythonExe) && fs.existsSync(sitePackages)) {
    console.log('[python-embed] Already set up. Use --force to re-download.');
    return;
  }

  console.log('[python-embed] Setting up embedded Python', PYTHON_VERSION);

  // ── 1. Download & extract the embeddable zip ──────────────────────────────
  const AdmZip = require('adm-zip');
  fs.mkdirSync(embedDir, { recursive: true });

  const zipPath = path.join(embedDir, 'python-embed.zip');
  await download(PYTHON_EMBED_URL, zipPath);

  console.log('  Extracting...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(embedDir, true);
  fs.rmSync(zipPath, { force: true });
  console.log('  Extracted.');

  // ── 2. Enable site-packages in the ._pth file ─────────────────────────────
  // The embeddable Python ships with "#import site" commented out — uncomment it.
  if (fs.existsSync(pthFile)) {
    let pth = fs.readFileSync(pthFile, 'utf8');
    pth = pth.replace('#import site', 'import site');
    // Make sure Lib\site-packages is on the path
    if (!pth.includes('Lib\\site-packages')) {
      pth += '\nLib\\site-packages\n';
    }
    fs.writeFileSync(pthFile, pth, 'utf8');
    console.log('  Enabled site-packages in', path.basename(pthFile));
  } else {
    // Create a generic one in case the version string differs
    const pthFiles = fs.readdirSync(embedDir).filter((f) => f.endsWith('._pth'));
    for (const f of pthFiles) {
      let pth = fs.readFileSync(path.join(embedDir, f), 'utf8');
      pth = pth.replace('#import site', 'import site');
      if (!pth.includes('Lib\\site-packages')) pth += '\nLib\\site-packages\n';
      fs.writeFileSync(path.join(embedDir, f), pth, 'utf8');
      console.log('  Enabled site-packages in', f);
    }
  }

  // ── 3. Install pip into the embeddable Python ─────────────────────────────
  const getPipPath = path.join(embedDir, 'get-pip.py');
  await download(GET_PIP_URL, getPipPath);
  console.log('  Installing pip...');
  execSync(`"${pythonExe}" "${getPipPath}"`, { stdio: 'inherit' });
  fs.rmSync(getPipPath, { force: true });

  // ── 4. Install spotifyscraper + httpx ─────────────────────────────────────
  const pipExe = path.join(embedDir, 'Scripts', 'pip.exe');
  console.log('  Installing spotifyscraper + httpx...');
  execSync(
    `"${pipExe}" install spotifyscraper httpx --target "${sitePackages}" --no-warn-script-location`,
    { stdio: 'inherit' }
  );

  console.log('[python-embed] Done! Embedded Python is ready in ./python-embed');
}

main().catch((err) => {
  console.error('[python-embed] FAILED:', err.message);
  process.exit(1);
});
