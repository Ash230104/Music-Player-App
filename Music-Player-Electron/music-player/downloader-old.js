'use strict';
/**
 * Download queue. This is a Node port of download_logic() from app.py:
 *
 *   - single video  -> download it, emit one { filename } event
 *   - playlist      -> list entries (flat), download them one by one,
 *                      music.youtube.com first, youtube.com as fallback,
 *                      random pauses between songs, longer rest every 5 songs
 *
 * Differences from the Flask version (all deliberate):
 *   - Jobs run one at a time (a second link waits instead of running in
 *     parallel, which is what gets people rate-limited).
 *   - Errors are reported to the UI ({ title, message } events) instead of
 *     only being printed to a console nobody sees.
 *   - Cancelling only kills processes this app started.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PACING = {
  betweenSongsMs: [2000, 5000], // random pause after each song
  restEvery: 5, //                 long rest after every N songs
  restMs: [15000, 30000], //       ...of this length
  retryMs: [3000, 7000], //        pause before trying the fallback URL
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([lo, hi]) => Math.floor(lo + Math.random() * (hi - lo + 1));

const { spawn } = require('child_process');



function isSpotifyUrl(url) {
  try {
    const u = new URL(url);
    if (!(u.hostname === 'open.spotify.com' || u.hostname.endsWith('.spotify.com'))) {
      return false;
    }
    return /\/(playlist|track)\//.test(u.pathname);
  } catch {
    return false;
  }
}

function isSpotifyPlaylist(url) {
  try {
    const u = new URL(url);
    return (u.hostname === 'open.spotify.com' || u.hostname.endsWith('.spotify.com'))
      && /\/playlist\//.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Best-effort extraction of the 11-char YouTube video id from a watch/share
 * URL. Used only as a fallback identity for the "already in your library"
 * check below - if it can't be worked out, dedup for that one song is simply
 * skipped rather than treated as an error.
 */
function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/^music\./, '');
    if (host === 'youtube.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
      if (m) return m[2];
    }
    if (host === 'youtu.be') {
      return u.pathname.split('/').filter(Boolean)[0] || null;
    }
  } catch (_) { /* not a URL we understand */ }
  return null;
}

/** The `list=` playlist id of a YouTube / YouTube Music link, or null. */
function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/^music\./, '');
    if (host !== 'youtube.com' && host !== 'youtu.be') return null;
    const id = u.searchParams.get('list');
    return id && /^[\w-]{2,64}$/.test(id) ? id : null;
  } catch (_) { return null; }
}

/** yt-dlp's way of saying "this playlist needs a login" (private, or Liked videos). */
function looksLikePrivatePlaylist(stderr) {
  return /private playlist|playlist is private|playlist does not exist|playlist.*(not (available|viewable)|unavailable)|playlists? that require authentication/i.test(String(stderr || ''));
}

/** Normalize scraper/yt-dlp artist fields (string or array) to a single string. */
function formatArtist(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).join(', ');
  return String(raw || '').trim();
}

/**
 * Best-effort song title + artist from a yt-dlp info/entry object.
 * Prefers explicit metadata; falls back to splitting "Artist - Title".
 * Does not use uploader/channel (often "Topic" / VEVO, not the performer).
 */
function youtubeTrackMeta(entryOrInfo) {
  const e = entryOrInfo || {};
  let artist = formatArtist(e.artist || e.creator);
  let title = String(e.track || '').trim();
  const raw = String(e.title || '').trim();
  if (!artist && raw) {
    const m = raw.match(/^(.+?)\s+[–—-]\s+(.+)$/);
    if (m && m[1].trim() && m[2].trim()) {
      artist = m[1].trim();
      title = title || m[2].trim();
    }
  }
  if (!title) title = raw || String(e.id || '');
  return { title, artist };
}

/**
 * Resolve the Python executable to use.
 * Priority:
 *   1. Bundled embedded Python in resources/python-embed (packaged app)
 *   2. Bundled embedded Python in ./python-embed (dev mode)
 *   3. System 'python' / 'python3' as a last resort
 */
function resolvePythonExe() {
  const candidates = [];

  // Packaged app: Electron puts extraResources at process.resourcesPath
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'python-embed', 'python.exe'));
  }

  // Dev mode: python-embed lives next to package.json
  candidates.push(path.join(__dirname, 'python-embed', 'python.exe'));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fall back to system Python
  return process.platform === 'win32' ? 'python' : 'python3';
}

function scrapeSpotifyWithPython(playlistUrl) {
  return new Promise((resolve, reject) => {
    let script = path.join(__dirname, 'spotify_scrape.py');
    // Python is an external process and cannot read inside the .asar archive.
    if (script.includes('app.asar')) {
      script = script.replace('app.asar', 'app.asar.unpacked');
    }
    
    const python = resolvePythonExe();
    const proc = spawn(python, [script, playlistUrl], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code !== 0) {
        try {
          const err = JSON.parse(stderr);
          return reject(new Error(err.error || stderr));
        } catch {
          return reject(new Error(stderr || `Python exited with code ${code}`));
        }
      }
      try {
        const tracks = JSON.parse(stdout);
        if (!Array.isArray(tracks)) return reject(new Error('Unexpected scraper response'));
        resolve(tracks);
      } catch (e) {
        reject(new Error('Failed to parse scraper output: ' + e.message));
      }
    });
  });
}

function lastErrorLine(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('ERROR:'));
  return (err || lines[lines.length - 1] || 'Unknown error').replace(/^ERROR:\s*/, '');
}

/** Turn a yt-dlp failure into something a person can act on. */
function explain(stderr) {
  const s = String(stderr || '');
  const base = lastErrorLine(s).slice(0, 240);
  if (/Sign in to confirm|not a bot/i.test(s)) {
    return `${base} — YouTube is asking for verification. Wait a while and try again.`;
  }
  if (/JavaScript runtime|HTTP Error 403|Only images are available|Requested format is not available|nsig|signature/i.test(s)) {
    return `${base} — YouTube may have changed. Try Downloader → Update yt-dlp.`;
  }
  return base;
}

/**
 * Turn a failed link-read (before any song is downloaded) into a toast the
 * person can act on: { title, message }. Covers private/missing playlists,
 * private/removed videos, links that aren't music links at all, etc.
 */
function explainLink(stderr) {
  const s = String(stderr || '');
  if (/private playlist|playlist is private|playlist does not exist|playlist.*(not (available|viewable)|unavailable)|The playlist .* (does not exist|is private)/i.test(s)) {
    return { title: 'Playlist unavailable', message: "This playlist is private or doesn't exist. Sign in with Google (Settings → Google account) to import your own private playlists, or make it public or unlisted, then try again." };
  }
  if (/Private video|video is private/i.test(s)) {
    return { title: 'Private video', message: "This video is private, so it can't be downloaded." };
  }
  if (/members-only|Join this channel|members only/i.test(s)) {
    return { title: 'Members-only video', message: 'This video is only for channel members.' };
  }
  if (/confirm your age|age-restricted|inappropriate for some users/i.test(s)) {
    return { title: 'Age-restricted video', message: 'YouTube needs a signed-in account to play this video.' };
  }
  if (/not available in your country|blocked .* in your country|geo.?restrict/i.test(s)) {
    return { title: 'Not available here', message: "This video isn't available in your country." };
  }
  if (/Video unavailable|has been removed|no longer available|account .* terminated|been terminated|This video is not available/i.test(s)) {
    return { title: 'Video unavailable', message: 'This video was removed or is no longer available.' };
  }
  if (/Unsupported URL|is not a valid URL|Unable to extract|No video formats found|no video could be found|HTTP Error 404/i.test(s)) {
    return { title: "Can't use this link", message: "This doesn't look like a YouTube or Spotify song or playlist link." };
  }
  if (/getaddrinfo|Temporary failure|Network is unreachable|timed out|Connection (refused|reset|aborted)|Unable to download (webpage|API)|Failed to resolve/i.test(s)) {
    return { title: "Can't reach the link", message: 'Check your internet connection and try again.' };
  }
  return { title: 'Download failed', message: explain(s) };
}

function createDownloader({ binaries, downloadsDir, publish, log = () => {}, pacing = PACING, google = null }) {
  const queue = [];
  let running = false;
  let generation = 0; // bumped by cancel() so in-flight jobs stop

  // ------------------------------------------------------------- progress --
  // A single running snapshot, re-broadcast (with queueLength always fresh)
  // whenever any field of it changes. The deck in index.html renders this
  // directly - see the `progress` branch of the SSE handler there.
  let state = { state: 'idle' };

  function publishProgress(patch) {
    state = { ...state, ...patch, queueLength: queue.length };
    publish({ progress: state });
  }

  // ---------------------------------------------------------------- yt-dlp --
  async function getInfo(url) {
    const r = await binaries.run([
      ...binaries.commonArgs(),
      '--flat-playlist', '-J', '--no-warnings',
      '--', url,
    ]);
    const text = r.stdout.trim();
    if (!text) return { error: explain(r.stderr), stderr: r.stderr };
    try {
      return { info: JSON.parse(text) };
    } catch (_) {
      return { error: explain(r.stderr) || 'Could not read the link.', stderr: r.stderr };
    }
  }

  /** Download one video as mp3. Resolves { ok, filename } or { ok:false, error }. */
  async function downloadOne(url) {
    const printFile = path.join(
      os.tmpdir(),
      `mp-path-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );
    // Snapshot the folder so the fallback below can only ever pick up files
    // that THIS call created (never a previous song).
    const before = new Map();
    try {
      for (const f of fs.readdirSync(downloadsDir)) {
        before.set(f, fs.statSync(path.join(downloadsDir, f)).mtimeMs);
      }
    } catch (_) { /* folder unreadable: fallback finds nothing */ }

    const r = await binaries.run([
      ...binaries.commonArgs(),
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
      // The video id is baked into the filename so two different videos that
      // happen to share a title (a cover uploaded under the original's exact
      // name is common) can never collide on the same destination path -
      // yt-dlp does not overwrite an existing file by default, so a same-name
      // collision used to make the second of the two silently vanish.
      '-o', path.join(downloadsDir, '%(title).150s [%(id)s].%(ext)s'),
      '--windows-filenames', '--no-mtime',
      '--force-overwrites', // a retried attempt (fallback URL) should replace a partial file, not get skipped by it
      '--retries', '5', '--extractor-retries', '3', '--fragment-retries', '3',
      '--skip-unavailable-fragments',
      '--concurrent-fragments', '3',
      '--http-chunk-size', '10M',
      // Ask yt-dlp for the FINAL path (after conversion to .mp3). Written to a
      // file so Windows console encodings can't mangle non-English titles.
      '--print-to-file', 'after_move:filepath', printFile,
      '--', url,
    ]);

    let file = null;
    try {
      const lines = fs.readFileSync(printFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      file = lines[lines.length - 1] || null;
    } catch (_) { /* no file written */ }
    fs.rm(printFile, { force: true }, () => {});

    if (file && !/\.mp3$/i.test(file)) {
      const alt = file.replace(/\.[^.\\/]+$/, '.mp3');
      file = fs.existsSync(alt) ? alt : null; // never hand a non-mp3 to the player
    }

    // Fallback (only if yt-dlp reported success but the path file is missing):
    // a .mp3 that is new or modified since this call started.
    if ((!file || !fs.existsSync(file)) && r.code === 0) {
      try {
        const fresh = fs.readdirSync(downloadsDir)
          .filter((f) => /\.mp3$/i.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(downloadsDir, f)).mtimeMs }))
          .filter((x) => !before.has(x.f) || before.get(x.f) !== x.t)
          .sort((a, b) => b.t - a.t);
        file = fresh.length ? path.join(downloadsDir, fresh[0].f) : null;
      } catch (_) { file = null; }
    }

    if (file && fs.existsSync(file) && fs.statSync(file).size > 0) {
      return { ok: true, filename: path.basename(file) };
    }
    return { ok: false, error: explain(r.stderr) };
  }
  /**
   * Search YouTube and return the video with the highest view count.
   */
  async function findBestYoutubeMatch(searchQuery, maxResults = 8) {
    const searchUrl = `ytsearch${maxResults}:${searchQuery}`;

    const { info, error } = await getInfo(searchUrl);
    if (!info || !Array.isArray(info.entries) || info.entries.length === 0) {
      return { ok: false, error: error || 'No YouTube results' };
    }

    const candidates = info.entries.filter((e) => e && e.id);
    if (candidates.length === 0) {
      return { ok: false, error: 'No usable YouTube results' };
    }

    // Highest view count first
    candidates.sort((a, b) => {
      const va = typeof a.view_count === 'number' ? a.view_count : -1;
      const vb = typeof b.view_count === 'number' ? b.view_count : -1;
      return vb - va;
    });

    const best = candidates[0];
    return {
      ok: true,
      id: best.id,
      url: `https://www.youtube.com/watch?v=${best.id}`,
      musicUrl: `https://music.youtube.com/watch?v=${best.id}`,
      title: best.title || '',
      view_count: best.view_count ?? null,
    };
  }

  // ------------------------------------------------------------------ jobs --
  async function processJob({ url, gen, known = {} }) {
    const cancelled = () => gen !== generation;
    // Returns the existing songId for a YouTube video id, if the renderer
    // already told us about one when this job was enqueued.
    const findExisting = (id) => (id && Object.prototype.hasOwnProperty.call(known, id)) ? known[id] : null;
    // Sleep in small slices so Cancel takes effect immediately.
    // progressPatch (optional) is published once, up front, as a 'resting' state.
    const nap = async (ms, progressPatch) => {
      if (progressPatch) publishProgress({ ...progressPatch, state: 'resting', restMs: ms });
      const end = Date.now() + ms;
      while (Date.now() < end && !cancelled()) await sleep(Math.min(250, end - Date.now()));
    };

    const missing = binaries.missing();
    if (missing.length) {
      publish({
        title: 'Downloader not set up',
        message: `Missing: ${missing.join(', ')}. Run "npm run fetch-binaries" and rebuild.`,
      });
      return;
    }

    try { new URL(url); } catch (_) {
      publish({ title: "Can't use this link", message: "That doesn't look like a valid link." });
      return;
    }

    // ---------- Spotify (playlist or single track) ----------
    if (isSpotifyUrl(url)) {
      const isPlaylist = isSpotifyPlaylist(url);

      publishProgress({
        state: 'resolving',
        url,
        jobTitle: null,
        isPlaylist,
        current: null,
        total: null,
        currentSong: isPlaylist ? 'Fetching full playlist…' : 'Fetching track…',
        restMs: null,
      });

      let tracks;
      try {
        tracks = await scrapeSpotifyWithPython(url);
      } catch (err) {
        publish({
          title: 'Spotify scrape failed',
          message: String(err.message || err),
        });
        return;
      }

      if (cancelled()) return;

      if (!tracks.length) {
        publish({
          title: isPlaylist ? 'Empty playlist' : 'Track not found',
          message: isPlaylist
            ? 'No tracks found (is the playlist public?).'
            : 'Could not read this Spotify track.',
        });
        return;
      }

      const title = isPlaylist
        ? `Spotify playlist (${tracks.length} tracks)`
        : (tracks[0].artists
            ? `${tracks[0].artists} – ${tracks[0].title}`
            : tracks[0].title);

      let added = 0;
      let linked = 0;
      let skipped = 0;
      const seen = new Set();
      const seenIds = new Set(); // video ids already handled within this job
      let lastError = '';

      for (let i = 0; i < tracks.length; i++) {
        if (cancelled()) return;

        const { title: songTitle, artists: artistsRaw } = tracks[i];
        const artists = formatArtist(artistsRaw);
        const searchQuery = artists ? `${artists} - ${songTitle}` : songTitle;
        const displayTitle = artists ? `${artists} – ${songTitle}` : songTitle;

        const base = {
          jobTitle: title,
          isPlaylist,
          current: added + linked,
          total: tracks.length,
        };

        publishProgress({
          ...base,
          state: 'downloading',
          currentSong: displayTitle,
          restMs: null,
        });

        // ---- smart search (highest views) ----
        let match = await findBestYoutubeMatch(searchQuery, 8);
        const triedUrl = (match && match.ok && (match.url || match.musicUrl)) || url;

        if (cancelled()) {
          // report the in-flight Spotify track so cancel still produces the txt
          publish({
            title: songTitle,
            artist: artists,
            url: triedUrl,
            message: 'Download stopped before finishing.',
          });
          return;
        }

        // ---- already have this exact song? don't re-download it ----
        if (match.ok && match.id) {
          if (seenIds.has(match.id)) continue; // duplicate within this same job
          const existingSongId = findExisting(match.id);
          if (existingSongId) {
            seenIds.add(match.id);
            linked++;
            publish({ linked: true, songId: existingSongId, sourceId: match.id, title: displayTitle });
            continue;
          }
          seenIds.add(match.id);
        }

        let res = null;

        if (match.ok) {
          const attempts = [match.musicUrl, match.url];
          for (const attemptUrl of attempts) {
            log(
              'Trying best match:',
              attemptUrl,
              match.view_count != null ? `(${match.view_count} views)` : ''
            );
            res = await downloadOne(attemptUrl);
            if (cancelled()) {
              if (!res || !res.ok) {
                publish({
                  title: songTitle,
                  artist: artists,
                  url: attemptUrl,
                  message: 'Download stopped before finishing.',
                });
              }
              return;
            }
            if (res.ok) break;

            await nap(rand(pacing.retryMs || [3000, 7000]), {
              ...base,
              currentSong: songTitle,
            });
            if (cancelled()) {
              if (!res || !res.ok) {
                publish({
                  title: songTitle,
                  artist: artists,
                  url: attemptUrl,
                  message: 'Download stopped before finishing.',
                });
              }
              return;
            }
          }
        }

        // last-ditch fallback
        if (!res || !res.ok) {
          const fallback = `ytsearch1:${searchQuery} provided to youtube`;
          log('Falling back to simple search:', fallback);
          res = await downloadOne(fallback);
          if (cancelled()) {
            if (!res || !res.ok) {
              publish({
                title: songTitle,
                artist: artists,
                url: triedUrl,
                message: 'Download stopped before finishing.',
              });
            }
            return;
          }
        }

        if (res && res.ok) {
          if (!seen.has(res.filename)) {
            seen.add(res.filename);
            added++;
            publish({ filename: res.filename, sourceId: match.ok ? match.id : null, title: displayTitle });
          }
        } else {
          skipped++;
          lastError = (res && res.error) || (match && match.error) || lastError;
          log('Completely skipped Spotify track:', searchQuery, lastError);
          // Same per-song event as YouTube so the UI can write failed-downloads.txt
          publish({
            title: songTitle,
            artist: artists,
            url: triedUrl,
            message: lastError || 'Could not be downloaded.',
          });
        }

        // Only pause between songs when there is more than one
        if (i < tracks.length - 1) {
          const afterBase = {
            jobTitle: title,
            isPlaylist,
            current: added + linked,
            total: tracks.length,
          };
          await nap(rand(pacing.betweenSongsMs), { ...afterBase, currentSong: null });
          if (added > 0 && added % pacing.restEvery === 0) {
            const rest = rand(pacing.restMs);
            log('Cooldown:', rest, 'ms');
            await nap(rest, { ...afterBase, currentSong: null });
          }
        }
      }

      if (cancelled()) return;

      if (added === 0 && linked === 0) {
        publish({
          title: `"${title}" failed`,
          message: lastError || 'No songs could be downloaded.',
        });
      } else {
        publish({
          title: `"${title}" finished`,
          message: isPlaylist
            ? `${added} added${linked ? `, ${linked} already in your library` : ''}${skipped ? `, ${skipped} skipped` : ''}.`
            : (added ? 'Song added.' : 'Song was already in your library.'),
        });
      }
      return;
    }

    // ---------- Already-known single video, checked BEFORE asking yt-dlp ----------
    // The check further down needs info.id from getInfo(), which fails for a
    // dead/unavailable link - exactly the kind of link that was replaced by a
    // working alternate (its id is saved as an alias on that song). So a plain
    // single-video link whose id is already known is answered right here,
    // without touching the network. Links that carry a playlist (`list=`) are
    // skipped: those mean "the whole playlist", not just this one video.
    try {
      const u = new URL(url);
      const quickId = u.searchParams.has('list') ? null : extractYoutubeId(url);
      const quickExisting = findExisting(quickId);
      if (quickExisting) {
        publish({ linked: true, songId: quickExisting, sourceId: quickId, title: quickId });
        return;
      }
    } catch (_) { /* not a parseable URL - fall through to the normal path */ }

    publishProgress({ state: 'resolving', url, jobTitle: null, isPlaylist: null, current: null, total: null, currentSong: null, restMs: null });

    let { info, error, stderr } = await getInfo(url);
    if (cancelled()) return;

    // A private playlist can't be read by yt-dlp without a login. If the user signed in with
    // Google, list it through the YouTube Data API instead; the playlist loop below (public
    // per-video downloads through yt-dlp) is unchanged. Public playlists never touch the API.
    if (!info && google && google.isSignedIn()) {
      const listId = extractPlaylistId(url);
      if (listId && looksLikePrivatePlaylist(stderr || error)) {
        try {
          info = await google.getPlaylist(listId);
        } catch (err) {
          publish({ title: 'Could not read playlist', message: err.message });
          return;
        }
        if (cancelled()) return;
      }
    }

    if (!info) {
      // No `url` on purpose: this is a link-level failure, so the page shows
      // it as a toast rather than adding an "Unknown link" placeholder song.
      const why = explainLink(stderr || error);
      publish({ title: why.title, message: why.message });
      return;
    }

    // ---- single video ------------------------------------------------------
    if (info._type !== 'playlist') {
      const meta = youtubeTrackMeta(info);
      const title = meta.title || info.title || url;
      const artist = meta.artist || '';
      const vidId = info.id || extractYoutubeId(url);

      // Already have this exact video? Tell the renderer to link it into the
      // current playlist instead of downloading (and storing) it again.
      const existingSongId = findExisting(vidId);
      if (existingSongId) {
        publish({ linked: true, songId: existingSongId, sourceId: vidId, title });
        return;
      }

      publishProgress({
        state: 'downloading', jobTitle: title, isPlaylist: false,
        current: 0, total: 1, currentSong: title, restMs: null,
      });
      const res = await downloadOne(url);
      if (cancelled()) {
        // it was killed mid-download - report it as stopped so it isn't
        // silently missing from the failed-downloads report
        if (!res || !res.ok) {
          publish({ title, artist, url, message: 'Download stopped before finishing.' });
        }
        return;
      }
      if (res.ok) {
        publish({ filename: res.filename, sourceId: vidId, title });
      } else {
        publish({ title, artist, url, message: res.error });
      }
      return;
    }

    // ---- playlist ----------------------------------------------------------
    const title = info.title || info.playlist_title || 'YouTube Playlist';
    const entries = (info.entries || []).filter((e) => e && (e.id || (e.url && extractYoutubeId(e.url))));
    if (!entries.length) {
      publish({
        title: 'No songs found',
        message: 'Nothing to download at this link. The playlist may be private or empty, or it may not be a music link.',
      });
      return;
    }
    let added = 0;
    let linked = 0;
    let skipped = 0;
    const seen = new Set();
    const seenIds = new Set(); // video ids already handled within this job

    let lastError = '';

    for (let i = 0; i < entries.length; i++) {
      if (cancelled()) return;
      const id = entries[i].id || extractYoutubeId(entries[i].url);
      const entryMeta = youtubeTrackMeta(entries[i]);
      const songTitle = entryMeta.title || entries[i].title || id;
      const songArtist = entryMeta.artist || '';
      const base = { jobTitle: title, isPlaylist: true, current: added + linked, total: entries.length };

      // Already have this exact song (in this run or from before)? Link it
      // into the current playlist instead of downloading it again.
      if (seenIds.has(id)) continue;
      const existingSongId = findExisting(id);
      if (existingSongId) {
        seenIds.add(id);
        linked++;
        publish({ linked: true, songId: existingSongId, sourceId: id, title: songTitle });
        continue;
      }
      seenIds.add(id);

      publishProgress({ ...base, state: 'downloading', currentSong: songTitle, restMs: null });

      const attempts = [
        `https://music.youtube.com/watch?v=${id}`,
        `https://www.youtube.com/watch?v=${id}`,
      ];

      let res = null;
      for (const attemptUrl of attempts) {
        log('Trying:', attemptUrl);
        res = await downloadOne(attemptUrl);
        if (cancelled()) {
          // this song was killed mid-download - record it now, since we're
          // about to bail out of processJob entirely and never reach the
          // "else" branch below that normally logs a failure
          if (!res || !res.ok) {
            publish({
              title: songTitle,
              artist: songArtist,
              url: attemptUrl,
              message: 'Download stopped before finishing.',
            });
          }
          return;
        }
        if (res.ok) break;
        log('Attempt failed:', attemptUrl, res.error);
        await nap(rand(pacing.retryMs || [3000, 7000]), { ...base, currentSong: songTitle });
        if (cancelled()) {
          if (!res || !res.ok) {
            publish({
              title: songTitle,
              artist: songArtist,
              url: attemptUrl,
              message: 'Download stopped before finishing.',
            });
          }
          return;
        }
      }

      if (res && res.ok) {
        if (!seen.has(res.filename)) {
          seen.add(res.filename);
          added++;
          publish({ filename: res.filename, sourceId: id, title: songTitle });
        }
      } else {
        skipped++;
        lastError = (res && res.error) || lastError;
        log('Completely skipped:', id);
        publish({
          title: songTitle,
          artist: songArtist,
          url: attempts[attempts.length - 1],
          message: (res && res.error) || 'Could not be downloaded.',
        });
      }

      if (i < entries.length - 1) {
        const afterBase = { jobTitle: title, isPlaylist: true, current: added + linked, total: entries.length };
        await nap(rand(pacing.betweenSongsMs), { ...afterBase, currentSong: null });
        if (added > 0 && added % pacing.restEvery === 0) {
          const rest = rand(pacing.restMs);
          log('Cooldown:', rest, 'ms');
          await nap(rest, { ...afterBase, currentSong: null });
        }
      }
    }

    if (cancelled()) return;
    if (added === 0 && linked === 0) {
      publish({ title: `"${title}" failed`, message: lastError || 'No songs could be downloaded.' });
    } else {
      publish({
        title: `"${title}" finished`,
        message: `${added} added${linked ? `, ${linked} already in your library` : ''}${skipped ? `, ${skipped} skipped` : ''}.`,
      });
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          await processJob(job);
        } catch (err) {
          log('Job crashed:', err);
          publish({ title: 'Download failed', message: String((err && err.message) || err) });
        }
      }
    } finally {
      running = false;
      publishProgress({ state: 'idle', jobTitle: null, isPlaylist: null, current: null, total: null, currentSong: null, restMs: null });
    }
  }

  return {
    // `known` maps a YouTube video id already present in the user's library
    // to the songId that holds it (built by the renderer from IndexedDB).
    // It lets a job skip re-downloading (and re-storing) a song that's
    // already been pulled down before, whichever playlist it lives in.
    enqueue(url, known) {
      queue.push({ url, gen: generation, known: (known && typeof known === 'object') ? known : {} });
      // Re-broadcast the current snapshot so an already-open deck picks up
      // the new queue length immediately, without waiting on the job itself.
      publishProgress({});
      pump();
    },
    cancel() {
      generation++;
      queue.length = 0;
      binaries.killAll();
      publishProgress({ state: 'idle', jobTitle: null, isPlaylist: null, current: null, total: null, currentSong: null, restMs: null });
    },
    isBusy: () => running || queue.length > 0,
  };
}

module.exports = { createDownloader, explain, explainLink };
