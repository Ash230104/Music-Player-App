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
  let lastSyncHash = null;
  // Audio blobs whose disk write hasn't been confirmed yet. A brand-new song lives
  // only here until the server has it, so playback works immediately. Entries are
  // dropped the moment the server confirms the write; nothing is kept after that.
  const pendingAudio = new Map();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fast non-crypto string hash (cyrb53) used to skip re-sending an unchanged snapshot.
  function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
  }

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

    return {
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
      const content = await buildSnapshot();
      if (!content) return;
      // Nothing changed since the last successful sync: don't send anything.
      const hash = hashString(JSON.stringify(content));
      if (hash === lastSyncHash) return;
      const res = await fetch('/library-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: ++lastRevision, ...content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[library-sync] server error:', err.error || res.status);
        return;
      }
      lastSyncHash = hash;
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

  /** POST one audio blob. Resolves true only if the server confirmed the write. */
  async function postAudio(songId, blob) {
    try {
      const res = await fetch(`/library-save-audio?id=${encodeURIComponent(String(songId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (res.ok) return true;
      console.warn('[library-sync] audio upload failed: HTTP', res.status);
    } catch (err) {
      console.warn('[library-sync] audio upload failed:', err.message);
    }
    return false;
  }

  /**
   * Upload a newly added song's audio to disk (its only permanent copy).
   * The blob is held in RAM just until the server confirms the write, so the
   * song is playable immediately; after that it is released. If every retry
   * fails the blob stays held, because it is the only copy.
   */
  async function uploadAudio(songId, blob) {
    if (songId == null || !blob) return false;
    const key = String(songId);
    pendingAudio.set(key, blob);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await postAudio(key, blob)) {
        pendingAudio.delete(key);
        return true;
      }
      await sleep(1000 * attempt);
    }
    return false;
  }

  /** Blob for a song whose disk write isn't confirmed yet, else null. */
  function getCachedBlob(songId) {
    return pendingAudio.get(String(songId)) || null;
  }

  /**
   * Upload one song's cover blob. Resolves true if the server confirmed it.
   * (The server skips the write if the file is byte-identical.)
   */
  async function uploadCover(songId, blob) {
    if (songId == null || !blob) return false;
    try {
      const res = await fetch(`/library-save-cover?id=${encodeURIComponent(String(songId))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      if (res.ok) return true;
      console.warn('[library-sync] cover upload failed: HTTP', res.status);
    } catch (err) {
      console.warn('[library-sync] cover upload failed:', err.message);
    }
    return false;
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
      // Cheap local check first: only fetch the (large) snapshot if IDB is empty.
      const musicDb = window.openMusicDb ? await window.openMusicDb() : null;
      if (!musicDb) return { restored: false, snapshot: null };
      if ((await idbCount(musicDb, 'songs')) > 0) return { restored: false, snapshot: null };

      const res = await fetch('/library-snapshot');
      if (!res.ok) return { restored: false, snapshot: null };
      const data = await res.json();
      if (!data.exists || !data.snapshot) return { restored: false, snapshot: null };

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
   * Migration/self-heal: make sure every audio blob (legacy songBlobs store) and cover
   * in IndexedDB also exists on disk. Asks the server what it already has and uploads
   * only what is missing, so a fully mirrored library costs one small GET and a couple
   * of key lookups, with no uploads and no blob reads.
   *
   * The legacy songBlobs store is only cleared after the server confirms every one of
   * its songs is on disk.
   *
   * Runs automatically on startup. Manual trigger: window.LibrarySync.backfillAll()
   */
  async function fetchInventory() {
    try {
      const res = await fetch('/library-inventory');
      if (!res.ok) return null;
      const j = await res.json();
      return {
        audio: new Set((j.audio || []).map(String)),
        covers: new Set((j.covers || []).map(String)),
      };
    } catch (_) { return null; }
  }

  function idbKeys(db, storeName) {
    return new Promise((resolve) => {
      try {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    });
  }

  function idbGetOne(db, storeName, key) {
    return new Promise((resolve) => {
      try {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  async function backfillAll() {
    const musicDb = window.openMusicDb ? await window.openMusicDb() : null;
    if (!musicDb) return;

    let inventory = await fetchInventory();
    if (!inventory) {
      console.warn('[library-sync] Backfill skipped: server inventory unavailable.');
      return;
    }

    let uploaded = false;

    // --- legacy audio blobs: upload only the ones missing on disk, one at a time ---
    const blobKeys = await idbKeys(musicDb, 'songBlobs');
    const missingAudio = blobKeys.filter((k) => !inventory.audio.has(String(k)));
    if (missingAudio.length) console.log(`[library-sync] Backfill: uploading ${missingAudio.length} audio blobs…`);
    for (const key of missingAudio) {
      const row = await idbGetOne(musicDb, 'songBlobs', key);
      if (row && row.file && await postAudio(key, row.file)) uploaded = true;
    }

    // --- covers: same idea ---
    const coverKeys = await idbKeys(musicDb, 'songCovers');
    const missingCovers = coverKeys.filter((k) => !inventory.covers.has(String(k)));
    if (missingCovers.length) console.log(`[library-sync] Backfill: uploading ${missingCovers.length} covers…`);
    for (const key of missingCovers) {
      const row = await idbGetOne(musicDb, 'songCovers', key);
      if (row && row.blob && await uploadCover(key, row.blob)) uploaded = true;
    }

    if (uploaded) {
      await doSync();
      inventory = await fetchInventory();
    }

    // --- free the legacy IDB audio copy, but only if the disk has all of it ---
    if (blobKeys.length) {
      if (inventory && blobKeys.every((k) => inventory.audio.has(String(k)))) {
        await clearBlobStore();
      } else {
        console.warn('[library-sync] Backfill: some audio not confirmed on disk; keeping songBlobs in IndexedDB.');
      }
    }
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
  // On an already-mirrored library this is just one GET /library-inventory.
  // Wrapped in setTimeout so the page's openDb() call finishes first.
  // Runs when the browser is idle so it never competes with startup/clicks.
  setTimeout(() => {
    const run = () => backfillAll().catch((err) => console.warn('[library-sync] Backfill error:', err));
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 15000 });
    else run();
  }, 3000);

})();
