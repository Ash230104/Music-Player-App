'use strict';
/**
 * Durable library mirror.
 *
 * Layout (all under <userData>/library/):
 *   audio/<id>.mp3          <- permanent copy of each song's audio
 *   covers/<id>.jpg         <- permanent cover thumbnail
 *   meta/library.json       <- full snapshot (songs, playlists, entries, tags, stats, schemaVersion)
 *   meta/songs/<id>.json    <- per-song sidecar (rebuild fallback)
 *   meta/backups/library-<ISO>.json  <- up to MAX_BACKUPS rotating copies
 *
 * Atomic writes: write to .tmp, fsync the fd, rename into place.
 * Rotating backups: before an overwrite, copy the current file to backups/
 *   with a timestamp suffix, but at most once per BACKUP_MIN_INTERVAL_MS;
 *   prune oldest when count > MAX_BACKUPS.
 *
 * Redundant work is skipped: an unchanged snapshot is not rewritten, unchanged
 * song sidecars are not rewritten, identical covers are not rewritten.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 24;
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000; // at most one backup per hour

const sha1 = (str) => crypto.createHash('sha1').update(str).digest('hex');

function createLibraryStore({ libraryDir, log = () => {} }) {
  const audioDir   = path.join(libraryDir, 'audio');
  const coversDir  = path.join(libraryDir, 'covers');
  const metaDir    = path.join(libraryDir, 'meta');
  const songsDir   = path.join(metaDir, 'songs');
  const backupsDir = path.join(metaDir, 'backups');
  const mainFile   = path.join(metaDir, 'library.json');

  // What we last wrote, so unchanged data can be skipped. Loaded lazily from
  // disk on the first save after launch.
  let stateLoaded = false;
  let lastContentHash = null;      // hash of the snapshot content (no savedAt/revision)
  let lastSongJson = new Map();    // String(song.id) -> JSON text of last written sidecar

  // Create all dirs on first use
  function ensureDirs() {
    for (const d of [audioDir, coversDir, metaDir, songsDir, backupsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  /**
   * Atomically write `content` (Buffer or string) to `destPath`.
   * Writes to .tmp, flushes, renames. Pass durable=false to skip the fsync
   * (fine for data that can be rebuilt: covers, per-song sidecars).
   */
  function atomicWrite(destPath, content, durable = true) {
    const tmp = destPath + '.tmp';
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    // Write + explicit fsync so the OS flushes to disk before rename
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, buf);
      if (durable) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destPath);
  }

  /** Rotate backups: copy current main file into backups/ (at most once per
   *  BACKUP_MIN_INTERVAL_MS), prune old ones. */
  function rotateBackup() {
    if (!fs.existsSync(mainFile)) return;
    fs.mkdirSync(backupsDir, { recursive: true });
    try {
      const newest = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('library-') && f.endsWith('.json'))
        .sort()
        .pop();
      if (newest) {
        const age = Date.now() - fs.statSync(path.join(backupsDir, newest)).mtimeMs;
        if (age < BACKUP_MIN_INTERVAL_MS) return;
      }
    } catch (_) { /* fall through and just take a backup */ }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupsDir, `library-${ts}.json`);
    try {
      fs.copyFileSync(mainFile, dest);
    } catch (err) {
      log('Backup copy failed:', err.message);
      return;
    }
    // Prune oldest
    try {
      const files = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('library-') && f.endsWith('.json'))
        .sort(); // ISO timestamps sort lexically
      while (files.length > MAX_BACKUPS) {
        const oldest = files.shift();
        fs.rmSync(path.join(backupsDir, oldest), { force: true });
      }
    } catch (err) {
      log('Backup prune failed:', err.message);
    }
  }

  /** Load previous snapshot once, to seed the "what did we last write" state. */
  function loadPreviousState() {
    if (stateLoaded) return;
    stateLoaded = true;
    const prev = loadSnapshot();
    if (!prev) return;
    try {
      const { savedAt, revision, ...rest } = prev;
      lastContentHash = sha1(JSON.stringify(rest));
      for (const song of prev.songs || []) {
        if (song && song.id != null) lastSongJson.set(String(song.id), JSON.stringify(song));
      }
    } catch (_) { /* worst case: one redundant rewrite */ }
  }

  /**
   * Save the full library snapshot.
   * `snapshot` is the parsed object from the renderer (already validated).
   * Returns { changed: boolean }. Nothing touches the disk if content is identical
   * to what was last written.
   */
  function saveSnapshot(snapshot) {
    ensureDirs();
    loadPreviousState();

    // Content only; key order is fixed so the hash is stable.
    const body = {
      schemaVersion: SCHEMA_VERSION,
      songs: snapshot.songs || [],
      playlists: snapshot.playlists || [],
      playlistInstruments: snapshot.playlistInstruments || {},
      globalCustomTags: snapshot.globalCustomTags || [],
      computedPlaylists: snapshot.computedPlaylists || {},
      playlistEntries: snapshot.playlistEntries || [],
      failedRows: snapshot.failedRows || [],
      playStats: snapshot.playStats || [],
    };
    const hash = sha1(JSON.stringify(body));
    if (hash === lastContentHash && fs.existsSync(mainFile)) return { changed: false };

    rotateBackup();
    const { schemaVersion, ...rest } = body;
    const data = {
      schemaVersion,
      savedAt: new Date().toISOString(),
      revision: snapshot.revision || 0,
      ...rest,
    };
    atomicWrite(mainFile, JSON.stringify(data));
    lastContentHash = hash;

    // Per-song sidecars (rebuild fallback): only rewrite the ones that changed.
    const nextSongJson = new Map();
    for (const song of data.songs) {
      if (!song || song.id == null) continue;
      const key = String(song.id);
      const json = JSON.stringify(song);
      const sidecar = path.join(songsDir, `${key}.json`);
      if (lastSongJson.get(key) === json && fs.existsSync(sidecar)) {
        nextSongJson.set(key, json);
        continue;
      }
      try {
        atomicWrite(sidecar, json, false);
        nextSongJson.set(key, json);
      } catch (err) {
        log(`Sidecar write failed for song ${song.id}:`, err.message);
      }
    }
    lastSongJson = nextSongJson;
    return { changed: true };
  }

  /**
   * Save an audio blob (Buffer) as library/audio/<id>.mp3.
   * Only writes if the file doesn't already exist (never overwrites).
   * Returns the destination path. Throws if the write fails, so the caller
   * can report the failure instead of claiming success.
   */
  function saveAudio(songId, buf) {
    ensureDirs();
    const dest = path.join(audioDir, `${songId}.mp3`);
    if (!fs.existsSync(dest)) {
      try {
        atomicWrite(dest, buf);
        log(`Saved audio for song ${songId}`);
      } catch (err) {
        log(`Audio save failed for song ${songId}:`, err.message);
        throw err;
      }
    }
    return dest;
  }

  /**
   * Save a cover image (Buffer, JPEG) as library/covers/<id>.jpg.
   * Replaces an existing cover only if the bytes differ.
   */
  function saveCover(songId, buf) {
    ensureDirs();
    const dest = path.join(coversDir, `${songId}.jpg`);
    try {
      try {
        if (fs.statSync(dest).size === buf.length && fs.readFileSync(dest).equals(buf)) return dest;
      } catch (_) { /* no existing file */ }
      atomicWrite(dest, buf, false);
    } catch (err) {
      log(`Cover save failed for song ${songId}:`, err.message);
      throw err;
    }
    return dest;
  }

  /** Ids of every song audio / cover already on disk (for client-side backfill). */
  function listIds() {
    const ids = (dir, ext) => {
      try {
        return fs.readdirSync(dir).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length));
      } catch (_) { return []; }
    };
    return { audio: ids(audioDir, '.mp3'), covers: ids(coversDir, '.jpg') };
  }

  /**
   * Read the current library.json and return a parsed object, or null.
   */
  function loadSnapshot() {
    try {
      const raw = fs.readFileSync(mainFile, 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /**
   * Does a library.json exist (used by the renderer at startup to decide
   * whether a restore is available)?
   */
  function hasSnapshot() {
    return fs.existsSync(mainFile);
  }

  /** Return path to a song's permanent audio file, or null if it doesn't exist yet. */
  function audioPath(songId) {
    const p = path.join(audioDir, `${songId}.mp3`);
    return fs.existsSync(p) ? p : null;
  }

  /** Return path to a song's permanent cover file, or null if it doesn't exist yet. */
  function coverPath(songId) {
    const p = path.join(coversDir, `${songId}.jpg`);
    return fs.existsSync(p) ? p : null;
  }

  return { saveSnapshot, saveAudio, saveCover, loadSnapshot, hasSnapshot, audioPath, coverPath, listIds };
}

module.exports = { createLibraryStore };
