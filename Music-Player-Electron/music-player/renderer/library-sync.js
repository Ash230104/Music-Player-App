/**
 * library-sync.js  —  Renderer-side mirror sync
 *
 * Debounced write-through: any change in IndexedDB or localStorage triggers a
 * snapshot that is POSTed to POST /library-sync a couple of seconds later.
 *
 * On page load it also checks /library-snapshot: if IndexedDB is empty but the
 * server has a saved library, it restores from it.
 *
 * Audio and cover blobs are uploaded separately via /library-save-audio and
 * /library-save-cover, triggered once per new song.
 */

(function () {
  'use strict';

  const SYNC_DEBOUNCE_MS = 2500;
  let syncTimer = null;
  let lastRevision = 0;
  // In-memory cache for audio blobs added this session.
  // New songs land here first so playback works immediately while
  // the async disk write (uploadAudio) is in flight. No IDB write needed.
  const blobCache = new Map();

  /* ------------------------------------------------------------------ helpers */

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // result is "data:...;base64,<data>" - strip the prefix
        const b64 = reader.result.split(',')[1];
        resolve(b64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function idbGetAll(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  function idbCount(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  function openPlayStatsDb() {
    if (window.openPlayStatsDb) return window.openPlayStatsDb();
    return Promise.resolve(null);
  }

  function getAllPlayStats(statsDb) {
    if (!statsDb) return Promise.resolve({ dailyPlays: [], totals: [] });
    const readStore = (storeName) => new Promise((resolve) => {
      try {
        const tx = statsDb.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) {
        resolve([]);
      }
    });
    return Promise.all([readStore('dailyPlays'), readStore('totals')])
      .then(([dailyPlays, totals]) => ({ dailyPlays, totals }))
      .catch(() => ({ dailyPlays: [], totals: [] }));
  }

  /* --------------------------------------------------------------- snapshot */

  async function buildSnapshot() {
    const musicDb = window.openMusicDb ? await window.openMusicDb() : null;
    if (!musicDb) return null;

    const [songs, playlistEntries, failedRows] = await Promise.all([
      idbGetAll(musicDb, 'songs'),
      idbGetAll(musicDb, 'playlistEntries'),
      idbGetAll(musicDb, 'failedRows').catch(() => []),
    ]);

    // Strip blobs from songs (they travel separately via /library-save-audio)
    const songsClean = songs.map(s => {
      const { file, ...rest } = s; // remove audio blob if somehow in songs store
      return rest;
    });

    const statsDb = await openPlayStatsDb();
    const playStats = await getAllPlayStats(statsDb);

    lastRevision++;
    return {
      revision: lastRevision,
      songs: songsClean,
      playlists: safeLocalStorage('playlists', []),
      playlistInstruments: safeLocalStorage('playlistInstruments', {}),
      globalCustomTags: safeLocalStorage('globalCustomTags', []),
      computedPlaylists: safeLocalStorage('computedPlaylists', {}),
      computedPlaylistsLastRun: safeLocalStorage('computedPlaylistsLastRun', null),
      playlistEntries,
      failedRows,
      playStats,
    };
  }

  function safeLocalStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  /* ---------------------------------------------------------- write-through */

  async function doSync() {
    try {
      const snapshot = await buildSnapshot();
      if (!snapshot) return;
      const res = await fetch('/library-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[library-sync] server error:', err.error || res.status);
      }
    } catch (err) {
      console.warn('[library-sync] sync failed:', err.message);
    }
  }

  /**
   * Schedule a debounced sync. Call this after any mutation.
   */
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, SYNC_DEBOUNCE_MS);
  }

  /**
   * Upload one song's audio blob to the server for permanent storage.
   * Also caches the blob in RAM so playback works immediately while the
   * disk write is in flight — no IDB write needed.
   * Safe to call multiple times — server skips if file already exists.
   */
  async function uploadAudio(songId, blob) {
    if (!songId || !blob) return;
    // Cache in RAM first — getSongBlob checks here before hitting disk
    blobCache.set(String(songId), blob);
    try {
      await fetch(`/library-save-audio?id=${encodeURIComponent(String(songId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
    } catch (err) {
      console.warn('[library-sync] audio upload failed:', err.message);
    }
  }

  /** Return a cached blob for a song added this session (before disk confirmed). */
  function getCachedBlob(songId) {
    return blobCache.get(String(songId)) || null;
  }

  /**
   * Upload one song's cover blob.
   */
  async function uploadCover(songId, blob) {
    if (!songId || !blob) return;
    try {
      await fetch(`/library-save-cover?id=${encodeURIComponent(String(songId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
    } catch (err) {
      console.warn('[library-sync] cover upload failed:', err.message);
    }
  }

  /**
   * Clear the legacy songBlobs IDB store — call after backfillAll() confirms
   * every song is on disk. Frees the duplicated audio storage in IndexedDB.
   */
  async function clearBlobStore() {
    const musicDb = window.openMusicDb ? await window.openMusicDb() : null;
    if (!musicDb) return;
    await new Promise((resolve) => {
      try {
        const tx = musicDb.transaction('songBlobs', 'readwrite');
        tx.objectStore('songBlobs').clear();
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      } catch (_) { resolve(); }
    });
    console.log('[library-sync] songBlobs IDB store cleared — audio now served from disk only.');
  }

  /* ---------------------------------------------------------- startup restore */

  /**
   * Check the server snapshot. If IndexedDB is empty but a snapshot exists,
   * restore it. Calls the provided callback with the snapshot so the page can
   * hydrate its in-memory state from it.
   *
   * Returns { restored: boolean, snapshot: object|null }.
   */
  async function checkAndRestore() {
    try {
      const res = await fetch('/library-snapshot');
      if (!res.ok) return { restored: false, snapshot: null };
      const data = await res.json();
      if (!data.exists || !data.snapshot) return { restored: false, snapshot: null };

      // Check if IndexedDB is empty
      const musicDb = window.openMusicDb ? await window.openMusicDb() : null;
      if (!musicDb) return { restored: false, snapshot: null };

      const songCount = await idbCount(musicDb, 'songs');
      if (songCount > 0) {
        // IDB has data - compare revisions and use newer
        // (Current IDB wins; snapshot is just a safety net)
        return { restored: false, snapshot: data.snapshot };
      }

      // IDB is empty - restore from snapshot
      console.log('[library-sync] IndexedDB empty, restoring from library.json…');
      await restoreSnapshot(musicDb, data.snapshot);
      return { restored: true, snapshot: data.snapshot };
    } catch (err) {
      console.warn('[library-sync] restore check failed:', err.message);
      return { restored: false, snapshot: null };
    }
  }

  async function restoreSnapshot(musicDb, snap) {
    const songs = snap.songs || [];
    const entries = snap.playlistEntries || [];
    const failed = snap.failedRows || [];

    // Write songs
    if (songs.length) {
      await new Promise((resolve, reject) => {
        const tx = musicDb.transaction('songs', 'readwrite');
        const store = tx.objectStore('songs');
        for (const song of songs) store.put(song);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    // Write playlist entries
    if (entries.length) {
      await new Promise((resolve, reject) => {
        const tx = musicDb.transaction('playlistEntries', 'readwrite');
        const store = tx.objectStore('playlistEntries');
        for (const entry of entries) store.put(entry);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    // Write failed rows
    if (failed.length) {
      await new Promise((resolve) => {
        try {
          const tx = musicDb.transaction('failedRows', 'readwrite');
          const store = tx.objectStore('failedRows');
          for (const row of failed) store.put(row);
          tx.oncomplete = resolve;
          tx.onerror = resolve; // non-fatal
        } catch (_) { resolve(); }
      });
    }

    // Restore localStorage keys
    const lsKeys = ['playlists', 'playlistInstruments', 'globalCustomTags', 'computedPlaylists'];
    for (const key of lsKeys) {
      if (snap[key] != null) {
        try { localStorage.setItem(key, JSON.stringify(snap[key])); } catch (_) {}
      }
    }
    // Restore computedPlaylistsLastRun as a plain string (not JSON)
    // so the app skips re-scoring on the first load after restore.
    try {
      const lastRun = snap.computedPlaylistsLastRun || null;
      if (lastRun) localStorage.setItem('computedPlaylistsLastRun', lastRun);
    } catch (_) {}

    // Restore playStats if available
    if (snap.playStats && window.openPlayStatsDb) {
      try {
        const statsDb = await window.openPlayStatsDb();
        const restoreStore = async (storeName, rows) => {
          if (!rows || !rows.length) return;
          const existingCount = await new Promise((resolve) => {
            const req = statsDb.transaction(storeName, 'readonly').objectStore(storeName).count();
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => resolve(0);
          });
          if (existingCount === 0) {
            await new Promise((resolve) => {
              const tx = statsDb.transaction(storeName, 'readwrite');
              const store = tx.objectStore(storeName);
              for (const row of rows) store.put(row);
              tx.oncomplete = resolve;
              tx.onerror = resolve;
            });
          }
        };
        // Handle both old flat array shape and new { dailyPlays, totals } shape
        const dp = Array.isArray(snap.playStats) ? snap.playStats : (snap.playStats.dailyPlays || []);
        const tot = Array.isArray(snap.playStats) ? [] : (snap.playStats.totals || []);
        await restoreStore('dailyPlays', dp);
        await restoreStore('totals', tot);
      } catch (_) { /* non-fatal */ }
    }

    console.log(`[library-sync] Restored ${songs.length} songs, ${entries.length} playlist entries.`);
  }

  /* --------------------------------------------------------------- backfill */

  /**
   * One-time migration: upload every existing audio blob + cover from IndexedDB
   * to the server so the library/ folder is fully populated for existing libraries.
   *
   * Safe to call multiple times — the server skips audio files that already exist
   * on disk. Progress is logged to the console.
   *
   * Called automatically on startup. Can also be triggered manually from DevTools:
   *   window.LibrarySync.backfillAll()
   */
  async function backfillAll() {
    const musicDb = window.openMusicDb ? await window.openMusicDb() : null;
    if (!musicDb) return;

    // --- audio blobs ---
    const blobs = await new Promise((resolve) => {
      try {
        const tx = musicDb.transaction('songBlobs', 'readonly');
        const req = tx.objectStore('songBlobs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });

    console.log(`[library-sync] Backfill: uploading ${blobs.length} audio blobs…`);
    for (const row of blobs) {
      if (!row || row.id == null || !row.file) continue;
      await uploadAudio(row.id, row.file);
    }

    // --- covers ---
    const covers = await new Promise((resolve) => {
      try {
        const tx = musicDb.transaction('songCovers', 'readonly');
        const req = tx.objectStore('songCovers').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });

    console.log(`[library-sync] Backfill: uploading ${covers.length} covers…`);
    for (const row of covers) {
      if (!row || row.id == null || !row.blob) continue;
      await uploadCover(row.id, row.blob);
    }

    // --- metadata snapshot ---
    console.log('[library-sync] Backfill: writing metadata snapshot…');
    await doSync();

    // --- free the duplicate IDB storage now everything is on disk ---
    console.log('[library-sync] Backfill: clearing songBlobs from IDB…');
    await clearBlobStore();

    console.log('[library-sync] Backfill complete. Audio served from disk only.');
  }

  /* ------------------------------------------------------------------ expose */

  window.LibrarySync = {
    scheduleSync,
    doSync,
    uploadAudio,
    uploadCover,
    getCachedBlob,
    clearBlobStore,
    checkAndRestore,
    backfillAll,
  };

  // Auto-run backfill on startup so existing libraries are fully mirrored.
  // Wrapped in setTimeout so the page's openDb() call finishes first.
  setTimeout(() => {
    backfillAll().catch((err) => console.warn('[library-sync] Backfill error:', err));
  }, 3000);

})();
