/* node test/analyzer-map.test.js
 *
 * Tests the pure label mapping with hand-written model output. Nothing here touches Essentia,
 * TensorFlow or the browser, so it runs anywhere in well under a second.
 */
'use strict';
const M = require('../renderer/analyzer/analyzer-map.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name + ' (' + JSON.stringify(got) + ')', got === want, { got, want }); }

// ---------- helpers to build fake model output ----------
const TZ = ['blu', 'cla', 'cou', 'dis', 'hip', 'jaz', 'met', 'pop', 'reg', 'roc'];
const RO = ['cla', 'dan', 'hip', 'jaz', 'pop', 'rhy', 'roc', 'spe'];
const MSD = ['rock', 'pop', 'alternative', 'indie', 'electronic', 'female vocalists', 'dance', '00s',
  'alternative rock', 'jazz', 'beautiful', 'metal', 'chillout', 'male vocalists', 'classic rock', 'soul',
  'indie rock', 'Mellow', 'electronica', '80s', 'folk', '90s', 'chill', 'instrumental', 'punk', 'oldies',
  'blues', 'hard rock', 'ambient', 'acoustic', 'experimental', 'female vocalist', 'guitar', 'Hip-Hop',
  '70s', 'party', 'country', 'easy listening', 'sexy', 'catchy', 'funk', 'electro', 'heavy metal',
  'Progressive rock', '60s', 'rnb', 'indie pop', 'sad', 'House', 'happy'];

const model = (classes, values) => ({ classes, mean: classes.map((c) => values[c] || 0.01) });
const binary = (name, p) => ({ classes: [name, 'non_' + name], mean: [p, 1 - p] });

// ---------- tempo ----------
console.log('\ntempo');
eq('60 BPM -> 1', M.tempoFromBpm(60), '1');
eq('120 BPM -> 6', M.tempoFromBpm(120), '6');
eq('180 BPM is folded to 90 -> 3', M.tempoFromBpm(180), '3');
eq('40 BPM doubles to 80 -> 3', M.tempoFromBpm(40), '3');
eq('no BPM and no loudness -> null', M.tempoFromBpm(null), null);
eq('loudness alone still gives a value', M.tempoFromBpm(null, -8), '10');
ok('a loud track scores higher than a quiet one at the same BPM',
  Number(M.tempoFromBpm(120, -8)) > Number(M.tempoFromBpm(120, -26)),
  { loud: M.tempoFromBpm(120, -8), quiet: M.tempoFromBpm(120, -26) });

// ---------- genre ----------
console.log('\ngenre');
// A plain rock track. Note the autotagger numbers: even for obvious rock the tags stay small,
// because they are independent sigmoids. v1 averaged 0.72 with 0.32 and fell under its own gate.
const rock = {
  'genre_tzanetakis': model(TZ, { roc: 0.72, met: 0.10, pop: 0.09, cla: 0.01 }),
  'genre_rosamerica': model(RO, { roc: 0.80, pop: 0.08, dan: 0.04 }),
  'msd-musicnn': model(MSD, { rock: 0.32, 'classic rock': 0.21, 'hard rock': 0.12, pop: 0.06, instrumental: 0.05 })
};
let g = M.mapGenre(rock, { foldedBpm: 130 });
eq('obvious rock is called rock', g.value, 'rock');
ok('rock is confident', g.score > 0.9, g.scores);

const rap = {
  'genre_tzanetakis': model(TZ, { hip: 0.66, pop: 0.12, roc: 0.05 }),
  'genre_rosamerica': model(RO, { hip: 0.71, spe: 0.08, pop: 0.06 }),
  'msd-musicnn': model(MSD, { 'Hip-Hop': 0.41, pop: 0.09, rock: 0.03, instrumental: 0.02 })
};
eq('obvious rap is called rap', M.mapGenre(rap, {}).value, 'rap');

const classical = {
  'genre_tzanetakis': model(TZ, { cla: 0.88, jaz: 0.04, pop: 0.01 }),
  'genre_rosamerica': model(RO, { cla: 0.91, jaz: 0.03 }),
  // the autotagger has no "classical" tag: it must abstain, not vote classical down
  'msd-musicnn': model(MSD, { instrumental: 0.55, ambient: 0.2, rock: 0.04, pop: 0.03, 'Hip-Hop': 0.01 })
};
eq('classical survives the autotagger having no classical tag', M.mapGenre(classical, {}).value, 'classical');

// a rap track where tzanetakis leaks some "cla" must not become classical
const notClassical = {
  'genre_tzanetakis': model(TZ, { hip: 0.55, cla: 0.20, pop: 0.10 }),
  'msd-musicnn': model(MSD, { 'Hip-Hop': 0.38, instrumental: 0.02, rock: 0.04 })
};
eq('a rap track with some "cla" leak stays rap', M.mapGenre(notClassical, {}).value, 'rap');

// jazz: none of our four buckets fit perfectly, but with 0 threshold it picks the highest score
const jazz = {
  'genre_tzanetakis': model(TZ, { jaz: 0.78, blu: 0.09, cla: 0.05, pop: 0.03, roc: 0.02 }),
  'genre_rosamerica': model(RO, { jaz: 0.82, cla: 0.05, pop: 0.04 }),
  'msd-musicnn': model(MSD, { jazz: 0.30, soul: 0.1, instrumental: 0.25, pop: 0.04, rock: 0.03 })
};
g = M.mapGenre(jazz, {});
eq('jazz is now guessed as classical due to 0 threshold', g.value, 'classical');

const ambiguous = {
  'genre_tzanetakis': model(TZ, { pop: 0.38, roc: 0.36, dis: 0.1 }),
  'msd-musicnn': model(MSD, { pop: 0.28, rock: 0.27, instrumental: 0.03 })
};
eq('a 50/50 pop-rock track now picks pop', M.mapGenre(ambiguous, {}).value, 'pop');

eq('no models at all -> Unknown', M.mapGenre({}, {}).value, null);

// ---------- mood ----------
console.log('\nmood');
const sadSong = {
  'msd-musicnn': model(MSD, { sad: 0.34, beautiful: 0.15, Mellow: 0.12, happy: 0.03, party: 0.01 }),
  'mood_sad': binary('sad', 0.86),
  'mood_relaxed': binary('relaxed', 0.44),
  'mood_happy': binary('happy', 0.12),
  'mood_party': binary('party', 0.06),
  'mood_aggressive': binary('aggressive', 0.04)
};
eq('a sad ballad is called sad',
  M.mapMood(sadSong, { foldedBpm: 72, rmsDb: -20, scale: 'minor', keyStrength: 0.7 }).value, 'sad');

const banger = {
  'msd-musicnn': model(MSD, { party: 0.40, dance: 0.35, happy: 0.2, rock: 0.1, sad: 0.02 }),
  'mood_sad': binary('sad', 0.06),
  'mood_relaxed': binary('relaxed', 0.08),
  'mood_happy': binary('happy', 0.55),
  'mood_party': binary('party', 0.91),
  'mood_aggressive': binary('aggressive', 0.30)
};
eq('a club track is called energetic',
  M.mapMood(banger, { foldedBpm: 128, rmsDb: -9, scale: 'major', keyStrength: 0.6 }).value, 'energetic');

const chill = {
  'msd-musicnn': model(MSD, { chill: 0.33, chillout: 0.3, Mellow: 0.22, acoustic: 0.2, party: 0.02, sad: 0.08 }),
  'mood_sad': binary('sad', 0.22),
  'mood_relaxed': binary('relaxed', 0.88),
  'mood_happy': binary('happy', 0.35),
  'mood_party': binary('party', 0.04),
  'mood_aggressive': binary('aggressive', 0.02)
};
eq('a chill track is called relaxed', M.mapMood(chill, { foldedBpm: 88, rmsDb: -22 }).value, 'relaxed');

const romantic = {
  'msd-musicnn': model(MSD, { beautiful: 0.42, sexy: 0.3, Mellow: 0.28, soul: 0.2, sad: 0.12, party: 0.01 }),
  'mood_sad': binary('sad', 0.30),
  'mood_relaxed': binary('relaxed', 0.62),
  'mood_happy': binary('happy', 0.34),
  'mood_party': binary('party', 0.03)
};
const rm = M.mapMood(romantic, { foldedBpm: 76, rmsDb: -19, scale: 'minor', keyStrength: 0.5 });
ok('a soft "beautiful/sexy" song scores romantic highly', rm.scores.romantic > 0.6, rm.scores);

ok('the minor-key nudge moves sad up', (function () {
  const a = M.mapMood(sadSong, { foldedBpm: 72, rmsDb: -20, scale: 'major', keyStrength: 0.8 }).scores.sad;
  const b = M.mapMood(sadSong, { foldedBpm: 72, rmsDb: -20, scale: 'minor', keyStrength: 0.8 }).scores.sad;
  return b > a;
})(), 'no movement');

eq('no mood models -> Unknown', M.mapMood({}, {}).value, null);

// ---------- language ----------
console.log('\nlanguage');
const withVocals = { 'msd-musicnn': model(MSD, { instrumental: 0.08, pop: 0.2 }) };
const instrumentalOnly = { 'msd-musicnn': model(MSD, { instrumental: 0.82, ambient: 0.3 }) };

eq('three Hindi windows -> hindi', M.mapLanguage({
  windows: [{ code: 'hi', prob: 0.92 }, { code: 'hi', prob: 0.88 }, { code: 'hi', prob: 0.75 }]
}, withVocals).value, 'hindi');

eq('Urdu maps to sufi', M.mapLanguage({
  windows: [{ code: 'ur', prob: 0.8 }, { code: 'ur', prob: 0.7 }]
}, withVocals).value, 'sufi');

eq('English is english', M.mapLanguage({
  windows: [{ code: 'en', prob: 0.95 }, { code: 'en', prob: 0.9 }]
}, withVocals).value, 'english');

eq('Spanish falls into others', M.mapLanguage({
  windows: [{ code: 'es', prob: 0.9 }, { code: 'es', prob: 0.85 }]
}, withVocals).value, 'others');

let l = M.mapLanguage({ windows: [{ code: 'hi', prob: 0.9 }, { code: 'en', prob: 0.85 }, { code: 'ta', prob: 0.8 }] }, withVocals);
eq('windows that disagree now pick the top one', l.value, 'hindi');

eq('low confidence now picks the top one', M.mapLanguage({
  windows: [{ code: 'hi', prob: 0.3 }, { code: 'hi', prob: 0.35 }]
}, withVocals).value, 'hindi');

l = M.mapLanguage({ windows: [{ code: 'en', prob: 0.9 }], instrumental: 0.82 }, instrumentalOnly);
eq('an instrumental track now gets a language anyway', l.value, 'english');

eq('agreement alone is enough when no probability came back', M.mapLanguage({
  windows: [{ code: 'hi', prob: null }, { code: 'hi', prob: null }]
}, withVocals).value, 'hindi');

eq('Arabic maps to sufi', M.mapLanguage({
  windows: [{ code: 'ar', prob: 0.85 }, { code: 'ar', prob: 0.9 }]
}, withVocals).value, 'sufi');

// ---------- summarise + patching ----------
console.log('\nsummarise / buildPatch');
const raw = {
  bpm: 92, bpmConfidence: 3.2, rmsDb: -12, scale: 'minor', keyStrength: 0.6, danceability: 1.1,
  models: Object.assign({}, rock, sadSong),
  language: { windows: [{ code: 'hi', prob: 0.9 }, { code: 'hi', prob: 0.85 }], instrumental: 0.05 }
};
const r = M.summarise(raw);
eq('summarise fills genre', r.genre, 'rock');
eq('summarise fills language', r.language, 'hindi');
ok('summarise fills tempo', /^([1-9]|10)$/.test(r.tempo), r.tempo);
ok('details carry the reasoning', !!r.details.genre.scores && !!r.details.language.votes, Object.keys(r.details));

let out = M.buildPatch({ genre: '', mood: 'happy', language: '', tempo: '5' }, r);
eq('a known mood is never overwritten', out.patch.mood, undefined);
eq('an unknown genre is filled', out.patch.genre, 'rock');
eq('tempo is filled when the song was never analysed', out.patch.tempo, r.tempo);
ok('autoFilled marks only what we filled',
  out.patch.autoFilled.genre === true && out.patch.autoFilled.mood === undefined, out.patch.autoFilled);

out = M.buildPatch({ genre: 'pop', mood: 'sad', language: 'hindi', tempo: '5', tempoSet: true }, r);
eq('a hand-set tempo of 5 is respected', out.patch.tempo, undefined);
eq('nothing to fill still marks the song analysed', out.patch.analysed, true);
eq('and fills nothing else', out.filled.length, 0);

out = M.buildPatch({ genre: 'Unknown', tempo: '5', analysed: true }, r);
eq('"Unknown" counts as blank', out.patch.genre, 'rock');
eq('but tempo 5 on an already-analysed song is left alone', out.patch.tempo, undefined);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
