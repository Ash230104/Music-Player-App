/**
 * Cassette deck animation - replaces the spinning vinyl / CD.
 *
 * Self-contained: it finds `.deck-art` (main player) and `.dock-cd` (mini dock),
 * injects an SVG cassette player into them, and drives it from the <audio> element.
 * index.html only needs:
 *     <link rel="stylesheet" href="/cassette.css">
 *     <script src="/cassette.js" defer></script>
 * If this file fails to load, the old `.vinyl` markup stays and still works.
 *
 * Accent colours (label stripe, side-A badge, LED, glass tint, mini dock) use CSS
 * variables from the app mood palette: --accent, --accent2, --s1, --mute, --ink, --edge.
 *
 * What moves (all of it follows the real audio state):
 *   - Both reels spin while playing. Like a real deck, tape speed is constant, so a
 *     reel with less tape on it spins FASTER than one with more.
 *   - The tape pack moves from the left reel to the right reel as the song plays
 *     (pack radius comes from audio.currentTime / audio.duration; seeking works).
 *   - The tape running past the head shimmers; the PLAY key is pressed down; the LED lights.
 *   - The label shows the current song + artist (mirrors #current-song-name / #current-artist,
 *     so the app's own JS doesn't need to know about the cassette).
 *   - A short "insert" drop when a new song loads.
 * prefers-reduced-motion: reels stay still (pack size still updates), CSS animations are off.
 */
(function () {
  'use strict';

  var deck = document.querySelector('.deck-art');
  var audio = document.getElementById('audio-player');
  if (!deck || !audio) return;

  // ---- geometry (SVG user units) -------------------------------------------
  var R_MAX = 21;      // full tape pack radius
  var R_MIN = 13.5;    // nearly empty pack radius (hub is 11.5)
  var SPEED = 165 * 17.5; // deg/s * radius: a mid-size pack turns 165 deg/s (one turn per 2.2 s)
  var LABEL_MAX_W = 148;

  // ---- markup ---------------------------------------------------------------
  function teeth() {
    var out = '';
    for (var i = 0; i < 6; i++) {
      out += '<rect x="-1.4" y="-7" width="2.8" height="3.6" transform="rotate(' + i * 60 + ')"/>';
    }
    return out;
  }

  function reel(side, cx) {
    return (
      '<g transform="translate(' + cx + ' 64)">' +
        '<circle class="cs-pack cs-pack-' + side + '" r="' + R_MAX + '" fill="#5a4033" stroke="#8a664f" stroke-width="1.2"/>' +
        '<g class="cs-hub cs-hub-' + side + '">' +
          '<circle r="11.5" fill="#f4f7ff" stroke="#03060c" stroke-width="1.6"/>' +
          '<circle r="7" fill="#0a1120"/>' +
          '<g fill="#f4f7ff">' + teeth() + '</g>' +
          '<circle cy="-9.3" r="1.25" fill="#03060c"/>' +
        '</g>' +
      '</g>'
    );
  }

  function knob(cx, cls) {
    return (
      '<g class="cs-knob ' + (cls || '') + '">' +
        '<rect x="' + (cx - 12) + '" y="12" width="24" height="22" rx="6" fill="url(#cs-silver)" stroke="#03060c" stroke-width="3"/>' +
        '<path d="M' + (cx - 5) + ' 18v8M' + cx + ' 18v8M' + (cx + 5) + ' 18v8" stroke="#03060c" stroke-opacity=".3" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>'
    );
  }

  function dialRidges() {
    var out = '';
    for (var i = 0; i < 10; i++) {
      out += '<path d="M0 -11.5V-8.5" transform="rotate(' + i * 36 + ')"/>';
    }
    return out;
  }

  function bigSvg() {
    return (
      '<svg viewBox="0 0 330 222" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cassette player">' +
        '<defs>' +
          '<linearGradient id="cs-silver" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#f0f4ff"/><stop offset=".55" stop-color="#c9d4ec"/><stop offset="1" stop-color="#a6b4d4"/>' +
          '</linearGradient>' +
          '<clipPath id="cs-glass"><rect x="22" y="40" width="254" height="150" rx="12"/></clipPath>' +
        '</defs>' +

        // hard drop shadow (matches the app's offset-shadow style)
        '<rect x="16" y="33" width="300" height="176" rx="18" fill="#03060c" opacity=".55"/>' +

        // four keys on top - drawn first so the body overlaps their bottoms
        knob(64, 'cs-k-play') + knob(100, 'cs-k-back') + knob(136, 'cs-k-next') + knob(172, 'cs-k-repeat') + knob(208, 'cs-k-shuffle') +

        // body
        '<rect x="10" y="26" width="300" height="176" rx="18" fill="url(#cs-silver)" stroke="#03060c" stroke-width="3"/>' +
        '<rect x="18" y="31" width="284" height="5" rx="2.5" fill="#fff" opacity=".5"/>' +

        // window recess — mood-tinted dark shell
        '<rect class="cs-window" x="22" y="40" width="254" height="150" rx="12" fill="#0d1730" stroke="#03060c" stroke-width="3"/>' +

        // ---- cassette ----
        '<g class="cs-cassette" transform="translate(42 47)">' +
          '<g class="cs-insert">' +
            '<rect class="cs-shell" width="214" height="136" rx="9" fill="#1c2c4f" stroke="#03060c" stroke-width="2.5"/>' +
            '<rect x="4" y="3" width="206" height="4" rx="2" fill="#fff" opacity=".08"/>' +
            // corner screws
            '<g class="cs-screw" fill="#0d1730" stroke="#6b7fae" stroke-width=".8">' +
              '<circle cx="8" cy="8" r="3.2"/><circle cx="206" cy="8" r="3.2"/>' +
              '<circle cx="8" cy="128" r="3.2"/><circle cx="206" cy="128" r="3.2"/>' +
            '</g>' +
            // label — stripe + side badge use mood --accent
            '<rect x="14" y="8" width="186" height="90" rx="5" fill="#f1f4fc" stroke="#03060c" stroke-width="1.5"/>' +
            '<rect class="cs-label-bar" x="14" y="8" width="186" height="5" rx="2" fill="var(--accent, #3d8bff)"/>' +
            '<circle class="cs-side-badge" cx="30" cy="25" r="7.5" fill="var(--accent, #3d8bff)" stroke="#03060c" stroke-width="1.5"/>' +
            '<text x="30" y="28.2" text-anchor="middle" font-family="Poppins, sans-serif" font-size="9" font-weight="700" fill="#070b14">A</text>' +
            '<text class="cs-title" x="43" y="24" font-family="Poppins, sans-serif" font-size="10.5" font-weight="700" fill="#0f1626"></text>' +
            '<text class="cs-artist" x="43" y="35" font-family="Poppins, sans-serif" font-size="8" font-weight="500" fill="#566a94"></text>' +
            // reel window + reels
            '<rect class="cs-well" x="40" y="40" width="134" height="48" rx="24" fill="#0a1120" stroke="#03060c" stroke-width="2"/>' +
            reel('l', 65) + reel('r', 149) +
            // bottom section: rollers, head, moving tape
            '<path class="cs-well" d="M34 136L48 102H166L180 136Z" fill="#0d1730" stroke="#03060c" stroke-width="2"/>' +
            '<rect x="96" y="107" width="22" height="10" rx="2" fill="#03060c"/>' +
            '<rect x="101" y="109" width="12" height="6" rx="1" fill="#8fa0c4"/>' +
            '<path d="M62 121H152" stroke="#5a4033" stroke-width="3.2" stroke-linecap="round"/>' +
            '<path class="cs-tape-run" d="M62 121H152" stroke="#c7a48b" stroke-width="1.4" fill="none"/>' +
            '<circle cx="62" cy="121" r="4.4" fill="#dfe6f7" stroke="#03060c" stroke-width="1.3"/>' +
            '<circle cx="152" cy="121" r="4.4" fill="#dfe6f7" stroke="#03060c" stroke-width="1.3"/>' +
          '</g>' +
        '</g>' +

        // glass: mood-tinted wash + diagonal reflections (static)
        '<g clip-path="url(#cs-glass)">' +
          '<rect class="cs-glass-tint" x="22" y="40" width="254" height="150" fill="var(--accent2, #9cc8ff)" opacity=".10"/>' +
          '<path d="M22 40H150L84 190H22Z" fill="#fff" opacity=".10"/>' +
          '<path d="M172 40H188L122 190H106Z" fill="#fff" opacity=".07"/>' +
        '</g>' +
        '<rect x="24.5" y="42.5" width="249" height="145" rx="10" fill="none" stroke="#fff" stroke-opacity=".22"/>' +

        // right edge: LED, volume dial, ports
        '<circle class="cs-led" cx="293" cy="52" r="3.8" fill="#3a4a70" stroke="#03060c" stroke-width="1.5"/>' +
        '<g transform="translate(293 88)">' +
          '<circle r="11.5" fill="url(#cs-silver)" stroke="#03060c" stroke-width="3"/>' +
          '<g stroke="#03060c" stroke-opacity=".35" stroke-width="1.3" stroke-linecap="round">' + dialRidges() + '</g>' +
        '</g>' +
        '<rect class="cs-well" x="285" y="136" width="16" height="7" rx="3.5" fill="#0d1730" stroke="#03060c" stroke-width="1.5"/>' +
        '<circle class="cs-well" cx="293" cy="160" r="4.6" fill="#0d1730" stroke="#03060c" stroke-width="1.5"/>' +
        '<circle class="cs-port-dot" cx="293" cy="160" r="1.6" fill="#6b7fae"/>' +
      '</svg>'
    );
  }

  function miniSvg() {
    function mini(cx) {
      return (
        '<circle cx="' + cx + '" cy="19" r="6.6" fill="#5a4033"/>' +
        '<g transform="translate(' + cx + ' 19)"><g class="cs-mini-hub">' +
          '<circle r="4.6" fill="#f4f7ff" stroke="#03060c" stroke-width=".8"/>' +
          '<path d="M0 -3.2V-1.2M2.8 1.6L1.1 .6M-2.8 1.6L-1.1 .6" stroke="#0a1120" stroke-width="1.3" fill="none"/>' +
        '</g></g>'
      );
    }
    return (
      '<svg viewBox="0 0 56 38" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect class="cs-mini-body" x="1.5" y="1.5" width="53" height="35" rx="6" fill="#cbd6ee" stroke="#03060c" stroke-width="2"/>' +
        '<rect class="cs-mini-window" x="7" y="8" width="42" height="22" rx="5" fill="#1c2c4f" stroke="#03060c" stroke-width="1.5"/>' +
        mini(19) + mini(37) +
      '</svg>'
    );
  }

  // ---- inject ---------------------------------------------------------------
  var wrap = document.createElement('div');
  wrap.className = 'cassette';
  wrap.innerHTML = bigSvg();
  var oldVinyl = deck.querySelector('.vinyl');
  if (oldVinyl) oldVinyl.remove();
  deck.appendChild(wrap);

  var dockCd = document.querySelector('.dock-cd');
  if (dockCd) dockCd.innerHTML = miniSvg();

  var packL = wrap.querySelector('.cs-pack-l');
  var packR = wrap.querySelector('.cs-pack-r');
  var hubL = wrap.querySelector('.cs-hub-l');
  var hubR = wrap.querySelector('.cs-hub-r');
  var titleEl = wrap.querySelector('.cs-title');
  var artistEl = wrap.querySelector('.cs-artist');
  var insertEl = wrap.querySelector('.cs-insert');

  // ---- label text (mirrors the app's own now-playing text) --------------------
  function fit(el, text) {
    el.textContent = text;
    if (!el.getComputedTextLength) return;
    var s = text;
    var guard = 0;
    while (el.getComputedTextLength() > LABEL_MAX_W && s.length > 1 && guard++ < 300) {
      s = s.slice(0, -1);
      el.textContent = s.replace(/\s+$/, '') + '\u2026';
    }
  }

  function syncLabel() {
    var nameNode = document.getElementById('current-song-name');
    var artistNode = document.getElementById('current-artist');
    var name = nameNode ? nameNode.textContent.trim() : '';
    var artist = artistNode ? artistNode.textContent.trim() : '';
    if (!name || /^no song playing/i.test(name)) {
      name = 'No tape loaded';
      artist = artist || 'Pick a song to start';
    }
    fit(titleEl, name);
    fit(artistEl, artist || 'Unknown artist');
  }

  var mo = new MutationObserver(syncLabel);
  ['current-song-name', 'current-artist'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) mo.observe(n, { childList: true, characterData: true, subtree: true });
  });
  syncLabel();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncLabel);

  // ---- reels + tape pack ------------------------------------------------------
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var angL = 0, angR = 0, last = 0, raf = 0;

  function progress() {
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return 0;
    return Math.min(1, Math.max(0, audio.currentTime / d));
  }

  // Tape AREA is conserved, so r_left^2 + r_right^2 stays constant.
  function render() {
    var p = progress();
    var A = R_MAX * R_MAX - R_MIN * R_MIN;
    var rl = Math.sqrt(R_MAX * R_MAX - p * A);
    var rr = Math.sqrt(R_MIN * R_MIN + p * A);
    packL.setAttribute('r', rl.toFixed(2));
    packR.setAttribute('r', rr.toFixed(2));
    return [rl, rr];
  }

  function frame(now) {
    raf = 0;
    var dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    var r = render();
    if (!reduce.matches) {
      // Constant tape speed: smaller pack => faster rotation. Reels turn counter-clockwise.
      angL = (angL + (SPEED / r[0]) * dt) % 360;
      angR = (angR + (SPEED / r[1]) * dt) % 360;
      hubL.setAttribute('transform', 'rotate(' + (-angL).toFixed(2) + ')');
      hubR.setAttribute('transform', 'rotate(' + (-angR).toFixed(2) + ')');
    }
    if (!audio.paused && !audio.ended) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function kick() {
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  }

  ['play', 'playing'].forEach(function (ev) { audio.addEventListener(ev, kick); });
  ['pause', 'ended', 'seeked', 'timeupdate', 'loadedmetadata', 'durationchange', 'emptied'].forEach(function (ev) {
    audio.addEventListener(ev, function () { if (!raf) render(); });
  });

  // "Insert" drop whenever a new song is loaded.
  audio.addEventListener('loadstart', function () {
    insertEl.classList.remove('cs-drop');
    void insertEl.getBoundingClientRect(); // restart the animation
    insertEl.classList.add('cs-drop');
  });

  render();
  if (!audio.paused) kick();
})();
