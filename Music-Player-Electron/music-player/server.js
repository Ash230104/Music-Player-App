'use strict';
/**
 * Tiny local web server that replaces Flask. It serves the two HTML pages and
 * implements the same endpoints app.py had, so index.html / homepage.html keep
 * working with their existing fetch("/download") / EventSource("/download-events")
 * calls:
 *
 *   GET  /                      -> homepage.html
 *   GET  /playlist?name=...     -> index.html
 *   GET  /vendor/*, etc.        -> static files from renderer/
 *   POST /download   {url, known} -> queue a YouTube download (`known` is an
 *                                  optional {videoId: songId} map so already-
 *                                  downloaded songs can be linked, not redownloaded)
 *   POST /download-cancel       -> cancel the current download queue
 *   GET  /download-events       -> Server-Sent Events (finished songs, status)
 *   GET  /downloads/<file>      -> finished mp3 (deleted shortly after it's served)
 *   POST /flush-import          -> list audio files in the import folder
 *   GET  /import-files/<file>   -> one file from the import folder
 *   POST /delete-import-file    {filename}
 *
 * It only listens on 127.0.0.1 and rejects requests whose Host/Origin aren't
 * ours, so a random website open in your browser can't drive it.
 *
 * The port is FIXED on purpose: IndexedDB and localStorage are stored per
 * origin (including the port), so a changing port would look like an empty
 * library every launch.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const AUDIO_EXT = /\.(mp3|wav|m4a|flac|ogg)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.mjs': 'text/javascript; charset=utf-8',
};

function createServer({ port, rendererDir, downloadsDir, importDir, onDownload, onCancel = () => {}, log = () => {} }) {
  const clients = new Set(); // open SSE responses
  const pending = []; //        events published while no page was listening

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // ------------------------------------------------------------- helpers --
  function send(res, status, body, type = 'text/plain; charset=utf-8') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  }
  const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), MIME['.json']);

  /** Resolve `rel` inside `base`, refusing anything that escapes it. */
  function safeJoin(base, rel) {
    let decoded;
    try {
      decoded = decodeURIComponent(rel);
    } catch (_) {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const root = path.resolve(base);
    const target = path.resolve(root, '.' + path.sep + decoded);
    return target === root || target.startsWith(root + path.sep) ? target : null;
  }

  function sendFile(req, res, file, { onDone } = {}) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');

      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };

      let start = 0;
      let end = st.size - 1;
      let status = 200;

      const range = req.headers.range;
      if (range && st.size > 0) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || (m[1] === '' && m[2] === '')) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        if (m[1] === '') {
          start = Math.max(0, st.size - parseInt(m[2], 10)); // suffix range
        } else {
          start = parseInt(m[1], 10);
          if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
        }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }

      headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || st.size === 0) return res.end();

      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      if (onDone) res.on('finish', onDone);
      stream.pipe(res);
    });
  }

  function readJson(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('Body too large'));
          req.destroy();
        } else {
          chunks.push(c);
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (_) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  // ------------------------------------------------------------------ SSE --
  const sseFormat = (evt) => `data: ${JSON.stringify(evt)}\n\n`;

  function publish(evt) {
    if (clients.size === 0) {
      // Nobody is listening (e.g. user is on the homepage). Hold on to it and
      // deliver when a playlist page connects.
      pending.push(evt);
      if (pending.length > 1000) pending.shift();
      return;
    }
    for (const res of clients) res.write(sseFormat(evt));
  }

  function handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    while (pending.length) res.write(sseFormat(pending.shift()));

    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  }

  // --------------------------------------------------------------- routes --
  const handler = async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, 'Forbidden');

      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      // ---- GET / HEAD ----
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/') return sendFile(req, res, path.join(rendererDir, 'homepage.html'));
        if (p === '/playlist') return sendFile(req, res, path.join(rendererDir, 'homepage.html'));
        if (p === '/download-events') return handleSse(req, res);

        if (p.startsWith('/downloads/')) {
          const name = safeJoin(downloadsDir, path.basename(decodeURIComponent(p.slice('/downloads/'.length))));
          if (!name) return send(res, 400, 'Bad path');
          // The page saves the blob into IndexedDB right away; drop our copy shortly after.
          return sendFile(req, res, name, {
            onDone: () => setTimeout(() => fs.rm(name, { force: true }, () => {}), 60000).unref(),
          });
        }

        if (p.startsWith('/import-files/')) {
          const name = safeJoin(importDir, path.basename(decodeURIComponent(p.slice('/import-files/'.length))));
          if (!name) return send(res, 400, 'Bad path');
          return sendFile(req, res, name);
        }

        // Static files from renderer/ (vendor scripts, fonts, ...). No dotfiles.
        const file = safeJoin(rendererDir, p.slice(1));
        if (!file || path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
        return sendFile(req, res, file);
      }

      // ---- POST ----
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) return send(res, 403, 'Forbidden');

        if (p === '/download') {
          const body = await readJson(req);
          const link = typeof body.url === 'string' ? body.url.trim() : '';
          let ok = /^https?:\/\/\S+$/i.test(link);
          if (ok) {
            try { new URL(link); } catch (_) { ok = false; }
          }
          if (!ok) return sendJson(res, 400, { error: 'Please enter a valid http(s) link.' });
          // Map of YouTube video id -> songId already in the user's library
          // (built by the renderer from IndexedDB), so the downloader can
          // skip re-downloading songs it already has.
          const known = (body.known && typeof body.known === 'object' && !Array.isArray(body.known))
            ? body.known
            : {};
          onDownload(link, known);
          return sendJson(res, 200, { status: 'started' });
        }

        if (p === '/download-cancel') {
          onCancel();
          return sendJson(res, 200, { status: 'cancelled' });
        }

        if (p === '/flush-import') {
          const files = fs.readdirSync(importDir).filter((f) => AUDIO_EXT.test(f));
          return sendJson(res, 200, { files });
        }

        if (p === '/delete-import-file') {
          const body = await readJson(req);
          const name = safeJoin(importDir, path.basename(String(body.filename || '')));
          if (name && name !== path.resolve(importDir)) fs.rmSync(name, { force: true });
          return sendJson(res, 200, { status: 'deleted' });
        }
      }

      return send(res, 404, 'Not found');
    } catch (err) {
      log('Server error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: String((err && err.message) || err) });
      else res.destroy();
    }
  };

  const server = http.createServer(handler);

  return {
    publish,
    origin: `http://127.0.0.1:${port}`,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

module.exports = { createServer };
