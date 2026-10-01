/**
 * Dotted, grainy "diffusion" visualizer - replaces the smooth wave line in #visualizer-canvas.
 *
 * How it works
 *   - The audio waveform is injected as "ink" into a small heat field (one cell = CELL_CSS px).
 *   - Every step the field diffuses (spreads + fades). On a beat it diffuses harder and drifts
 *     outward from the centre line, and a shock ring travels out along the wave.
 *   - Rendering is stochastic stippling: each cell becomes a dot with probability equal to its
 *     intensity, against a grain map that shifts over time. That is what makes it dotted and grainy,
 *     and why it shimmers instead of looking like a blurred line.
 *   - Colours come from the page's own theme (colorThemes[currentThemeIndex]).
 *
 * Integration (index.html). The page's main script runs inside a DOMContentLoaded closure, so its
 * variables are private - the page hands them to this module instead:
 *   <script src="/visualizer.js" defer></script>                      after the main script tag
 *   inside the main script, once analyser/source/audioCtx/colorThemes/currentThemeIndex exist:
 *       if (window.beatViz) window.beatViz.attach({ audioCtx, analyser, source,
 *                                                   getTheme: () => colorThemes[currentThemeIndex] });
 *   and at the very top of the original draw():
 *       if (window.beatViz && window.beatViz.active) return;
 * The guard stops the old line drawing. If this file fails to load or attach() fails, `active` stays
 * false and the original wave keeps working.
 *
 * Beat detection uses its OWN AnalyserNode (low smoothing) fed from `source`, because the page's
 * analyser uses smoothingTimeConstant 0.97, which smears drum hits.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('visualizer-canvas');
  var audio = document.getElementById('audio-player');
  if (!canvas || !audio) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  // ---- tunables ----------------------------------------------------------------
  var CELL_CSS = 2;          // grid cell size in CSS px; each dot is ~60% of a cell, jittered inside it
  var STEP = 1 / 60;         // simulation step (s) - fixed so it looks the same at 60/144 Hz
  var DECAY_PLAY = 0.88;     // field decay per step while playing
  var DECAY_IDLE = 0.85;     // ...and when paused
  var DIFF_X = 0.035;        // horizontal diffusion
  var DIFF_Y = 0.055;        // vertical diffusion between beats (beats add more, so the line blooms)
  var BEAT_MIN_GAP = 0.18;   // s between beats
  var GRAIN_HZ = 24;         // how often the grain pattern re-rolls

  // ---- audio taps (bound in attach()) -----------------------------------------------
  var actx = null, an = null, timeBuf = null, freqBuf = null, bass = [1, 4], getTheme = null;

  function binRange(loHz, hiHz) {
    var hzPerBin = (actx ? actx.sampleRate : 44100) / an.fftSize;
    return [Math.max(1, Math.round(loHz / hzPerBin)), Math.max(2, Math.round(hiHz / hzPerBin))];
  }

  // ---- state ---------------------------------------------------------------------
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var cellDev = 3, W = 0, H = 0, cy = 0, offX = 0, offY = 0;
  var f = null, g = null, wave = null, wave2 = null, img = null, px = null;
  var grain = new Uint8Array(1024);
  for (var gi = 0; gi < grain.length; gi++) grain[gi] = (Math.random() * 256) | 0;
  var grainShift = 0, grainClock = 0;

  var pulse = 0, rings = [];
  var peakAvg = 0.2, level = 0, avgE = 0, lastBeat = -1, beats = 0;
  var maxF = 0, acc = 0, last = 0, lastRender = 0;
  var colCache = { key: '', from: [61, 139, 255], to: [207, 230, 255] };

  function hexToRgb(h, fallback) {
    var m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    if (!m) return fallback;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function theme() {
    var t = null;
    try { if (getTheme) t = getTheme(); } catch (e) { /* not ready */ }
    var key = t ? t.from + '|' + t.to : '';
    if (key !== colCache.key) {
      colCache.key = key;
      colCache.from = hexToRgb(t && t.from, [61, 139, 255]);
      colCache.to = hexToRgb(t && t.to, [207, 230, 255]);
    }
    return colCache;
  }

  // ---- sizing ----------------------------------------------------------------------
  function ensureSize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var tw = Math.round(canvas.clientWidth * dpr);
    var th = Math.round(canvas.clientHeight * dpr);
    if (tw < 8 || th < 8) return false;
    // index.html's own resize code sets width/height to CSS px; we want device px.
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th; }
    var cd = Math.max(2, Math.round(CELL_CSS * dpr));
    var w = Math.floor(tw / cd), h = Math.floor(th / cd);
    if (!img || w !== W || h !== H || cd !== cellDev || img.width !== tw || img.height !== th) {
      cellDev = cd; W = w; H = h; cy = (H - 1) / 2;
      offX = (tw - W * cd) >> 1; offY = (th - H * cd) >> 1;
      f = new Float32Array(W * H); g = new Float32Array(W * H); wave = new Float32Array(W); wave2 = new Float32Array(W);
      img = ctx.createImageData(tw, th); px = new Uint32Array(img.data.buffer);
    }
    return true;
  }

  // ---- audio analysis ----------------------------------------------------------------
  function analyse(now) {
    an.getByteTimeDomainData(timeBuf);
    an.getByteFrequencyData(freqBuf);

    var n = timeBuf.length, sumSq = 0, peak = 0, i;
    for (i = 0; i < n; i++) {
      var v = (timeBuf[i] - 128) / 128;
      sumSq += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    level = Math.sqrt(sumSq / n);
    peakAvg = Math.max(peak, peakAvg * 0.996);          // slow auto-gain

    // spread the first half of the buffer across the columns, lightly smoothed
    var span = n / 2 - 2;
    for (var x = 0; x < W; x++) {
      var t = 1 + (x / (W - 1)) * span;
      var i0 = t | 0;
      var raw = ((timeBuf[i0] + timeBuf[i0 + 1]) * 0.5 - 128) / 128;
      wave[x] += (raw - wave[x]) * 0.16;          // heavy temporal smoothing, like the original line
    }
    for (x = 0; x < W; x++) {                      // + 3-tap smoothing across columns
      wave2[x] = (wave[Math.max(0, x - 1)] + 2 * wave[x] + wave[Math.min(W - 1, x + 1)]) * 0.25;
    }

    // beat = bass energy jumps above its running average
    var e = 0;
    for (i = bass[0]; i <= bass[1]; i++) e += freqBuf[i];
    e /= (bass[1] - bass[0] + 1) * 255;
    if (!reduce.matches && e > 0.12 && e > avgE * 1.28 + 0.035 && now / 1000 - lastBeat > BEAT_MIN_GAP) {
      lastBeat = now / 1000;
      beats++;
      pulse = 1;
      rings.push({ r: 0 });
      if (rings.length > 3) rings.shift();
    }
    avgE += (e - avgE) * 0.06;
  }

  // ---- simulation ------------------------------------------------------------------------
  function step(playing) {
    var x, y, i;

    if (playing) {
      var norm = Math.max(peakAvg, 0.22);
      var amp = H * 0.44 * (0.5 + 0.5 * Math.min(1, level * 3.2));
      var sigma = 0.6 + 1.1 * pulse;
      var strength = 0.11 + 0.22 * pulse;
      var mid = (W - 1) / 2;
      for (x = 0; x < W; x++) {
        var yc = cy - (wave2[x] / norm) * amp;
        var boost = 1;
        for (var r = 0; r < rings.length; r++) {
          var d = (Math.abs(x - mid) - rings[r].r) / 3.2;
          boost += 1.5 * Math.exp(-d * d);
        }
        var yi = Math.round(yc), s = strength * boost;
        for (var dy = -3; dy <= 3; dy++) {
          var yy = yi + dy;
          if (yy < 0 || yy >= H) continue;
          var q = (yy - yc) / sigma;
          f[yy * W + x] += s * Math.exp(-0.5 * q * q);
        }
      }
    }

    // outward drift: each cell sometimes takes the value of its neighbour nearer the centre line
    var p = 0.08 + 0.5 * pulse;
    for (y = 0; y < H; y++) {
      var sy = y < cy - 0.5 ? y + 1 : (y > cy + 0.5 ? y - 1 : y);
      for (x = 0; x < W; x++) {
        i = y * W + x;
        g[i] = (sy !== y && Math.random() < p) ? f[sy * W + x] * 0.85 + f[i] * 0.15 : f[i];
      }
    }

    // diffusion (explicit 5-point, anisotropic) + decay
    var dx = DIFF_X + 0.05 * pulse, dyy = DIFF_Y + 0.11 * pulse;
    var decay = playing ? DECAY_PLAY : DECAY_IDLE;
    var c0 = 1 - 2 * dx - 2 * dyy;
    maxF = 0;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        i = y * W + x;
        var v = g[i];
        var l = x > 0 ? g[i - 1] : v, rr = x < W - 1 ? g[i + 1] : v;
        var u = y > 0 ? g[i - W] : v, dn = y < H - 1 ? g[i + W] : v;
        var nv = (c0 * v + dx * (l + rr) + dyy * (u + dn)) * decay;
        if (nv > 1.6) nv = 1.6;
        f[i] = nv < 0.004 ? 0 : nv;
        if (nv > maxF) maxF = nv;
      }
    }

    pulse *= 0.9;
    if (pulse < 0.01) pulse = 0;
    for (var k = rings.length - 1; k >= 0; k--) {
      rings[k].r += 1.7;
      if (rings[k].r > W / 2 + 10) rings.splice(k, 1);
    }
  }

  // ---- rendering ---------------------------------------------------------------------------
  function put(x, y, w, h, rgba) {
    var tw = img.width, th = img.height;
    for (var yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= th) continue;
      for (var xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= tw) continue;
        px[yy * tw + xx] = rgba;
      }
    }
  }
  // a dot of diameter d; from 4px up the corners are cut so it reads as round
  function disc(x, y, d, rgba) {
    if (d < 4) { put(x, y, d, d, rgba); return; }
    var tw = img.width, th = img.height, c = (d - 1) / 2, r2 = (d / 2) * (d / 2);
    for (var j = 0; j < d; j++) {
      var yy = y + j;
      if (yy < 0 || yy >= th) continue;
      for (var i = 0; i < d; i++) {
        var xx = x + i;
        if (xx < 0 || xx >= tw) continue;
        var dx = i - c, dy = j - c;
        if (dx * dx + dy * dy <= r2) px[yy * tw + xx] = rgba;
      }
    }
  }
  function pack(r, gg, b, a) { return ((a << 24) | (b << 16) | (gg << 8) | r) >>> 0; }

  function render(playing) {
    var th = theme(), from = th.from, to = th.to;
    var dot = Math.max(1, Math.round(cellDev * 0.6)), free = cellDev - dot;
    var tw = img.width, thh = img.height;
    px.fill(0);

    // faint dotted baseline so the box never looks dead
    var by = Math.round(cy);
    var baseA = playing ? 60 : 110;
    for (var x0 = 0; x0 < W; x0 += 2) {
      disc(offX + x0 * cellDev + (free >> 1), offY + by * cellDev + (free >> 1), dot, pack(from[0], from[1], from[2], baseA));
    }

    // heat -> stippled dots
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var v = f[y * W + x];
        if (v < 0.03) continue;
        var p = 1 - Math.exp(-v * 2.1);
        var n = grain[(x * 7 + y * 13 + grainShift) & 1023] / 255;
        if (p <= n) continue;

        var tcol = W > 1 ? x / (W - 1) : 0;
        var hot = Math.min(1, Math.max(0, (v - 0.55) / 0.9)) * 0.75;
        var r = from[0] + (to[0] - from[0]) * tcol, gg = from[1] + (to[1] - from[1]) * tcol, b = from[2] + (to[2] - from[2]) * tcol;
        r += (255 - r) * hot; gg += (255 - gg) * hot; b += (255 - b) * hot;
        var a = 140 + Math.min(115, (v * 90) | 0);
        var col = pack(r | 0, gg | 0, b | 0, a);
        var ox = offX + x * cellDev + ((Math.random() * (free + 1)) | 0), oy = offY + y * cellDev + ((Math.random() * (free + 1)) | 0);
        disc(ox, oy, dot, col);

        // spray: loose single-pixel specks around bright dots = the diffusing grain
        if (v > 0.12 && Math.random() < 0.32) {
          var sx = ox + Math.round((Math.random() - 0.5) * cellDev * 3.2);
          var sy = oy + Math.round((Math.random() - 0.5) * cellDev * 3.2);
          put(sx, sy, 1, 1, pack(r | 0, gg | 0, b | 0, 70 + ((Math.random() * 70) | 0)));
        }
      }
    }

    // ambient film grain across the whole box (very dim)
    if (!reduce.matches) {
      var specks = Math.round(tw * thh * 0.004);
      for (var s = 0; s < specks; s++) {
        var ix = (Math.random() * tw) | 0, iy = (Math.random() * thh) | 0;
        if (px[iy * tw + ix] === 0) px[iy * tw + ix] = pack(to[0], to[1], to[2], 16 + ((Math.random() * 26) | 0));
      }
    }

    ctx.putImageData(img, 0, 0);
  }

  // ---- loop ------------------------------------------------------------------------------------
  function loop(now) {
    requestAnimationFrame(loop);
    if (!ensureSize()) return;

    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    var playing = !audio.paused && !audio.ended && (!actx || actx.state === 'running');

    if (playing) analyse(now);
    acc += dt;
    var guard = 0;
    while (acc >= STEP && guard++ < 4) { step(playing); acc -= STEP; }

    // grain re-rolls at ~GRAIN_HZ (frozen with reduced motion)
    if (!reduce.matches) {
      grainClock += dt;
      if (grainClock > 1 / GRAIN_HZ) { grainClock = 0; grainShift = (Math.random() * 1024) | 0; }
    }

    // when nothing is happening, don't burn CPU: refresh at ~8 fps
    if (!playing && maxF < 0.02 && now - lastRender < 120) return;
    lastRender = now;
    render(playing);
  }

  var started = false;

  /** env: { audioCtx, analyser, source, getTheme } - all optional except analyser or (source + audioCtx). */
  function attach(env) {
    if (started || !env) return;
    try {
      actx = env.audioCtx || null;
      an = env.analyser || null;
      if (env.source && actx) {
        try {
          var own = actx.createAnalyser();
          own.fftSize = 1024;
          own.smoothingTimeConstant = 0.55;
          env.source.connect(own);     // fan-out; does not affect what you hear
          an = own;
        } catch (e) { /* keep the page's analyser */ }
      }
      if (!an) return;
      getTheme = env.getTheme || null;
      timeBuf = new Uint8Array(an.fftSize);
      freqBuf = new Uint8Array(an.frequencyBinCount);
      bass = binRange(40, 220);
      started = true;
      api.active = true;
      requestAnimationFrame(loop);
    } catch (e) {
      api.active = false;
      if (window.console) console.warn('beatViz: falling back to the original wave', e);
    }
  }

  var api = {
    active: false,
    attach: attach,
    debug: function () { return { beats: beats, pulse: pulse, level: level, maxF: maxF, W: W, H: H, cell: cellDev }; }
  };
  window.beatViz = api;
})();
