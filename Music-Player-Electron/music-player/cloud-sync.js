'use strict';
/**
 * Cloud mirror: copies the local library (library/audio, library/covers, library/meta/library.json)
 * to an S3-compatible bucket (Backblaze B2) so the phone app can read it while the PC is off.
 *
 * - Uploads only what the bucket doesn't already have (compares object names + sizes), so it
 *   resumes cleanly after an interruption and a fully synced library costs a few list calls.
 * - library.json is uploaded LAST, so the phone never sees a song whose audio isn't there yet.
 * - Never deletes anything in the cloud.
 * - Credentials live in <userData>/cloud.json (never shipped with the app).
 *
 * Bucket layout (the phone app reads exactly this):
 *   audio/<id>.mp3   covers/<id>.jpg   meta/library.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { signRequest } = require('./sigv4');

const CONCURRENCY = 3;
const RETRIES = 3;
const REQUEST_TIMEOUT_MS = 120000;
const DEBOUNCE_MS = 30000;
const START_DELAY_MS = 20000;

const CONFIG_TEMPLATE = {
  endpoint: 'PASTE-YOUR-ENDPOINT-HERE  (e.g. s3.us-west-004.backblazeb2.com)',
  bucket: 'Solance',
  keyId: '005b344cdd48d1d0000000003',
  appKey: 'PASTE-THE-PC-APPLICATION-KEY-HERE',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function createCloudSync({ userData, libraryDir, libraryStore, log = () => {} }) {
  const configFile = path.join(userData, 'cloud.json');
  const stateFile = path.join(userData, 'cloud-state.json');
  const libraryJson = path.join(libraryDir, 'meta', 'library.json');

  let running = false;
  let again = false;
  let timer = null;
  let progress = { phase: 'idle', done: 0, total: 0 };
  let last = null; // { at, ok, uploaded, failed, message }

  // ----------------------------------------------------------------- config --
  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return {}; }
  }
  function writeState(patch) {
    try { fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch })); } catch (_) { /* not critical */ }
  }

  function loadConfig() {
    let j;
    try { j = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) { return null; }
    const endpoint = String((j && j.endpoint) || '').trim();
    const bucket = String((j && j.bucket) || '').trim();
    const keyId = String((j && j.keyId) || '').trim();
    const appKey = String((j && j.appKey) || '').trim();
    if (!endpoint || !bucket || !keyId || !appKey || /PASTE/i.test(endpoint + appKey)) return null;

    let scheme = 'https';
    let host = endpoint.replace(/\/+$/, '');
    const m = /^(https?):\/\/(.+)$/i.exec(host);
    if (m) { scheme = m[1].toLowerCase(); host = m[2]; }
    // B2: s3.<region>.backblazeb2.com
    const r = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(host);
    const region = (j.region && String(j.region)) || (r ? r[1] : 'us-east-1');
    return { scheme, host, region, bucket, keyId, appKey };
  }

  function isConfigured() { return !!loadConfig(); }

  /** Create a template cloud.json if missing; returns its path. */
  function ensureConfigFile() {
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(CONFIG_TEMPLATE, null, 2), { mode: 0o600 });
    }
    return configFile;
  }

  // ---------------------------------------------------------------- requests --
  function rawRequest(cfg, method, key, { query, body, headers } = {}) {
    const pathname = `/${cfg.bucket}${key ? '/' + key : ''}`;
    const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const signed = signRequest({
      method, host: cfg.host, path: pathname, query, region: cfg.region,
      headers: { ...(headers || {}), ...(buf.length || method === 'PUT' ? { 'Content-Length': buf.length } : {}) },
      body: buf, accessKeyId: cfg.keyId, secretAccessKey: cfg.appKey,
    });
    const [hostname, port] = cfg.host.split(':');
    const lib = cfg.scheme === 'http' ? http : https;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        { hostname, port: port ? Number(port) : undefined, path: signed.url, method, headers: signed.headers, timeout: REQUEST_TIMEOUT_MS },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }
      );
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      if (buf.length) req.write(buf);
      req.end();
    });
  }

  function errText(r) {
    const t = r.body.toString('utf8');
    const code = /<Code>(.*?)<\/Code>/.exec(t);
    const msg = /<Message>(.*?)<\/Message>/.exec(t);
    return `HTTP ${r.status}${code ? ' ' + code[1] : ''}${msg ? ': ' + xmlUnescape(msg[1]) : ''}`;
  }

  async function withRetry(fn) {
    let lastErr;
    for (let i = 1; i <= RETRIES; i++) {
      try { return await fn(); } catch (err) {
        lastErr = err;
        if (err && err.fatal) break; // wrong key / bucket: retrying won't help
        await sleep(1000 * i);
      }
    }
    throw lastErr;
  }

  function fatalIfAuth(r) {
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      const e = new Error(errText(r));
      e.fatal = true;
      throw e;
    }
    throw new Error(errText(r));
  }

  /** Map of object key -> size for everything under `prefix`. */
  async function list(cfg, prefix) {
    const out = new Map();
    let token = '';
    do {
      const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const r = await withRetry(async () => {
        const res = await rawRequest(cfg, 'GET', '', { query });
        if (res.status !== 200) fatalIfAuth(res);
        return res;
      });
      const xml = r.body.toString('utf8');
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
        const s = /<Size>(\d+)<\/Size>/.exec(m[1]);
        if (k) out.set(xmlUnescape(k[1]), s ? Number(s[1]) : -1);
      }
      const trunc = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
      token = trunc && next ? xmlUnescape(next[1]) : '';
    } while (token);
    return out;
  }

  async function putFile(cfg, key, file, contentType) {
    const body = fs.readFileSync(file);
    await withRetry(async () => {
      const r = await rawRequest(cfg, 'PUT', key, { body, headers: { 'Content-Type': contentType } });
      if (r.status !== 200) fatalIfAuth(r);
    });
    return body.length;
  }

  // -------------------------------------------------------------------- sync --
  async function runPool(items, worker) {
    let i = 0;
    let failed = 0;
    const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try { await worker(item); } catch (err) {
          if (err && err.fatal) throw err;
          failed++;
          log('Cloud sync: failed', item.key, '-', err.message);
        }
        progress.done++;
      }
    });
    await Promise.all(runners);
    return failed;
  }

  function sizeOf(file) {
    try { return fs.statSync(file).size; } catch (_) { return -1; }
  }

  async function doSync({ full = false } = {}) {
    const cfg = loadConfig();
    if (!cfg) return { ok: false, message: 'Cloud sync is not set up yet (cloud.json).' };

    progress = { phase: 'Checking what is already in the cloud…', done: 0, total: 0 };
    const [remoteAudio, remoteCovers] = await Promise.all([list(cfg, 'audio/'), list(cfg, 'covers/')]);
    const ids = libraryStore.listIds();

    const jobs = [];
    for (const id of ids.audio) {
      const file = libraryStore.audioPath(id);
      if (!file) continue;
      const key = `audio/${id}.mp3`;
      if (remoteAudio.get(key) !== sizeOf(file)) jobs.push({ key, file, type: 'audio/mpeg' });
    }
    for (const id of ids.covers) {
      const file = libraryStore.coverPath(id);
      if (!file) continue;
      const key = `covers/${id}.jpg`;
      if (remoteCovers.get(key) !== sizeOf(file)) jobs.push({ key, file, type: 'image/jpeg' });
    }

    progress = { phase: 'Uploading songs…', done: 0, total: jobs.length };
    let uploaded = 0;
    const failed = await runPool(jobs, async (job) => {
      await putFile(cfg, job.key, job.file, job.type);
      uploaded++;
    });

    // library.json last (and only if every song uploaded, so the phone never gets a half-copied library)
    let libraryUploaded = false;
    if (fs.existsSync(libraryJson)) {
      const bytes = fs.readFileSync(libraryJson);
      const hash = sha1(bytes);
      if (failed === 0 && (full || readState().libraryHash !== hash)) {
        progress = { phase: 'Uploading library…', done: 0, total: 1 };
        await putFile(cfg, 'meta/library.json', libraryJson, 'application/json');
        writeState({ libraryHash: hash });
        libraryUploaded = true;
      }
    }
    return { ok: failed === 0, uploaded, failed, total: jobs.length, libraryUploaded };
  }

  /** Run one sync (never two at once; a request during a run triggers one more pass). */
  async function sync(opts = {}) {
    if (running) { again = true; return { ok: true, message: 'A sync is already running.' }; }
    running = true;
    let result;
    try {
      result = await doSync(opts);
      if (result.ok && !result.message) {
        result.message = result.total === 0 && !result.libraryUploaded
          ? 'Everything is already in the cloud.'
          : `Uploaded ${result.uploaded} file${result.uploaded === 1 ? '' : 's'}${result.libraryUploaded ? ' and the library list' : ''}.`;
      } else if (!result.ok && !result.message) {
        result.message = `${result.failed} file${result.failed === 1 ? '' : 's'} could not be uploaded. They will be retried next time.`;
      }
    } catch (err) {
      result = { ok: false, message: err.message || String(err) };
      log('Cloud sync error:', result.message);
    } finally {
      running = false;
      progress = { phase: 'idle', done: 0, total: 0 };
    }
    last = { at: new Date().toISOString(), ...result };
    log('Cloud sync:', last.message);
    if (again) { again = false; scheduleSync(2000); }
    return last;
  }

  function scheduleSync(delay = DEBOUNCE_MS) {
    if (!isConfigured()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { sync().catch(() => {}); }, delay);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (isConfigured()) scheduleSync(START_DELAY_MS);
  }

  /** Writes and removes a tiny object, so a wrong key / bucket / permission shows up with a clear message. */
  async function testConnection() {
    const cfg = loadConfig();
    if (!cfg) return { ok: false, message: 'cloud.json is missing or still has placeholders.' };
    try {
      await list(cfg, 'meta/');
      const key = 'meta/connection-test.txt';
      await withRetry(async () => {
        const r = await rawRequest(cfg, 'PUT', key, { body: 'ok', headers: { 'Content-Type': 'text/plain' } });
        if (r.status !== 200) fatalIfAuth(r);
      });
      await rawRequest(cfg, 'DELETE', key);
      return { ok: true, message: `Connected to bucket "${cfg.bucket}" and could write to it.` };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  }

  function status() {
    return { configured: isConfigured(), running, progress, last };
  }

  return { isConfigured, ensureConfigFile, configFile, sync, scheduleSync, start, testConnection, status };
}

module.exports = { createCloudSync };
