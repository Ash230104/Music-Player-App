/* language.worker.js: song language detection with Whisper (transformers.js), fully offline.
 *
 * This is a MODULE worker (created with `new Worker(url, { type: 'module' })`) because
 * transformers.js ships as an ES module.
 *
 * Messages in:
 *   { type: 'init',   libBase, modelBase, modelId, quantized }
 *   { type: 'detect', id, windows: [Float32Array(16 kHz mono, <= 30 s)] }
 * Messages out:
 *   { type: 'ready',    modelId, backend }
 *   { type: 'progress', id, stage }
 *   { type: 'result',   id, windows: [{ code, prob, text, method }] }
 *   { type: 'error',    id, message }
 *
 * How the language is read out
 * ----------------------------
 * Whisper decodes as:  <|startoftranscript|> <|LANG|> <|transcribe|> <|notimestamps|> text...
 * We match the language token by token-id (most reliable), then by decoding the full
 * special-token string, then by script of the transcript (Devanagari → hi, Arabic → ur, Latin → en).
 *
 * Sung speech is harder than spoken speech: expect this to be right most of the time on vocal
 * tracks and useless on instrumentals (the caller screens those out with the "instrumental" tag).
 */

let transformers = null;
let processor = null;
let tokenizer = null;
let model = null;
let MODEL_ID = 'whisper-tiny';
/** Precomputed token id → language code for common Whisper language tokens. */
let LANG_ID_MAP = null;

const post = (m) => self.postMessage(m);
const errText = (e) => (e && (e.message || e.stack)) || String(e);

const SPECIAL_NAMES = new Set([
  'startoftranscript', 'transcribe', 'translate', 'notimestamps',
  'endoftext', 'nospeech', 'startoflm', 'startofprev'
]);

// Codes the app cares about + a few common ones Whisper might emit.
const LANG_CODES = [
  'en', 'hi', 'ur', 'ar', 'fa', 'ps', 'mr', 'ne', 'bn', 'ta', 'te', 'gu', 'pa',
  'es', 'fr', 'de', 'pt', 'it', 'ru', 'zh', 'ja', 'ko', 'tr', 'id', 'ms', 'nl',
  'pl', 'uk', 'vi', 'th', 'sw', 'yo', 'ha'
];

async function init(msg) {
  const libBase = msg.libBase || '/vendor/transformers/';
  MODEL_ID = msg.modelId || 'whisper-tiny';

  // transformers.min.js bundles the ONNX WASM runtime compiled with ENVIRONMENT_IS_WEB=true
  // (hardcoded by Emscripten). It unconditionally accesses document.currentScript and
  // document.createElement even inside a Worker where document doesn't exist.
  // This minimal stub must be set BEFORE the dynamic import() fires.
  if (typeof document === 'undefined') {
    self.document = {
      currentScript: { src: self.location.href },
      title: '',
      createElement: function () {
        return { getContext: function () { return null; }, width: 0, height: 0 };
      }
    };
  }

  transformers = await import(libBase + 'transformers.min.js');
  const { env, AutoProcessor, AutoTokenizer, AutoModelForSpeechSeq2Seq } = transformers;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = msg.modelBase || '/models/transformers/';
  env.backends.onnx.wasm.wasmPaths = libBase;
  // Multi-threaded WASM needs SharedArrayBuffer, i.e. cross-origin isolation (server.js sends
  // COOP/COEP). Without it, stay single-threaded instead of failing.
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, (self.navigator && self.navigator.hardwareConcurrency) || 1))
    : 1;

  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  model = await AutoModelForSpeechSeq2Seq.from_pretrained(MODEL_ID, {
    quantized: msg.quantized !== false
  });

  // Build token-id → code map once (decode of single special tokens is flaky across builds).
  LANG_ID_MAP = Object.create(null);
  for (const code of LANG_CODES) {
    try {
      const ids = tokenizer.encode('<|' + code + '|>', { add_special_tokens: false });
      if (ids && ids.length) LANG_ID_MAP[Number(ids[0])] = code;
    } catch (_) { /* ignore missing codes */ }
  }

  post({ type: 'ready', modelId: MODEL_ID, backend: 'onnx-wasm' });
}

const LANG_TOKEN = /<\|([a-z]{2,3})\|>/g;

function codeFromIds(ids) {
  if (!ids || !ids.length) return null;

  // 1) Match by precomputed language token ids (most reliable).
  if (LANG_ID_MAP) {
    for (const id of ids) {
      const code = LANG_ID_MAP[Number(id)];
      if (code) return code;
    }
  }

  // 2) Decode the whole sequence with special tokens kept and regex for <|xx|>.
  try {
    const full = tokenizer.decode(ids, { skip_special_tokens: false }) || '';
    LANG_TOKEN.lastIndex = 0;
    let m;
    while ((m = LANG_TOKEN.exec(full)) !== null) {
      if (!SPECIAL_NAMES.has(m[1])) return m[1];
    }
  } catch (_) { /* fall through */ }

  // 3) Per-token decode (slower, last resort).
  for (const id of ids) {
    let tok;
    try { tok = tokenizer.decode([Number(id)], { skip_special_tokens: false }); } catch (_) { continue; }
    if (!tok) continue;
    const m = /^<\|([a-z]{2,3})\|>$/.exec(tok.trim());
    if (m && !SPECIAL_NAMES.has(m[1])) return m[1];
  }
  return null;
}

/** Devanagari → hi, Arabic/Urdu script → ur, Cyrillic → ru, Latin → en. */
function codeFromScript(text) {
  if (!text) return null;
  const counts = {
    hi: (text.match(/[\u0900-\u097F]/g) || []).length,
    ur: (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) || []).length,
    ru: (text.match(/[\u0400-\u04FF]/g) || []).length,
    en: (text.match(/[A-Za-z]/g) || []).length
  };
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  // Soft threshold: short Whisper snippets on music are often only a few words.
  return counts[best] >= 2 ? best : null;
}

function toFloat32(audio) {
  if (audio instanceof Float32Array) return new Float32Array(audio);
  if (ArrayBuffer.isView(audio)) {
    return new Float32Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
  }
  if (audio && typeof audio.length === 'number') {
    const out = new Float32Array(audio.length);
    for (let i = 0; i < audio.length; i++) out[i] = Number(audio[i]) || 0;
    return out;
  }
  throw new Error('window is not audio data (' + (audio && audio.constructor && audio.constructor.name) + ')');
}

/** Peak-normalize so quiet mixes still reach Whisper's expected level. */
function normalize(audio) {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i]);
    if (a > peak) peak = a;
  }
  if (!(peak > 1e-6) || peak > 0.95) return audio;
  const scale = 0.9 / peak;
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * scale;
  return out;
}

function tokenIds(output) {
  if (!output) return [];
  const seq = output.sequences ? output.sequences : output;
  if (seq && seq.data) return Array.from(seq.data, (v) => Number(v));
  if (Array.isArray(seq)) {
    const first = seq[0];
    if (first && first.data) return Array.from(first.data, (v) => Number(v));
    if (Array.isArray(first)) return first.map(Number);
    return seq.map(Number);
  }
  return [];
}

async function extractFeatures(audio) {
  try {
    const out = await processor(audio);
    if (out && out.input_features) return out.input_features;
  } catch (_) { /* fall through */ }
  const out = await processor(audio, 16000);
  if (out && out.input_features) return out.input_features;
  throw new Error('processor did not return input_features');
}

// The language token is the first token Whisper emits after <|startoftranscript|>, so a handful
// of new tokens is enough to read it. The long budget is only used when that fails and we need
// a transcript snippet for the script-based fallback.
const FAST_TOKENS = 4;
const FULL_TOKENS = 64;

async function generateTokens(input_features, maxTokens) {
  // Multilingual Whisper: do not force a language; let it emit <|LANG|>.
  const cfg = { max_new_tokens: maxTokens, do_sample: false, task: 'transcribe' };
  try {
    return await model.generate(input_features, cfg);
  } catch (_) {
    try {
      return await model.generate(input_features, { max_new_tokens: maxTokens, do_sample: false });
    } catch (_) {
      return await model.generate({ input_features, max_new_tokens: maxTokens });
    }
  }
}

async function detectOne(audio) {
  audio = normalize(toFloat32(audio));
  const input_features = await extractFeatures(audio);

  // Fast path: a few tokens, read the language token.
  let ids = tokenIds(await generateTokens(input_features, FAST_TOKENS));
  let code = codeFromIds(ids);
  if (code) return { code, prob: null, text: '', method: 'token' };

  // Retry path: full decode, then token / script fallback as before.
  ids = tokenIds(await generateTokens(input_features, FULL_TOKENS));
  const text = (tokenizer.decode(ids, { skip_special_tokens: true }) || '').trim();
  code = codeFromIds(ids);
  let method = code ? 'token' : null;
  if (!code) {
    code = codeFromScript(text);
    method = code ? 'script' : 'none';
  }
  return { code, prob: null, text: text.slice(0, 160), method };
}

async function detect(msg) {
  const out = [];
  for (let i = 0; i < msg.windows.length; i++) {
    post({ type: 'progress', id: msg.id, stage: `language ${i + 1}/${msg.windows.length}` });
    try {
      out.push(await detectOne(msg.windows[i]));
    } catch (e) {
      out.push({ code: null, prob: null, text: '', method: 'error', error: errText(e) });
    }
    // Early stop: the first two windows agree, so the third can't change the vote.
    if (msg.earlyStop && i === 1 && out[0].code && out[0].code === out[1].code) break;
  }
  post({ type: 'result', id: msg.id, windows: out });
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') await init(msg);
    else if (msg.type === 'detect') await detect(msg);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: errText(err) });
  }
};
