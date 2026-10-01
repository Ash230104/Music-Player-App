/**
 * analyzer.js (v2): page-side API for local song analysis with Essentia.js + Whisper.
 *
 *   <script src="/analyzer/analyzer-map.js"></script>
 *   <script src="/analyzer/analyzer.js"></script>
 *
 *   const result = await SongAnalyzer.analyse(blob, { onProgress, language: true });
 *   const { patch, filled } = SongAnalyzer.buildPatch(song, result);   // only still-unknown fields
 *   Object.assign(song, patch);
 *
 * Decoding and resampling happen here (Web Audio is not available inside workers). The heavy work
 * runs in two workers:
 *   analyzer.worker.js   Essentia WASM + TensorFlow.js  (tempo, key, genre, mood)
 *   language.worker.js   Whisper via transformers.js    (language) - started only when needed
 *
 * v2 changes:
 *   - language detection (three 30 s windows, skipped for instrumentals and for songs that already
 *     have a language)
 *   - the language model is loaded lazily and unloaded again after a few idle minutes, so the app
 *     doesn't hold ~80 MB for nothing
 *   - analyseMany() with progress + cancel, for "analyse my whole library"
 *   - one analysis at a time, and a song that fails doesn't stall the queue
 */
(function () {
  'use strict';

  var LIB_BASE = '/vendor/essentia/';
  var TRANSFORMERS_BASE = '/vendor/transformers/';
  var MODEL_BASE = '/models/';
  var TRANSFORMERS_MODEL_BASE = '/models/transformers/';
  var WORKER_URL = '/analyzer/analyzer.worker.js';
  var LANG_WORKER_URL = '/analyzer/language.worker.js';
  var LANG_MODEL_ID = 'whisper-tiny';

  // Which models to load. `required` ones must exist or analysis refuses to run.
  var MODELS = [
    { name: 'msd-musicnn', required: false },       // 50-tag autotagger (genre + mood evidence)
    { name: 'genre_tzanetakis', required: true },  // blu cla cou dis hip jaz met pop reg roc
    { name: 'genre_rosamerica', required: false }, // cla dan hip jaz pop rhy roc spe
    { name: 'mood_happy', required: false },
    { name: 'mood_sad', required: true },
    { name: 'mood_relaxed', required: true }
    // mood_party and mood_aggressive were dropped: across a 5-song test batch neither ever
    // produced a confident score (best case 64% aggressive on a near coin-flip), so they were
    // costing GPU/CPU time without ever changing a result. "energetic" is still covered by the
    // msd-musicnn autotagger's party/dance/hard-rock/metal/punk tags and by tempo+loudness -
    // see mapMood() in analyzer-map.js. Re-add here if you want the dedicated heads back.
  ];

  var EXCERPT_SEC = 30;          // slice used for tempo/key/genre/mood (44.1 kHz)  ← was 60
  var MODEL_SEC = 20;            // first part of that slice used for the MusiCNN nets (16 kHz) ← was 45
  var LANG_WINDOW_SEC = 30;      // Whisper's native window length
  var LANG_WINDOWS = 3;          // how many windows to sample across the track
  var TIMEOUT_MS = 5 * 60 * 1000;   // was 3 min - CPU-backend fallback (no WebGL) can still take a while
  var LANG_IDLE_MS = 5 * 60 * 1000;
  var ANALYZER_IDLE_MS = 60 * 1000;   // unload the Essentia/TF.js worker (and its GPU memory) after 1 min unused

  var worker = null, readyPromise = null, readyInfo = null;
  var langWorker = null, langReady = null, langInfo = null, langIdleTimer = null;
  var analyzerIdleTimer = null;
  var nextId = 1;
  var pending = {};
  var langPending = {};
  var queue = Promise.resolve();

  function makeWorker(url, opts, pendingMap, onReady, onFail) {
    var w = new Worker(url, opts);
    w.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'ready') return onReady(m);
      var p = pendingMap[m.id];
      if (m.type === 'progress') { if (p && p.onProgress) { try { p.onProgress(m.stage); } catch (_) {} } return; }
      if (m.type === 'result' && p) { delete pendingMap[m.id]; p.resolve(m); return; }
      if (m.type === 'error') {
        if (p) { delete pendingMap[m.id]; p.reject(new Error(m.message)); }
        else onFail(new Error(m.message));    // failed during init
      }
    };
    w.onerror = function (e) { onFail(new Error('Worker ' + url + ' crashed: ' + (e.message || 'unknown error'))); };
    return w;
  }

  // ---- Essentia worker ------------------------------------------------------------------
  function ensureWorker() {
    clearTimeout(analyzerIdleTimer);
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      worker = makeWorker(WORKER_URL, undefined, pending, function (m) {
        readyInfo = m;
        var missing = (m.failed || []).filter(function (f) { return f.required; });
        if (missing.length) {
          reject(new Error('Required model(s) missing: ' + missing.map(function (f) { return f.name + ' (' + f.error + ')'; }).join(', ') +
            '. Run "npm run setup-analyzer".'));
        } else resolve(m);
      }, reject);
      worker.postMessage({ type: 'init', libBase: LIB_BASE, modelBase: MODEL_BASE, models: MODELS });
    });
    readyPromise.catch(function () { readyPromise = null; if (worker) { worker.terminate(); worker = null; } });
    return readyPromise;
  }

  /** Frees the worker's WASM heap + GPU memory after a minute of no analysis. The next
   *  analyse() call pays the load cost again (models + WASM init), same as a fresh app start. */
  function touchAnalyzerIdle() {
    clearTimeout(analyzerIdleTimer);
    analyzerIdleTimer = setTimeout(function () {
      if (worker) { worker.terminate(); worker = null; readyPromise = null; readyInfo = null; }
    }, ANALYZER_IDLE_MS);
  }

  // ---- Whisper worker (lazy) ------------------------------------------------------------
  function ensureLangWorker() {
    clearTimeout(langIdleTimer);
    if (langReady) return langReady;
    langReady = new Promise(function (resolve, reject) {
      langWorker = makeWorker(LANG_WORKER_URL, { type: 'module' }, langPending, function (m) {
        langInfo = m;
        resolve(m);
      }, reject);
      langWorker.postMessage({
        type: 'init',
        libBase: TRANSFORMERS_BASE,
        modelBase: TRANSFORMERS_MODEL_BASE,
        modelId: LANG_MODEL_ID,
        quantized: true
      });
    });
    langReady.catch(function () { langReady = null; if (langWorker) { langWorker.terminate(); langWorker = null; } });
    return langReady;
  }

  function touchLangIdle() {
    clearTimeout(langIdleTimer);
    langIdleTimer = setTimeout(function () {
      if (langWorker) { langWorker.terminate(); langWorker = null; langReady = null; langInfo = null; }
    }, LANG_IDLE_MS);
  }

  // ---- audio preparation (main thread) ---------------------------------------------------
  async function decode(blob) {
    var buf = await blob.arrayBuffer();
    var ctx = new OfflineAudioContext(1, 1, 44100);   // decodeAudioData resamples to the context rate
    return ctx.decodeAudioData(buf);
  }

  function monoExcerpt(audioBuffer, startSec, durSec) {
    var sr = audioBuffer.sampleRate;
    var start = Math.max(0, Math.floor(startSec * sr));
    var len = Math.max(0, Math.min(audioBuffer.length - start, Math.floor(durSec * sr)));
    var out = new Float32Array(len);
    var ch = audioBuffer.numberOfChannels;
    for (var c = 0; c < ch; c++) {
      var data = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += data[start + i] / ch;
    }
    return out;
  }

  async function resample(mono, fromRate, toRate) {
    var n = Math.max(1, Math.ceil(mono.length / fromRate * toRate));
    var ctx = new OfflineAudioContext(1, n, toRate);
    var b = ctx.createBuffer(1, mono.length, fromRate);
    b.copyToChannel(mono, 0);
    var src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(ctx.destination);
    src.start();
    var rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
  }

  function ask(w, pendingMap, message, transfer, onProgress) {
    var id = nextId++;
    message.id = id;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pendingMap[id];
        reject(new Error('Analysis timed out.'));
      }, TIMEOUT_MS);
      pendingMap[id] = {
        onProgress: onProgress,
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      w.postMessage(message, transfer || []);
    });
  }

  // ---- one song ---------------------------------------------------------------------------
  function runOne(blob, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};
    var wantLanguage = opts.language !== false;

    return (async function () {
      progress('loading');
      await ensureWorker();

      progress('decoding');
      var audio = await decode(blob);
      var dur = audio.duration;
      if (!(dur > 3)) throw new Error('Audio is too short to analyse.');

      var start = Math.max(0, Math.min(dur * 0.3, dur - EXCERPT_SEC));
      var audio44k = monoExcerpt(audio, start, EXCERPT_SEC);
      var audio16k = (await resample(audio44k, 44100, 16000)).slice(0, MODEL_SEC * 16000);

      var res = await ask(worker, pending,
        { type: 'analyse', audio16k: audio16k, audio44k: audio44k },
        [audio16k.buffer, audio44k.buffer], progress);
      var raw = res.raw;

      // ---- language pass (Whisper via language.worker.js) -------------------------------
      // Protocol matches language.worker.js:
      //   in:  { type: 'detect', id, windows: [Float32Array(16kHz mono, <=30s)] }
      //   out: { type: 'result', id, windows: [{ code, prob, text, method }] }
      var ms = raw.models && raw.models['msd-musicnn'];
      var instrumental = null;
      if (ms && ms.classes) {
        var idx = ms.classes.indexOf('instrumental');
        if (idx >= 0) instrumental = ms.mean[idx];
      }
      raw.language = { windows: [], instrumental: instrumental };

      if (wantLanguage) {
        var ceil = (AnalyzerMap.CONFIG && AnalyzerMap.CONFIG.language &&
          AnalyzerMap.CONFIG.language.instrumentalCeiling) || 0.99;
        if (instrumental != null && instrumental > ceil) {
          // Confidently instrumental — skip Whisper; mapLanguage will report why.
        } else {
          try {
            progress('language');
            await ensureLangWorker();

            // Spread LANG_WINDOWS non-overlapping 30 s slices across the track.
            var winSec = LANG_WINDOW_SEC;
            var nWin = LANG_WINDOWS;
            var usable = Math.max(0, dur - winSec);
            var starts = [];
            if (usable <= 0) {
              starts = [0];
            } else if (nWin === 1) {
              starts = [usable * 0.3];
            } else {
              for (var wi = 0; wi < nWin; wi++) {
                starts.push((usable * wi) / (nWin - 1));
              }
            }

            var slices = [];
            var transfer = [];
            for (var wi2 = 0; wi2 < starts.length; wi2++) {
              var slice44 = monoExcerpt(audio, starts[wi2], winSec);
              var slice16 = await resample(slice44, 44100, 16000);
              // Cap at exactly 30 s of 16 kHz in case resampling overshoots.
              if (slice16.length > winSec * 16000) {
                slice16 = slice16.slice(0, winSec * 16000);
              }
              slices.push(slice16);
              transfer.push(slice16.buffer);
            }

            var lr = await ask(langWorker, langPending, {
              type: 'detect',
              windows: slices
            }, transfer, progress);

            raw.language.windows = (lr.windows || []).map(function (w) {
              return {
                code: (w && w.code) || null,
                prob: (w && typeof w.prob === 'number') ? w.prob : null,
                method: (w && w.method) || 'whisper',
                text: (w && w.text) || '',
                error: (w && w.error) || null
              };
            });
            touchLangIdle();
          } catch (langErr) {
            // Language failure must not fail the whole analysis.
            raw.languageError = (langErr && langErr.message) || String(langErr);
          }
        }
      }

      var result = AnalyzerMap.summarise(raw);
      result.raw = raw;
      result.durationSec = dur;
      result.excerptStartSec = start;
      return result;
    })().finally(touchAnalyzerIdle);
  }

  /** Analyses one at a time so importing many songs doesn't pile up in the workers. */
  function analyse(blob, opts) {
    var job = queue.then(function () { return runOne(blob, opts); });
    queue = job.catch(function () { /* keep the queue alive after a failure */ });
    return job;
  }

  /**
   * Analyse a list of songs.
   *   items: [{ song, blob }]
   *   onEach(song, result, patch, filled)   called after every success
   *   onProgress({ done, total, name, stage })
   * Returns { done, failed: [{ song, error }], cancelled }. Call the returned stop() to cancel.
   */
  function analyseMany(items, opts) {
    opts = opts || {};
    var cancelled = false;
    var promise = (async function () {
      var failed = [], done = 0;
      for (var i = 0; i < items.length; i++) {
        if (cancelled) break;
        var it = items[i];
        var name = (it.song && it.song.name) || 'song ' + (i + 1);
        try {
          var result = await analyse(it.blob, {
            language: opts.language,
            onProgress: function (stage) {
              if (opts.onProgress) opts.onProgress({ done: done, total: items.length, name: name, stage: stage });
            }
          });
          var built = AnalyzerMap.buildPatch(it.song, result);
          if (opts.onEach) await opts.onEach(it.song, result, built.patch, built.filled);
        } catch (e) {
          failed.push({ song: it.song, error: (e && e.message) || String(e) });
        }
        done++;
        if (opts.onProgress) opts.onProgress({ done: done, total: items.length, name: name, stage: 'done' });
      }
      return { done: done, failed: failed, cancelled: cancelled };
    })();
    promise.stop = function () { cancelled = true; };
    return promise;
  }

  window.SongAnalyzer = {
    analyse: analyse,
    analyseMany: analyseMany,
    buildPatch: AnalyzerMap.buildPatch,
    unknownFields: AnalyzerMap.unknownFields,
    /** true when this song still has something the analyzer could fill */
    needsAnalysis: function (song) {
      var u = AnalyzerMap.unknownFields(song);
      return u.genre || u.mood || u.tempo || u.language;
    },
    /** resolves with { backend, loaded, failed } once the models are up (also warms the worker) */
    ready: function () { return ensureWorker(); },
    languageReady: function () { return ensureLangWorker(); },
    info: function () { return readyInfo; },
    languageInfo: function () { return langInfo; },
    config: AnalyzerMap.CONFIG,
    models: MODELS
  };
})();
