/**
 * analyzer-map.js (v2): turns raw Essentia / Whisper output into the app's own labels.
 *
 * Pure functions, no browser or Node APIs, so the same file runs in the page and in unit tests.
 * All tuning knobs live in CONFIG. Change them here, no other file needs touching.
 *
 * App vocabulary:
 *   genre    : pop | rock | classical | rap
 *   mood     : happy | sad | relaxed | energetic | romantic
 *   tempo    : "1".."10"   (stored field name; UI label is Volume — mapped from RMS loudness)
 *   language : hindi | english | others        ("sufi" is never auto-filled, see LANGUAGE below)
 *
 * WHAT CHANGED FROM v1 (and why)
 * ------------------------------
 * v1 averaged raw numbers from sources that live on completely different scales:
 *   - genre_tzanetakis / genre_rosamerica are softmax heads: the winner is often 0.6-0.95.
 *   - msd-musicnn is a 50-tag sigmoid autotagger: even for an obvious rock song the "rock"
 *     tag usually sits around 0.15-0.45, because the tags are independent probabilities.
 * Averaging those and then demanding >= 0.35 meant the autotagger dragged almost everything
 * below the threshold, so nearly every song came out "Unknown".
 *
 * v2 asks each source for a *shape* instead of a number:
 *   rel[bucket]  = raw[bucket] / (best bucket of that source)   -> winner is 1.0
 *   strength     = how much that source actually knows about this song
 *                  (softmax: how much probability mass landed inside our 4 buckets;
 *                   autotagger: how strong its best relevant tag is against TAG_REF)
 * Buckets are then a strength-weighted mean of the sources that can express them, so a source
 * that cannot vote for "classical" does not silently punish classical.
 *
 * Also new: key/scale, RMS loudness and danceability are used as cues, and language mapping.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnalyzerMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    bpm: {
      foldMin: 60,      // still used for mood "energetic" cues
      foldMax: 180,
      // Volume (1–10) is RMS loudness only. BPM is a last-resort fallback if rmsDb is missing.
      // Typical maps: quiet ≈ −24 dB → 1 · mid ≈ −17 dB → 5 · hot ≈ −10 dB → 10.
      scaleMin: 75,     // BPM fallback only
      scaleMax: 140,
      loudnessWeight: 1.0, // Volume slider = pure loudness
      loudMinDb: -24,
      loudMaxDb: -10
    },

    genre: {
      minScore: 0.0,    // User requested to never leave genre blank
      minMargin: 0.0,
      minEvidence: 0.0,
      tagRef: 0.30,     // an msd-musicnn tag at this value counts as a full-strength vote
      weights: { genre_tzanetakis: 1.0, genre_rosamerica: 1.0, 'msd-musicnn': 0.8 },
      // Classical is the one bucket a single model decides, so it gets one sanity check:
      // if the autotagger is sure the track is not instrumental, damp classical.
      classicalInstrumentalFloor: 0.10,
      classicalDamp: 0.55
    },

    mood: {
      minScore: 0.0,    // User requested to never leave mood blank
      minMargin: 0.0,
      tagRef: 0.30,
      romanticWeight: 0.85,  // romantic is the weakest signal, so it is damped
      minorBoost: 0.06,      // minor key nudges sad/romantic, major nudges happy
      bpmWeight: 0.25        // how much tempo/energy counts towards "energetic"
    },

    language: {
      minProb: 0.0,          // User requested to never leave language blank
      minAgreement: 0.0,     // just take whichever language got the most votes
      // Whisper language code -> app value. Anything not listed becomes "others".
      // Urdu maps to hindi (user preference). Arabic / Persian / Pashto stay "sufi".
      map: {
        hi: 'hindi', mr: 'hindi', ne: 'hindi', ur: 'hindi',  // Hindi + Urdu
        en: 'english',
        ar: 'sufi', fa: 'sufi', ps: 'sufi'
      },
      never: [],
      // Raised from 0.80 to 0.99: almost NEVER skip the language pass just because
      // the track sounds "instrumental", as the model is often wrong for nasheeds.
      instrumentalCeiling: 0.99
    }
  };

  // ---- small helpers ------------------------------------------------------------
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /** Value of one class from a model result ({classes, mean}); null if the model/class is missing. */
  function cls(model, name) {
    if (!model || !model.classes || !model.mean) return null;
    var i = model.classes.indexOf(name);
    return i >= 0 && isNum(model.mean[i]) ? model.mean[i] : null;
  }

  /** Probability of the "positive" class of a binary head such as mood_sad ("sad" vs "non_sad"). */
  function positive(model, moodName) {
    if (!model || !model.classes || !model.mean) return null;
    var i = model.classes.indexOf(moodName);
    if (i < 0 && model.classes.length === 2) {
      // fall back to "the class that is not the non_* one"
      i = /^non?[_\- ]/i.test(String(model.classes[0])) ? 1 : 0;
    }
    return i >= 0 && isNum(model.mean[i]) ? model.mean[i] : null;
  }

  function nums(list) { return (list || []).filter(isNum); }
  function avg(list) {
    var v = nums(list);
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }
  function sum(list) {
    var v = nums(list);
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) : null;
  }
  function maxOf(list) {
    var v = nums(list);
    return v.length ? Math.max.apply(null, v) : null;
  }
  function scaled(x, k) { return isNum(x) ? x * k : null; }

  /** Mean over patches: [[...],[...]] -> [...] */
  function meanPatches(preds) {
    if (!preds || !preds.length) return [];
    if (typeof preds[0] === 'number') return preds.slice();
    var n = preds[0].length, out = new Array(n).fill(0), p, i;
    for (p = 0; p < preds.length; p++) for (i = 0; i < n; i++) out[i] += preds[p][i];
    for (i = 0; i < n; i++) out[i] /= preds.length;
    return out;
  }

  // ---- volume (stored as song.tempo, UI label "Volume") ----------------------------
  function foldBpm(bpm) {
    if (!isNum(bpm) || bpm <= 0) return null;
    var lo = CONFIG.bpm.foldMin, hi = CONFIG.bpm.foldMax, guard = 0;
    while (bpm < lo && guard++ < 10) bpm *= 2;
    while (bpm >= hi && guard++ < 20) bpm /= 2;
    return bpm;
  }

  function loudnessUnit(rmsDb) {
    if (!isNum(rmsDb)) return null;
    var c = CONFIG.bpm;
    return clamp((rmsDb - c.loudMinDb) / (c.loudMaxDb - c.loudMinDb), 0, 1);
  }

  /**
   * Map analysis → the app's 1..10 Volume slider (field name remains `tempo` for storage).
   * Primary signal is RMS loudness. BPM is only used if rmsDb is missing.
   */
  function tempoFromBpm(bpm, rmsDb) {
    var loud = loudnessUnit(rmsDb);
    var c = CONFIG.bpm;
    var x = loud;
    if (x === null) {
      // No loudness reading — weak BPM fallback so the field is not left blank.
      var b = foldBpm(bpm);
      if (b === null) return null;
      x = clamp((b - c.scaleMin) / (c.scaleMax - c.scaleMin), 0, 1);
    }
    return String(Math.round(1 + 9 * clamp(x, 0, 1)));
  }

  // ---- generic "pick the best label" -------------------------------------------------
  function pick(scores, minScore, minMargin, evidence, minEvidence) {
    var entries = Object.keys(scores)
      .filter(function (k) { return isNum(scores[k]); })
      .map(function (k) { return [k, scores[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    if (!entries.length) return { value: null, score: 0, best: null, scores: scores, evidence: 0, why: 'no model output' };
    var top = entries[0], second = entries[1] ? entries[1][1] : 0;
    var why = null;
    if (isNum(minEvidence) && isNum(evidence) && evidence < minEvidence) why = 'models had little to say (evidence ' + evidence.toFixed(2) + ')';
    else if (top[1] < minScore) why = 'best score ' + top[1].toFixed(2) + ' is below ' + minScore;
    else if (top[1] - second < minMargin) why = 'too close to ' + (entries[1] ? entries[1][0] : 'nothing') + ' (' + (top[1] - second).toFixed(2) + ' < ' + minMargin + ')';
    return {
      value: why ? null : top[0],
      score: top[1],
      best: top[0],
      margin: top[1] - second,
      evidence: isNum(evidence) ? evidence : null,
      scores: scores,
      why: why
    };
  }

  /**
   * Combine several sources that each provide { support: [buckets], raw: {bucket: value},
   * strength: 0..1, weight: number } into one calibrated score per bucket.
   * A source only counts towards the buckets it can express.
   */
  function combine(buckets, sources) {
    var scores = {}, perSource = {};
    var totalStrength = 0, totalWeight = 0;

    sources.forEach(function (s) {
      var best = maxOf(buckets.map(function (b) { return s.support.indexOf(b) >= 0 ? s.raw[b] : null; }));
      s._rel = {};
      buckets.forEach(function (b) {
        if (s.support.indexOf(b) < 0) return;
        s._rel[b] = isNum(s.raw[b]) && isNum(best) && best > 0 ? clamp(s.raw[b] / best, 0, 1) : (isNum(s.raw[b]) ? 0 : null);
      });
      perSource[s.name] = { rel: s._rel, strength: s.strength, raw: s.raw };
      totalStrength += (s.strength || 0) * (s.weight || 1);
      totalWeight += (s.weight || 1);
    });

    buckets.forEach(function (b) {
      var num = 0, den = 0;
      sources.forEach(function (s) {
        if (!isNum(s._rel[b]) || !isNum(s.strength)) return;
        var w = (s.weight || 1) * s.strength;
        num += w * s._rel[b];
        den += w;
      });
      scores[b] = den > 0 ? num / den : null;
    });

    return { scores: scores, perSource: perSource, evidence: totalWeight > 0 ? totalStrength / totalWeight : 0 };
  }

  // ---- genre -------------------------------------------------------------------------
  var GENRE_BUCKETS = ['pop', 'rock', 'classical', 'rap'];

  /** Softmax head -> {raw, strength}. strength = probability mass that landed in our buckets. */
  function softmaxSource(name, model, mapping, weight) {
    if (!model) return null;
    var raw = {}, support = [];
    Object.keys(mapping).forEach(function (bucket) {
      var v = sum(mapping[bucket].map(function (pair) { return scaled(cls(model, pair[0]), pair[1]); }));
      if (v !== null) { raw[bucket] = v; support.push(bucket); }
    });
    if (!support.length) return null;
    var mass = sum(support.map(function (b) { return raw[b]; })) || 0;
    return { name: name, raw: raw, support: support, strength: clamp(mass, 0, 1), weight: weight };
  }

  function mapGenre(models, extra) {
    extra = extra || {};
    var tz = models['genre_tzanetakis'];   // blu cla cou dis hip jaz met pop reg roc
    var ro = models['genre_rosamerica'];   // cla dan hip jaz pop rhy roc spe
    var ms = models['msd-musicnn'];        // 50 autotagging tags (independent probabilities)
    var g = CONFIG.genre;
    var sources = [];

    var tzSrc = softmaxSource('genre_tzanetakis', tz, {
      pop: [['pop', 1], ['dis', 0.5]],
      rock: [['roc', 1], ['met', 0.9]],
      classical: [['cla', 1]],
      rap: [['hip', 1]]
    }, g.weights.genre_tzanetakis);
    if (tzSrc) sources.push(tzSrc);

    var roSrc = softmaxSource('genre_rosamerica', ro, {
      pop: [['pop', 1], ['dan', 0.5], ['rhy', 0.5]],
      rock: [['roc', 1]],
      classical: [['cla', 1]],
      rap: [['hip', 1], ['spe', 0.4]]
    }, g.weights.genre_rosamerica);
    if (roSrc) sources.push(roSrc);

    if (ms) {
      // The autotagger has no "classical" tag, so classical is not in its support: it abstains
      // there instead of voting against it.
      var raw = {
        pop: maxOf([cls(ms, 'pop'), cls(ms, 'indie pop'), scaled(cls(ms, 'catchy'), 0.8), scaled(cls(ms, 'dance'), 0.6)]),
        rock: maxOf([cls(ms, 'rock'), cls(ms, 'alternative rock'), cls(ms, 'classic rock'), cls(ms, 'hard rock'),
          cls(ms, 'indie rock'), cls(ms, 'punk'), cls(ms, 'metal'), cls(ms, 'heavy metal'), cls(ms, 'Progressive rock'),
          scaled(cls(ms, 'alternative'), 0.8)]),
        rap: cls(ms, 'Hip-Hop')
      };
      var support = Object.keys(raw).filter(function (k) { return isNum(raw[k]); });
      if (support.length) {
        var best = maxOf(support.map(function (k) { return raw[k]; }));
        sources.push({
          name: 'msd-musicnn',
          raw: raw,
          support: support,
          strength: clamp(best / g.tagRef, 0, 1),   // sigmoid tags are small; scale against tagRef
          weight: g.weights['msd-musicnn']
        });
      }
    }

    var out = combine(GENRE_BUCKETS, sources);
    var scores = out.scores;

    // Classical sanity check: it rests on one model, so a confidently non-instrumental track
    // (rapping, a full band, a singer over a beat) should not land there on a weak "cla".
    var instrumental = cls(ms, 'instrumental');
    if (isNum(scores.classical) && isNum(instrumental) && instrumental < g.classicalInstrumentalFloor) {
      scores.classical *= g.classicalDamp;
      out.classicalDamped = true;
    }
    // A strong, steady beat is also evidence against classical.
    if (isNum(scores.classical) && isNum(extra.danceability) && extra.danceability > 1.2) {
      scores.classical *= 0.8;
      out.classicalDamped = true;
    }

    var res = pick(scores, g.minScore, g.minMargin, out.evidence, g.minEvidence);
    res.perSource = out.perSource;
    res.classicalDamped = !!out.classicalDamped;
    return res;
  }

  // ---- mood --------------------------------------------------------------------------
  // Moods the ML pipeline can auto-assign. "devotional" is manual-only.
  var MOOD_BUCKETS = ['happy', 'sad', 'relaxed', 'energetic', 'romantic', 'bittersweet'];

  function mapMood(models, extra) {
    extra = extra || {};
    var ms = models['msd-musicnn'];
    var m = CONFIG.mood;
    var foldedBpm = extra.foldedBpm;

    var pHappy = positive(models['mood_happy'], 'happy');
    var pSad = positive(models['mood_sad'], 'sad');
    var pRelaxed = positive(models['mood_relaxed'], 'relaxed');
    var pParty = positive(models['mood_party'], 'party');
    var pAggressive = positive(models['mood_aggressive'], 'aggressive');

    var bpmEnergy = isNum(foldedBpm) ? clamp((foldedBpm - 90) / 60, 0, 1) : null;
    var loud = loudnessUnit(extra.rmsDb);
    var energyCue = avg([bpmEnergy, loud]);

    var sources = [];

    // 1) the dedicated binary mood heads (softmax-ish, directly comparable to each other)
    var headRaw = {
      happy: pHappy,
      sad: pSad,
      relaxed: pRelaxed,
      energetic: maxOf([pParty, pAggressive])
    };
    var headSupport = Object.keys(headRaw).filter(function (k) { return isNum(headRaw[k]); });
    if (headSupport.length) {
      sources.push({
        name: 'mood heads',
        raw: headRaw,
        support: headSupport,
        strength: clamp(maxOf(headSupport.map(function (k) { return headRaw[k]; })), 0, 1),
        weight: 1.0
      });
    }

    // 2) the autotagger's mood-ish tags
    if (ms) {
      var tagRaw = {
        happy: maxOf([cls(ms, 'happy'), scaled(cls(ms, 'catchy'), 0.6)]),
        sad: cls(ms, 'sad'),
        relaxed: maxOf([cls(ms, 'chill'), cls(ms, 'chillout'), cls(ms, 'Mellow'),
          scaled(cls(ms, 'easy listening'), 0.8), scaled(cls(ms, 'ambient'), 0.7), scaled(cls(ms, 'acoustic'), 0.5)]),
        energetic: maxOf([cls(ms, 'party'), scaled(cls(ms, 'dance'), 0.8), scaled(cls(ms, 'hard rock'), 0.6),
          scaled(cls(ms, 'heavy metal'), 0.6), scaled(cls(ms, 'punk'), 0.6)]),
        romantic: maxOf([cls(ms, 'beautiful'), scaled(cls(ms, 'sexy'), 0.9), scaled(cls(ms, 'soul'), 0.5)])
      };
      var tagSupport = Object.keys(tagRaw).filter(function (k) { return isNum(tagRaw[k]); });
      if (tagSupport.length) {
        sources.push({
          name: 'msd-musicnn',
          raw: tagRaw,
          support: tagSupport,
          strength: clamp(maxOf(tagSupport.map(function (k) { return tagRaw[k]; })) / m.tagRef, 0, 1),
          weight: 0.9
        });
      }
    }

    // 3) tempo + loudness: only speaks about "energetic" vs "relaxed"
    if (isNum(energyCue)) {
      sources.push({
        name: 'tempo/loudness',
        raw: { energetic: energyCue, relaxed: 1 - energyCue },
        support: ['energetic', 'relaxed'],
        strength: m.bpmWeight,
        weight: 1.0
      });
    }

    var out = combine(MOOD_BUCKETS, sources);
    var scores = out.scores;

    // romantic is not a model output, it is a shape: soft, gentle, "beautiful / mellow", slow.
    if (ms) {
      var feel = maxOf([cls(ms, 'beautiful'), cls(ms, 'sexy')]);
      var parts = [
        scaled(clamp(isNum(feel) ? feel / m.tagRef : null, 0, 1), 0.45),
        scaled(clamp(isNum(cls(ms, 'Mellow')) ? cls(ms, 'Mellow') / m.tagRef : null, 0, 1), 0.2),
        scaled(pRelaxed, 0.2),
        isNum(energyCue) ? 0.15 * (1 - energyCue) : null
      ];
      var total = sum(parts);
      var romantic = isNum(total) ? clamp(total, 0, 1) * m.romanticWeight : null;
      // keep whichever is higher: the tag-driven vote above or this shaped estimate
      scores.romantic = maxOf([scores.romantic, romantic]);
    }

    // key/scale nudge: minor leans sad/romantic, major leans happy. Small on purpose.
    if (extra.scale === 'minor' || extra.scale === 'major') {
      var k = extra.scale === 'minor' ? 1 : -1;
      var strength = clamp(isNum(extra.keyStrength) ? extra.keyStrength : 0.5, 0, 1);
      var delta = m.minorBoost * strength * k;
      if (isNum(scores.sad)) scores.sad = clamp(scores.sad + delta, 0, 1);
      if (isNum(scores.romantic)) scores.romantic = clamp(scores.romantic + delta * 0.5, 0, 1);
      if (isNum(scores.happy)) scores.happy = clamp(scores.happy - delta, 0, 1);
    }

    // ---- bittersweet detection ---------------------------------------------------------
    // Fires when sad, happy, and energetic are ALL significantly high at the same time.
    // This is the signature of Bollywood/OST/power-ballad tracks: emotionally intense,
    // neither purely happy nor purely sad, with driving energy underneath.
    // The threshold is set so that it only beats the individual buckets when all three
    // are genuinely elevated (each ≥ 0.50) — avoiding false positives on merely "mixed" tracks.
    var sBittersweet = (function () {
      var s = scores.sad, h = scores.happy, e = scores.energetic;
      if (!isNum(s) || !isNum(h) || !isNum(e)) return null;
      // geometric-mean-like: all three must be strong for this to score high
      var weakest = Math.min(s, h, e);
      if (weakest < 0.45) return null;  // at least one pillar is absent — not bittersweet
      return clamp((s + h + e) / 3 * 1.15, 0, 1);  // slight boost so it can outbid the runner-up
    })();
    if (isNum(sBittersweet)) scores.bittersweet = sBittersweet;

    var res = pick(scores, m.minScore, m.minMargin, out.evidence, null);
    res.perSource = out.perSource;
    return res;
  }

  // ---- language ----------------------------------------------------------------------
  /**
   * lang = { windows: [{ code, prob }], instrumental: 0..1 }  (from the Whisper pass)
   * Returns { value, code, prob, agreement, why, votes }.
   */
  function mapLanguage(lang, models) {
    var c = CONFIG.language;
    var ms = models && models['msd-musicnn'];
    var instrumental = lang && isNum(lang.instrumental) ? lang.instrumental : cls(ms, 'instrumental');

    if (!lang || !lang.windows || !lang.windows.length) {
      return { value: null, code: null, prob: null, agreement: 0, votes: {}, why: 'no language pass' };
    }
    if (isNum(instrumental) && instrumental > c.instrumentalCeiling) {
      return { value: null, code: null, prob: null, agreement: 0, votes: {}, why: 'sounds instrumental (' + instrumental.toFixed(2) + ')' };
    }

    // vote per window, weighted by the model's own confidence
    var votes = {}, totalW = 0;
    lang.windows.forEach(function (w) {
      if (!w || !w.code) return;
      var p = isNum(w.prob) ? w.prob : 0.5;
      votes[w.code] = (votes[w.code] || 0) + p;
      totalW += p;
    });
    var codes = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; });
    if (!codes.length || totalW <= 0) {
      return { value: null, code: null, prob: null, agreement: 0, votes: votes, why: 'no window produced a language' };
    }

    var code = codes[0];
    var agreement = votes[code] / totalW;
    var prob = avg(lang.windows.filter(function (w) { return w.code === code; }).map(function (w) { return w.prob; }));

    var why = null;
    if (isNum(prob) && prob < c.minProb) why = 'low confidence (' + prob.toFixed(2) + ')';
    else if (agreement < c.minAgreement) why = 'windows disagreed (' + Math.round(agreement * 100) + '% for ' + code + ')';

    var value = c.map[code] || 'others';
    if (c.never.indexOf(value) >= 0) value = null;

    return {
      value: why ? null : value,
      code: code,
      prob: prob,
      agreement: agreement,
      votes: votes,
      instrumental: instrumental,
      why: why
    };
  }

  // ---- everything together -----------------------------------------------------------
  /**
   * raw = {
   *   bpm, bpmConfidence, danceability, rmsDb, key, scale, keyStrength,
   *   models: { name: { classes, mean, patches } },
   *   language: { windows: [{code, prob}], instrumental }
   * }
   * returns { bpm, foldedBpm, tempo, genre, mood, language, details }
   */
  function summarise(raw) {
    raw = raw || {};
    var models = raw.models || {};
    var folded = foldBpm(raw.bpm);
    var extra = {
      foldedBpm: folded,
      rmsDb: raw.rmsDb,
      danceability: raw.danceability,
      scale: raw.scale,
      keyStrength: raw.keyStrength
    };
    var genre = mapGenre(models, extra);
    var mood = mapMood(models, extra);
    var language = mapLanguage(raw.language, models);

    // ---- Sufi / devotional heuristics -------------------------------------------------
    // When Whisper (or script-based fallback) identifies the song as Urdu / Arabic /
    // Persian ("sufi" in the app's vocabulary), Western ML genre and mood models are
    // unreliable because they were trained on Western music.  Apply two soft overrides:
    //
    //   GENRE: "rock" → "pop"
    //     Rock classifiers fire on high BPM and energetic RMS, which is common in
    //     qawwalis and nasheeds.  Sufi/devotional music is never rock in practice;
    //     pop is the closest well-fitting bucket.
    //
    //   MOOD:  null / "romantic" / "happy" / "energetic" → "devotional"
    //     "Romantic" and "happy" mood tags from Western models almost always misfire on
    //     devotional vocals.  If the model produced a confident "relaxed" or "sad"
    //     reading, keep it (those are sometimes accurate for slower naats).
    var finalGenre = genre.value;
    var finalMood  = mood.value;

    if (language.value === 'sufi') {
      // Rock classifiers often misfire on high-BPM nasheeds/qawwalis. Redirect to pop.
      if (finalGenre === 'rock') {
        finalGenre = 'pop';
      }
      // Mood is left to the ML — "devotional" is manual-only per user preference.
    }

    return {
      bpm: isNum(raw.bpm) ? raw.bpm : null,
      foldedBpm: folded,
      tempo: tempoFromBpm(raw.bpm, raw.rmsDb),
      genre: finalGenre,
      mood: finalMood,
      language: language.value,
      details: {
        genre: genre,
        mood: mood,
        language: language,
        bpmConfidence: raw.bpmConfidence,
        rmsDb: raw.rmsDb,
        key: raw.key,
        scale: raw.scale,
        keyStrength: raw.keyStrength,
        danceability: raw.danceability
      }
    };
  }

  // ---- "only fill what is still unknown" -------------------------------------------------
  function isBlank(v) {
    return v === undefined || v === null || String(v).trim() === '' || /^unknown$/i.test(String(v).trim());
  }

  /**
   * Which fields of this song may still be filled?
   * Tempo defaults to "5", which can't be told apart from a real 5. Treat it as unknown when:
   *   - the user has never set it by hand (song.tempoSet), AND
   *   - either the song has never been analysed, OR the value is still the default "5"
   *     (so a first analyse that left it at 5, or an older analyse that stripped tempo,
   *     can still be corrected on a later run).
   * Once the user edits tempo in the UI we set tempoSet and never overwrite it.
   */
  function unknownFields(song) {
    song = song || {};
    var tempoStillDefault = isBlank(song.tempo) || String(song.tempo) === '5';
    return {
      genre: isBlank(song.genre),
      mood: isBlank(song.mood),
      language: isBlank(song.language),
      tempo: !song.tempoSet && (!song.analysed || tempoStillDefault)
    };
  }

  /**
   * Build the fields to write. Never overwrites a known value.
   * returns { patch, filled }   patch always sets analysed/analysedAt so a failed-to-fill song
   * is not analysed again on every start.
   */
  function buildPatch(song, result) {
    var unk = unknownFields(song);
    var patch = {}, filled = [];
    ['genre', 'mood', 'language', 'tempo'].forEach(function (f) {
      if (unk[f] && result && result[f] !== null && result[f] !== undefined && result[f] !== '') {
        patch[f] = result[f];
        filled.push(f);
      }
    });
    var auto = {};
    for (var k in (song && song.autoFilled) || {}) auto[k] = song.autoFilled[k];
    filled.forEach(function (f) { auto[f] = true; });
    patch.analysed = true;
    patch.analysedAt = Date.now();
    patch.autoFilled = auto;
    if (result && result.bpm) patch.bpm = Math.round(result.bpm);
    return { patch: patch, filled: filled };
  }

  return {
    CONFIG: CONFIG,
    foldBpm: foldBpm,
    tempoFromBpm: tempoFromBpm,
    loudnessUnit: loudnessUnit,
    meanPatches: meanPatches,
    combine: combine,
    mapGenre: mapGenre,
    mapMood: mapMood,
    mapLanguage: mapLanguage,
    summarise: summarise,
    unknownFields: unknownFields,
    buildPatch: buildPatch,
    isBlank: isBlank
  };
});
