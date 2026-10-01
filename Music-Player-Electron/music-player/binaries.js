'use strict';
/**
 * Locates the bundled helper programs (yt-dlp, ffmpeg, ffprobe, Deno), runs
 * yt-dlp, and keeps yt-dlp up to date.
 *
 * Why yt-dlp is copied to a writable folder: the installed app's resources
 * folder may not be writable (e.g. Program Files), but yt-dlp has to replace
 * its own .exe when it updates. So the bundled copy is only a starting point;
 * the app always runs the copy in <userData>/bin.
 *
 * Why Deno is bundled: YouTube now needs a JavaScript runtime to be solved
 * during extraction, and Deno is the one yt-dlp enables by default. It is found
 * via PATH (see makeEnv), so no command-line flag is needed.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

/** Compare yt-dlp version strings like "2026.05.24" or "2026.03.03.162040". */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function createBinaries({ resourcesBinDir, userBinDir, log = () => {} }) {
  fs.mkdirSync(userBinDir, { recursive: true });

  const bundled = {
    ytdlp: path.join(resourcesBinDir, exe('yt-dlp')),
    ffmpeg: path.join(resourcesBinDir, exe('ffmpeg')),
    ffprobe: path.join(resourcesBinDir, exe('ffprobe')),
    deno: path.join(resourcesBinDir, exe('deno')),
  };
  const ytdlpPath = path.join(userBinDir, exe('yt-dlp'));

  const paths = {
    ytdlp: ytdlpPath,
    ffmpegDir: resourcesBinDir,
    deno: bundled.deno,
  };

  const children = new Set();

  function makeEnv() {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    // Windows env keys are case-insensitive ("Path"); don't create a 2nd "PATH".
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = resourcesBinDir + path.delimiter + (env[key] || '');
    return env;
  }

  /** Spawn a program and collect its output. Never rejects. */
  function spawnRaw(cmd, args, { timeoutMs = 0 } = {}) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer = null;

      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };

      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true, env: makeEnv() });
      } catch (err) {
        stderr = String(err && err.message ? err.message : err);
        return finish(-1);
      }
      children.add(child);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > 300000) stderr = stderr.slice(-200000);
      });
      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        children.delete(child);
        finish(-1);
      });
      child.on('close', (code) => {
        children.delete(child);
        finish(code === null ? -1 : code);
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => killChild(child), timeoutMs);
      }
    });
  }

  function killChild(child) {
    try {
      if (isWin) {
        // yt-dlp.exe is a launcher that spawns a child; kill the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch (_) {
      /* already gone */
    }
  }

  /** Kill only the processes THIS app started (never anyone else's ffmpeg). */
  function killAll() {
    for (const child of children) killChild(child);
    children.clear();
  }

  async function getVersion(file = ytdlpPath) {
    if (!fs.existsSync(file)) return '';
    const r = await spawnRaw(file, ['--version'], { timeoutMs: 30000 });
    return r.code === 0 ? r.stdout.trim() : '';
  }

  // --- first-run copy / upgrade of the bundled yt-dlp -----------------------
  let readyPromise = null;
  function prepare() {
    if (!readyPromise) {
      readyPromise = (async () => {
        if (!fs.existsSync(bundled.ytdlp)) return; // missing() will report it
        const haveUserCopy = fs.existsSync(ytdlpPath);
        let copy = !haveUserCopy;
        if (haveUserCopy) {
          const [vb, vu] = await Promise.all([getVersion(bundled.ytdlp), getVersion(ytdlpPath)]);
          copy = !vu || (vb && compareVersions(vb, vu) > 0);
        }
        if (copy) {
          fs.copyFileSync(bundled.ytdlp, ytdlpPath);
          log('Copied bundled yt-dlp to', ytdlpPath);
        }
      })().catch((err) => log('prepare() failed:', err));
    }
    return readyPromise;
  }

  // --- updating -------------------------------------------------------------
  let updating = Promise.resolve();

  /**
   * channel undefined -> update within the current channel (-U)
   * channel 'stable' | 'nightly' -> switch to / update that channel
   */
  function update(channel) {
    const job = updating.then(async () => {
      await prepare();
      if (!fs.existsSync(ytdlpPath)) return { ok: false, output: 'yt-dlp is not installed.' };
      const args = channel ? ['--update-to', channel] : ['-U'];
      const r = await spawnRaw(ytdlpPath, args, { timeoutMs: 120000 });
      return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
    });
    updating = job.catch(() => {});
    return job;
  }

  /** Run yt-dlp (waits for first-run setup and any update in progress). */
  async function run(args, opts) {
    await prepare();
    await updating;
    return spawnRaw(ytdlpPath, args, opts);
  }

  /**
   * Args that every yt-dlp call needs.
   *
   * There is deliberately no --js-runtimes flag: yt-dlp enables Deno by default
   * and finds it on PATH, and makeEnv() puts the bundled folder (which contains
   * deno.exe) at the front of PATH. That avoids depending on how yt-dlp parses
   * a "deno:C:\\some\\path" value.
   */
  function commonArgs() {
    return ['--ffmpeg-location', paths.ffmpegDir, '--force-ipv4', '--no-color'];
  }

  /** Human-readable list of anything that is missing. */
  function missing() {
    const out = [];
    if (!fs.existsSync(ytdlpPath) && !fs.existsSync(bundled.ytdlp)) out.push(exe('yt-dlp'));
    if (!fs.existsSync(bundled.ffmpeg)) out.push(exe('ffmpeg'));
    if (!fs.existsSync(bundled.ffprobe)) out.push(exe('ffprobe'));
    if (!fs.existsSync(bundled.deno)) out.push(exe('deno'));
    return out;
  }

  return {
    paths,
    prepare,
    run,
    update,
    getVersion: () => getVersion(ytdlpPath),
    commonArgs,
    missing,
    killAll,
  };
}

module.exports = { createBinaries, compareVersions };
