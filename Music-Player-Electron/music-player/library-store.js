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
 * Rotating backups: before each overwrite, copy current file to backups/
 *   with a timestamp suffix; prune oldest when count > MAX_BACKUPS.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 10;

function createLibraryStore({ libraryDir, log = () => {} }) {
  const audioDir   = path.join(libraryDir, 'audio');
  const coversDir  = path.join(libraryDir, 'covers');
  const metaDir    = path.join(libraryDir, 'meta');
  const songsDir   = path.join(metaDir, 'songs');
  const backupsDir = path.join(metaDir, 'backups');
  const mainFile   = path.join(metaDir, 'library.json');

  // Create all dirs on first use
  function ensureDirs() {
    for (const d of [audioDir, coversDir, metaDir, songsDir, backupsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  /**
   * Atomically write `content` (Buffer or string) to `destPath`.
   * Writes to .tmp, flushes, renames.
   */
  function atomicWrite(destPath, content) {
    const tmp = destPath + '.tmp';
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    // Write + explicit fsync so the OS flushes to disk before rename
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destPath);
  }

  /** Rotate backups: copy current main file into backups/, prune old ones. */
  function rotateBackup() {
    if (!fs.existsSync(mainFile)) return;
    fs.mkdirSync(backupsDir, { recursive: true });
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

  /**
   * Save the full library snapshot.
   * `snapshot` is the parsed object from the renderer (already validated).
   */
  function saveSnapshot(snapshot) {
    ensureDirs();
    rotateBackup();
    const data = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      revision: snapshot.revision || 0,
      songs: snapshot.songs || [],
      playlists: snapshot.playlists || [],
      playlistInstruments: snapshot.playlistInstruments || {},
      globalCustomTags: snapshot.globalCustomTags || [],
      computedPlaylists: snapshot.computedPlaylists || {},
      playlistEntries: snapshot.playlistEntries || [],
      failedRows: snapshot.failedRows || [],
      playStats: snapshot.playStats || [],
    };
    atomicWrite(mainFile, JSON.stringify(data));

    // Per-song sidecars (non-blob fields only, as fallback rebuild)
    for (const song of data.songs) {
      if (!song || song.id == null) continue;
      try {
        const sidecar = path.join(songsDir, `${song.id}.json`);
        atomicWrite(sidecar, JSON.stringify(song));
      } catch (err) {
        log(`Sidecar write failed for song ${song.id}:`, err.message);
      }
    }
  }

  /**
   * Save an audio blob (Buffer) as library/audio/<id>.mp3.
   * Only writes if the file doesn't already exist (never overwrites).
   * Returns the destination path.
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
      }
    }
    return dest;
  }

  /**
   * Save a cover image (Buffer, JPEG) as library/covers/<id>.jpg.
   * Overwrites if already present (cover may be updated).
   */
  function saveCover(songId, buf) {
    ensureDirs();
    const dest = path.join(coversDir, `${songId}.jpg`);
    try {
      atomicWrite(dest, buf);
    } catch (err) {
      log(`Cover save failed for song ${songId}:`, err.message);
    }
    return dest;
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

  return { saveSnapshot, saveAudio, saveCover, loadSnapshot, hasSnapshot, audioPath, coverPath };
}

module.exports = { createLibraryStore };
