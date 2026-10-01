# Wiring the analyzer into your `index.html`

These are written against the `index.html` you sent. Each step quotes the code that is there now,
so you can find the spot with a text search. Nothing here changes how songs are stored.

---

## 1. Load the analyzer (2 lines)

Find, near line 546:

```html
  <script src="/vendor/Sortable.min.js"></script>
```

Add underneath:

```html
  <script src="/analyzer/analyzer-map.js"></script>
  <script src="/analyzer/analyzer.js"></script>
```

---

## 2. Helpers: write a patch back, and queue a song for analysis

Paste this block inside the big inline `<script>`, next to `saveSong` / `deleteSong`
(anywhere after `loadSongs` is defined is fine).

```js
      // ---------------------------------------------------------------- analyzer --
      let analyserBusy = false;

      /** Write only the analyzer's fields onto a stored song, without touching the blob. */
      function applyAnalysisPatch(id, patch) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction("songs", "readwrite");
          const store = tx.objectStore("songs");
          const req = store.get(id);
          req.onsuccess = () => {
            const row = req.result;
            if (!row) return resolve(false);
            Object.assign(row, patch);
            store.put(row);
          };
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      }

      /** Analyse one song in the background and fill in whatever is still unknown. */
      async function analyseSong(song, { quiet = false } = {}) {
        if (!song || !song.file || !SongAnalyzer.needsAnalysis(song)) return null;
        const result = await SongAnalyzer.analyse(song.file);
        const { patch, filled } = SongAnalyzer.buildPatch(song, result);
        await applyAnalysisPatch(song.id, patch);
        Object.assign(song, patch);
        if (!quiet && filled.length) {
          showToast(song.name, "auto-filled: " + filled.join(", "));
        }
        loadSongs();
        return result;
      }

      /** Fire-and-forget: never let an analysis failure break an import. */
      function queueAnalysis(song) {
        analyseSong(song, { quiet: false }).catch((e) =>
          console.warn("Analysis failed for", song && song.name, e)
        );
      }
```

---

## 3. Run it after a song is saved

`saveSong` currently throws away the new row's id, so replace:

```js
        const transaction = db.transaction("songs", "readwrite");
        const store = transaction.objectStore("songs");
        store.add(song);
        transaction.oncomplete = () => loadSongs();
        transaction.onerror = (event) =>
          console.error("Error saving song:", event.target.errorCode);
      }
```

with:

```js
        const transaction = db.transaction("songs", "readwrite");
        const store = transaction.objectStore("songs");
        const addReq = store.add(song);
        addReq.onsuccess = () => { song.id = addReq.result; };
        transaction.oncomplete = () => {
          loadSongs();
          queueAnalysis(song);          // runs after the song is safely stored
        };
        transaction.onerror = (event) =>
          console.error("Error saving song:", event.target.errorCode);
      }
```

That covers **both** paths at once: local imports and finished YouTube downloads both end in
`saveSong`, and the UI never waits for the analysis.

---

## 4. Keep Last.fm for the title/artist only

In the SSE handler, `fetchLastFmMetadata` currently only ever returns `{ name, artist }`, so
`meta?.genre` and `meta?.mood` are always empty anyway. Leave the lookup in place for cleaning up
the title, and let the analyzer fill genre/mood/language. If you want to be explicit, change:

```js
              genre:
                meta?.genre || "",

              mood:
                meta?.mood || "",
```

to:

```js
              genre: "",        // filled by the local analyzer after saving
              mood: "",
```

---

## 5. Don't wipe the analyzer's bookkeeping when a song is edited

The edit dialog rebuilds `updated` from scratch, which silently drops `analysed`, `autoFilled`
and `bpm` — so every edited song would be analysed again on the next import. In the
`saveEditBtn` click handler, replace:

```js
          updated.file = request.result.file; // keep the original file
          updated.playlist = request.result.playlist;
          updated.favorite = request.result.favorite || false;
          updated.order = request.result.order;
          store.put(updated); // update in IndexedDB
```

with:

```js
          const old = request.result;
          updated.file = old.file;                 // keep the original file
          updated.playlist = old.playlist;
          updated.favorite = old.favorite || false;
          updated.order = old.order;
          updated.analysed = old.analysed;
          updated.analysedAt = old.analysedAt;
          updated.bpm = old.bpm;

          // whatever you just typed is yours now: drop the "auto" marker for changed fields
          const auto = Object.assign({}, old.autoFilled);
          ["genre", "mood", "language", "tempo"].forEach((f) => {
            if (updated[f] !== old[f]) delete auto[f];
          });
          updated.autoFilled = auto;
          // a hand-moved tempo slider is a real value, even when it says 5
          if (String(updated.tempo) !== String(old.tempo) || old.tempoSet) updated.tempoSet = true;

          store.put(updated); // update in IndexedDB
```

---

## 6. Show which values were guessed

In the song list renderer, replace:

```js
          const genre = song.genre || "Unknown";
          const mood = song.mood || "Unknown";
          const tempo = song.tempo || "-";
          const language = song.language || "Unknown";
```

with:

```js
          const auto = song.autoFilled || {};
          const mark = (f, v) =>
            (v || "Unknown") + (auto[f] ? ' <span class="auto-mark" title="guessed by the analyzer">auto</span>' : "");
          const genre = mark("genre", song.genre);
          const mood = mark("mood", song.mood);
          const tempo = mark("tempo", song.tempo);
          const language = mark("language", song.language);
```

(`song-meta` is already built with a template literal, so the markup goes straight through.)

And add the style next to your other CSS:

```css
.auto-mark{font-size:10px;opacity:.7;border:1px solid currentColor;border-radius:4px;padding:0 3px;vertical-align:1px}
```

---

## 7. An "Analyse library" button

Markup — put it wherever your other playlist tools live:

```html
<button id="analyse-all-btn" title="Fill in missing genre / mood / language">Analyse</button>
```

Script:

```js
      document.getElementById("analyse-all-btn").addEventListener("click", async () => {
        if (analyserBusy) return showToast("Analyzer", "already running");
        const todo = songs.filter((s) => s.file && SongAnalyzer.needsAnalysis(s));
        if (!todo.length) return showToast("Analyzer", "nothing left to fill in");

        analyserBusy = true;
        showToast("Analyzer", `starting on ${todo.length} song(s)…`, 4000);
        try {
          const run = SongAnalyzer.analyseMany(
            todo.map((song) => ({ song, blob: song.file })),
            {
              onProgress: ({ done, total, name, stage }) =>
                showToast(`Analyzer ${done}/${total}`, `${name} — ${stage}`, 4000),
              onEach: async (song, result, patch) => {
                await applyAnalysisPatch(song.id, patch);
                Object.assign(song, patch);
              }
            }
          );
          const r = await run;
          loadSongs();
          showToast("Analyzer", `done: ${r.done} analysed, ${r.failed.length} failed`, 6000);
          if (r.failed.length) console.warn("analysis failures", r.failed);
        } finally {
          analyserBusy = false;
        }
      });
```

`analyseMany` runs one song at a time and keeps going after a failure. The returned promise has a
`.stop()` if you ever want a cancel button.

---

## 8. Two files outside `index.html`

**`server.js`** — add to the `MIME` table so the WASM and model weights are served properly:

```js
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.mjs': 'text/javascript; charset=utf-8',
```

**`main.js`** — inside the `Help` submenu, so you can reach the test page:

```js
        { label: 'Analyzer self-test', click: () => win.loadURL(`${server.origin}/analyzer-test.html`) },
```

---

## Order of operations that I'd suggest

1. `npm run setup-analyzer`, then open **Help → Analyzer self-test** and drop 5-6 songs you know.
2. Only when the numbers look sane, do steps 1-7 above.
3. Analyse the library in one go with the button, then spot-check and fix the ones it got wrong in
   the edit dialog — those become your ground truth for adjusting `CONFIG`.
