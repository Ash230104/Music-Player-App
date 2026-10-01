'use strict';
/**
 * npm run setup-analyzer
 *
 * 1. Copies the browser builds of Essentia.js and TensorFlow.js from node_modules
 *    into renderer/vendor/essentia/
 *    (needs:  npm install --save-dev essentia.js @tensorflow/tfjs)
 * 2. Downloads the Essentia TensorFlow.js models (about 3 MB each) into renderer/models/<name>/
 *    together with the model's metadata (class names) as meta.json.
 *
 * 3. Copies transformers.js into renderer/vendor/transformers/ and downloads the quantized
 *    Whisper-tiny files (about 45 MB) into renderer/models/transformers/whisper-tiny/,
 *    which is what the language detection uses. Skip it with --no-language.
 *
 * Options:  --force            re-download models that already exist
 *           --libs-only        only copy the JS libraries
 *           --models-only      only download the models
 *           --no-language      skip transformers.js + Whisper
 *           --models-base=URL  use another mirror (default https://essentia.upf.edu/models/)
 *           --whisper=REPO     another Whisper build (default Xenova/whisper-tiny;
 *                              Xenova/whisper-base is bigger and a bit more accurate)
 * No extra npm packages are needed: it uses Node's https and the OS's tar / PowerShell / unzip.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (name, dflt) => {
  const a = args.find((x) => x.startsWith(name + '='));
  return a ? a.slice(name.length + 1) : dflt;
};

const MODELS_BASE = (arg('--models-base', 'https://essentia.upf.edu/models/')).replace(/\/?$/, '/');
const VENDOR_DIR = path.join(ROOT, 'renderer', 'vendor', 'essentia');
const MODELS_DIR = path.join(ROOT, 'renderer', 'models');

// ---- language detection (Whisper through transformers.js) ----
const TF_VENDOR_DIR = path.join(ROOT, 'renderer', 'vendor', 'transformers');
const TF_MODELS_DIR = path.join(MODELS_DIR, 'transformers');
const HF_BASE = (arg('--hf-base', 'https://huggingface.co/')).replace(/\/?$/, '/');
const WHISPER_REPO = arg('--whisper', 'Xenova/whisper-tiny');
const WHISPER_NAME = WHISPER_REPO.split('/').pop();
// transformers.js expects exactly this layout under localModelPath/<name>/
const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

// name -> candidate paths for the *-tfjs.zip (the site has moved some models into legacy/)
const c = (folder, file) => [`classifiers/${folder}/${file}`, `legacy/classifiers/${folder}/${file}`];
const MODELS = [
  { name: 'msd-musicnn', required: false, zips: ['autotagging/msd/msd-musicnn-1-tfjs.zip'] },
  { name: 'genre_tzanetakis', required: true, zips: c('genre_tzanetakis', 'genre_tzanetakis-musicnn-msd-2-tfjs.zip') },
  { name: 'genre_rosamerica', required: false, zips: c('genre_rosamerica', 'genre_rosamerica-musicnn-msd-2-tfjs.zip') },
  { name: 'mood_happy', required: false, zips: c('mood_happy', 'mood_happy-musicnn-msd-2-tfjs.zip') },
  { name: 'mood_sad', required: true, zips: c('mood_sad', 'mood_sad-musicnn-msd-2-tfjs.zip') },
  { name: 'mood_relaxed', required: true, zips: c('mood_relaxed', 'mood_relaxed-musicnn-msd-2-tfjs.zip') },
  { name: 'mood_party', required: false, zips: c('mood_party', 'mood_party-musicnn-msd-2-tfjs.zip') },
  { name: 'mood_aggressive', required: false, zips: c('mood_aggressive', 'mood_aggressive-musicnn-msd-2-tfjs.zip') },
];

// ---------------------------------------------------------------- libraries ----
function copyLibs() {
  console.log('\n== JavaScript libraries ==');
  const nm = path.join(ROOT, 'node_modules');
  const essDist = path.join(nm, 'essentia.js', 'dist');
  const tfDist = path.join(nm, '@tensorflow', 'tfjs', 'dist');
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  const plan = [];
  if (!fs.existsSync(essDist)) {
    console.error('  x node_modules/essentia.js/dist not found. Run:  npm install --save-dev essentia.js @tensorflow/tfjs');
    return false;
  }
  const essFiles = fs.readdirSync(essDist);
  for (const f of essFiles) {
    if (/^essentia-wasm\.web\./.test(f) && !/\.(map|ts)$/.test(f)) plan.push([path.join(essDist, f), f]);
  }
  for (const f of ['essentia.js-core.js', 'essentia.js-model.js']) {
    if (essFiles.includes(f)) plan.push([path.join(essDist, f), f]);
  }
  const tf = path.join(tfDist, 'tf.min.js');
  if (fs.existsSync(tf)) plan.push([tf, 'tf.min.js']);

  for (const [src, name] of plan) {
    fs.copyFileSync(src, path.join(VENDOR_DIR, name));
    console.log('  + ' + name + '  (' + Math.round(fs.statSync(src).size / 1024) + ' KB)');
  }

  const need = ['essentia-wasm.web.js', 'essentia.js-core.js', 'essentia.js-model.js', 'tf.min.js'];
  const missing = need.filter((n) => !fs.existsSync(path.join(VENDOR_DIR, n)));
  if (missing.length) {
    console.error('  x missing after copy: ' + missing.join(', '));
    console.error('    files found in essentia.js/dist: ' + essFiles.join(', '));
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ models ------
function fetchToFile(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'music-player-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchToFile(new URL(res.headers.location, url).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('HTTP ' + res.statusCode);
        e.status = res.statusCode;
        return reject(e);
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

function extract(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const attempts = [['tar', ['-xf', zipPath, '-C', dest]]];
  if (process.platform === 'win32') {
    attempts.push(['powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${dest}'`]]);
  }
  attempts.push(['unzip', ['-o', '-q', zipPath, '-d', dest]]);
  for (const [cmd, a] of attempts) {
    const r = spawnSync(cmd, a, { stdio: 'pipe' });
    if (r.status === 0) return true;
  }
  return false;
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
  }
  return null;
}

/** The zip may hold model.json at the top or inside a folder: make dest/model.json always work. */
function flatten(dest) {
  const found = findFile(dest, 'model.json');
  if (!found) return false;
  const dir = path.dirname(found);
  if (dir !== dest) {
    for (const f of fs.readdirSync(dir)) fs.renameSync(path.join(dir, f), path.join(dest, f));
  }
  return true;
}

async function getModel(m) {
  const dest = path.join(MODELS_DIR, m.name);
  const done = fs.existsSync(path.join(dest, 'model.json')) && fs.existsSync(path.join(dest, 'meta.json'));
  if (done && !has('--force')) return { ok: true, note: 'already there' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'essentia-'));
  try {
    for (const rel of m.zips) {
      const zipPath = path.join(tmp, 'model.zip');
      try {
        await fetchToFile(MODELS_BASE + rel, zipPath);
      } catch (e) {
        if (e.status === 404) continue;      // try the next candidate location
        throw e;
      }
      fs.rmSync(dest, { recursive: true, force: true });
      if (!extract(zipPath, dest)) return { ok: false, note: 'could not unzip (need tar, PowerShell or unzip)' };
      if (!flatten(dest)) return { ok: false, note: 'zip had no model.json' };

      // metadata with the class names sits next to the zip: <name>-tfjs.zip -> <name>.json
      const metaRel = rel.replace(/-tfjs\.zip$/, '.json');
      try {
        await fetchToFile(MODELS_BASE + metaRel, path.join(dest, 'meta.json'));
      } catch (e) {
        return { ok: false, note: 'model downloaded but metadata missing (' + e.message + ')' };
      }
      return { ok: true, note: 'from ' + rel };
    }
    return { ok: false, note: 'not found at any known location' };
  } catch (e) {
    return { ok: false, note: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function getModels() {
  console.log('\n== Models (' + MODELS_BASE + ') ==');
  let requiredMissing = 0;
  for (const m of MODELS) {
    process.stdout.write('  ' + m.name.padEnd(18));
    const r = await getModel(m);
    console.log((r.ok ? 'ok      ' : (m.required ? 'MISSING ' : 'skipped ')) + r.note);
    if (!r.ok && m.required) requiredMissing++;
  }
  if (requiredMissing) console.error('\n  x ' + requiredMissing + ' required model(s) missing. Check your connection and run again.');
  else console.log('\n  Optional models that were skipped are simply not used.');
  return requiredMissing === 0;
}

// -------------------------------------------------- language: transformers.js ----
function copyTransformers() {
  console.log('\n== transformers.js (language detection) ==');
  const dist = path.join(ROOT, 'node_modules', '@xenova', 'transformers', 'dist');
  if (!fs.existsSync(dist)) {
    console.error('  x node_modules/@xenova/transformers/dist not found.');
    console.error('    Run:  npm install --save-dev @xenova/transformers');
    return false;
  }
  fs.mkdirSync(TF_VENDOR_DIR, { recursive: true });

  // the ESM bundle plus the ONNX Runtime wasm binaries it loads at runtime
  const wanted = fs.readdirSync(dist).filter(
    (f) => f === 'transformers.min.js' || /^ort-wasm.*\.(wasm|mjs|js)$/.test(f)
  );
  for (const f of wanted) {
    fs.copyFileSync(path.join(dist, f), path.join(TF_VENDOR_DIR, f));
    console.log('  + ' + f + '  (' + Math.round(fs.statSync(path.join(dist, f)).size / 1024) + ' KB)');
  }
  if (!fs.existsSync(path.join(TF_VENDOR_DIR, 'transformers.min.js'))) {
    console.error('  x transformers.min.js not found in ' + dist);
    console.error('    files there: ' + fs.readdirSync(dist).join(', '));
    return false;
  }
  return true;
}

async function getWhisper() {
  console.log('\n== Whisper model (' + WHISPER_REPO + ') ==');
  const dest = path.join(TF_MODELS_DIR, WHISPER_NAME);
  let okAll = true;
  for (const rel of WHISPER_FILES) {
    const out = path.join(dest, rel.split('/').join(path.sep));
    process.stdout.write('  ' + rel.padEnd(42));
    if (fs.existsSync(out) && fs.statSync(out).size > 0 && !has('--force')) {
      console.log('already there');
      continue;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try {
      await fetchToFile(HF_BASE + WHISPER_REPO + '/resolve/main/' + rel, out);
      console.log('ok  (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
    } catch (e) {
      okAll = false;
      console.log('FAILED  ' + e.message);
      fs.rmSync(out, { force: true });
    }
  }
  if (!okAll) {
    console.error('\n  x Whisper files are missing. Genre/mood/tempo still work;');
    console.error('    language stays Unknown until this succeeds. Re-run with --force to retry.');
  }
  return okAll;
}

(async () => {
  let ok = true;
  const wantLanguage = !has('--no-language');
  if (!has('--models-only')) {
    ok = copyLibs() && ok;
    if (wantLanguage) ok = copyTransformers() && ok;
  }
  if (!has('--libs-only')) {
    ok = (await getModels()) && ok;
    if (wantLanguage) ok = (await getWhisper()) && ok;
  }
  console.log(ok ? '\nDone. Start the app and open Help > Analyzer self-test.' : '\nSetup incomplete (see above).');
  process.exit(ok ? 0 : 1);
})();
