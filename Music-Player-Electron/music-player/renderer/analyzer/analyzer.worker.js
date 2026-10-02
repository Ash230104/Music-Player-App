/* analyzer.worker.js (v2): runs Essentia.js (WASM) + TensorFlow.js off the UI thread.
 *
 * Messages in:
 *   { type: 'init',    libBase, modelBase, models: [{ name, required }] }
 *   { type: 'analyse', id, audio16k: Float32Array, audio44k: Float32Array }
 * Messages out:
 *   { type: 'ready',    backend, loaded: [names], failed: [{ name, error, required }] }
 *   { type: 'progress', id, stage }
 *   { type: 'result',   id, raw: { bpm, bpmConfidence, danceability, rmsDb, key, scale,
 *                                  keyStrength, models: { name: { classes, mean, patches } },
 *                                  errors: [{ what, error }] } }
 *   { type: 'error',    id, message }
 *
 * The worker returns RAW numbers. Turning them into "pop / sad / 6" happens in analyzer-map.js on
 * the page, so tuning thresholds never needs a worker reload.
 *
 * v2 changes:
 *   - every Essentia call and every model is wrapped on its own: one broken optional model, or a
 *     track RhythmExtractor chokes on, no longer kills the whole analysis.
 *   - extra cheap cues: RMS loudness in dB, key/scale, danceability.
 *   - the mel-spectrogram pass is computed once and explicitly reused by all models.
 */
'use strict';

var essentia = null;       // Essentia core (RhythmExtractor2013, KeyExtractor, ...)
var extractor = null;      // mel-spectrogram extractor for the MusiCNN family
var wasm = null;
var loadedModels = {};     // name -> { model, classes }
var initInfo = null;

function post(msg) { self.postMessage(msg); }
function errText(e) { return (e && (e.message || e.stack)) || String(e); }
function free(x) { try { if (x && typeof x.delete === 'function') x.delete(); } catch (_) { /* ignore */ } }
function logMem(label) {
  try {
    var m = tf.memory();
    console.log('[analyzer.worker] GPU after ' + label + ': ' + m.numTensors + ' tensors, ' +
      (m.numBytesInGPU != null ? (m.numBytesInGPU / 1048576).toFixed(1) + ' MB (GPU)' : (m.numBytes / 1048576).toFixed(1) + ' MB'));
  } catch (_) { /* tf not ready yet, or backend without GPU byte tracking */ }
}

async function init(msg) {
  var libBase = msg.libBase, modelBase = msg.modelBase;

  // essentia-wasm.web.js is compiled with ENVIRONMENT_IS_WEB=true (hardcoded), so it
  // unconditionally accesses document.currentScript and document.title inside the worker
  // where document does not exist. This minimal stub prevents the "document is not defined"
  // crash without affecting any real browser behaviour.
  if (typeof document === 'undefined') {
    self.document = {
      currentScript: { src: self.location.href },
      title: '',
      createElement: function () { return {}; }
    };
  }

  importScripts(
    libBase + 'tf.min.js',
    libBase + 'essentia-wasm.web.js',
    libBase + 'essentia.js-core.js',
    libBase + 'essentia.js-model.js'
  );

  // WebGL is dramatically faster than the pure-JS CPU backend for the four
  // CNN models below (roughly the difference between seconds and minutes),
  // and dedicated Workers in Chromium/Electron do support it via
  // OffscreenCanvas. Try it first; only fall back to CPU if it genuinely
  // isn't available, since CPU is a real worst case, not a safe default.
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    if (tf.getBackend() !== 'webgl') throw new Error('backend did not switch to webgl');
  } catch (e) {
    console.warn('[analyzer.worker] WebGL unavailable (' + errText(e) + '), falling back to CPU - analysis will be much slower.');
    await tf.setBackend('cpu');
    await tf.ready();
  }

  // EssentiaWASM is a factory in the web build; older builds export the module directly.
  wasm = typeof EssentiaWASM === 'function'
    ? await EssentiaWASM({ locateFile: function (f) { return libBase + f; } })
    : EssentiaWASM;

  essentia = new Essentia(wasm);
  extractor = new EssentiaModel.EssentiaTFInputExtractor(wasm, 'musicnn', false);

  // Load all models concurrently: the meta.json / model.json / shard fetches overlap, and only
  // the GPU upload is effectively serial. Results are applied in the original order afterwards.
  var failed = [];
  var results = await Promise.all(msg.models.map(async function (def) {
    try {
      var metaRes = await fetch(modelBase + def.name + '/meta.json');
      if (!metaRes.ok) throw new Error('meta.json not found (' + metaRes.status + ')');
      var meta = await metaRes.json();
      var classes = meta.classes || (meta.inference && meta.inference.classes) || [];
      if (!classes.length) throw new Error('meta.json has no class list');
      var model = new EssentiaModel.TensorflowMusiCNN(tf, modelBase + def.name + '/model.json', false);
      await model.initialize();
      return { def: def, entry: { model: model, classes: classes } };
    } catch (e) {
      return { def: def, error: errText(e) };
    }
  }));
  results.forEach(function (r) {
    if (r.entry) loadedModels[r.def.name] = r.entry;
    else failed.push({ name: r.def.name, error: r.error, required: !!r.def.required });
  });

  initInfo = { backend: tf.getBackend(), loaded: Object.keys(loadedModels), failed: failed };
  post(Object.assign({ type: 'ready' }, initInfo));
}

/** predict() gives one activation vector per ~3 s patch; keep the mean and the patch count. */
function meanOf(preds) {
  if (!preds || !preds.length) return { mean: [], patches: 0 };
  if (typeof preds[0] === 'number') return { mean: Array.from(preds), patches: 1 };
  var n = preds[0].length, mean = new Array(n).fill(0), p, i;
  for (p = 0; p < preds.length; p++) for (i = 0; i < n; i++) mean[i] += preds[p][i];
  for (i = 0; i < n; i++) mean[i] /= preds.length;
  return { mean: mean, patches: preds.length };
}

function rmsDb(samples) {
  var s = 0, n = samples.length;
  if (!n) return null;
  for (var i = 0; i < n; i++) s += samples[i] * samples[i];
  var rms = Math.sqrt(s / n);
  return rms > 0 ? 20 * Math.log10(rms) : -80;
}

async function analyse(msg) {
  var id = msg.id;
  var out = {
    bpm: null, bpmConfidence: null, danceability: null, rmsDb: null,
    key: null, scale: null, keyStrength: null, models: {}, errors: []
  };

  out.rmsDb = rmsDb(msg.audio44k);

  // ---- 1) rhythm / key / danceability on the 44.1 kHz mono slice ----
  post({ type: 'progress', id: id, stage: 'tempo' });
  var vec = essentia.arrayToVector(msg.audio44k);
  try {
    try {
      var r = essentia.RhythmExtractor2013(vec);
      out.bpm = r.bpm;
      out.bpmConfidence = r.confidence;
      free(r.ticks); free(r.estimates); free(r.bpmIntervals);
    } catch (e) {
      out.errors.push({ what: 'RhythmExtractor2013', error: errText(e) });
    }

    try {
      var k = essentia.KeyExtractor(vec);
      out.key = k.key;
      out.scale = k.scale;          // 'major' | 'minor'
      out.keyStrength = k.strength;
    } catch (e) {
      out.errors.push({ what: 'KeyExtractor', error: errText(e) });
    }

    try {
      var d = essentia.Danceability(vec);
      out.danceability = d.danceability;
      free(d.dfa);
    } catch (e) {
      out.errors.push({ what: 'Danceability', error: errText(e) });
    }
  } finally {
    free(vec);
  }

  // ---- 2) one mel-spectrogram pass for the whole MusiCNN family (16 kHz mono, hop 256) ----
  post({ type: 'progress', id: id, stage: 'features' });
  tf.engine().startScope();
  var features;
  try {
    features = extractor.computeFrameWise(msg.audio16k, 256);
  } finally {
    tf.engine().endScope();
  }
  logMem('feature extraction');

  // ---- 3) every loaded model, each isolated ----
  var names = Object.keys(loadedModels);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    post({ type: 'progress', id: id, stage: 'model:' + name });
    // Scoped so any GPU tensors the model's forward pass allocates -- its own
    // intermediate activations, and whatever predict() returns before we read it
    // out into plain numbers below -- are disposed the moment this model is done,
    // instead of staying resident on the GPU until the whole analysis finishes.
    // startScope()/endScope() is the async-safe form of tf.tidy() (tf.tidy() itself
    // can't wrap an `await`).
    tf.engine().startScope();
    try {
      var preds = await loadedModels[name].model.predict(features, true);
      var m = meanOf(preds); // plain numbers, so it's safe to dispose the tensors below
      out.models[name] = { classes: loadedModels[name].classes, mean: m.mean, patches: m.patches };
    } catch (e) {
      out.errors.push({ what: 'model:' + name, error: errText(e) });
    } finally {
      tf.engine().endScope();
      logMem(name);
    }
  }

  if (!Object.keys(out.models).length && out.bpm === null) {
    throw new Error('Nothing could be computed for this track. First error: ' +
      (out.errors[0] ? out.errors[0].what + ' - ' + out.errors[0].error : 'unknown'));
  }

  logMem('all models (final)');
  post({ type: 'result', id: id, raw: out });
}

self.onmessage = async function (e) {
  var msg = e.data || {};
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'analyse') await analyse(msg);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: errText(err) });
  }
};
