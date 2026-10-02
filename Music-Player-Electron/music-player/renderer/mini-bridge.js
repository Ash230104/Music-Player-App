/**
 * Mini-player bridge (runs inside homepage.html).
 * Publishes the player state to the mini window and executes its commands.
 * Both pages share one origin, so a BroadcastChannel connects them.
 *
 * homepage.html only needs, next to the cassette script:
 *     <script src="/mini-bridge.js" defer></script>
 */
(function () {
  'use strict';
  if (!('BroadcastChannel' in window)) return;

  var ch = new BroadcastChannel('music-player-mini');
  var root = document.documentElement;
  var audio = null;
  var timer = 0;

  function $(id) { return document.getElementById(id); }

  function snapshot() {
    var nameEl = $('current-song-name');
    var name = nameEl ? nameEl.textContent.trim() : '';
    var back = $('back-btn');
    return {
      hasSong: !!(audio && audio.src && audio.src !== location.href),
      playing: !!audio && !audio.paused && !audio.ended,
      name: !name || /^no song playing/i.test(name) ? '' : name,
      canBack: !!back && !back.disabled,
      // The mood KEY, not computed colours: the app's palette fades over ~0.85s, so reading
      // computed colours right after a song change returns the previous song's colours.
      mood: root.dataset.mood || 'default',
      // Colours overriding that mood when the user customised the palette (null = built-in palette).
      palette: window.__appearance ? window.__appearance.paletteFor(root.dataset.mood || 'default') : null,
    };
  }

  function send() { ch.postMessage({ type: 'state', state: snapshot() }); }
  function sendSoon() { clearTimeout(timer); timer = setTimeout(send, 60); }

  // ---- commands from the mini window ---------------------------------------
  function run(cmd) {
    var a = audio || $('audio-player');
    if (cmd === 'toggle' && a) {
      if (a.paused) { var p = a.play(); if (p && p.catch) p.catch(function () {}); } else a.pause();
    } else if (cmd === 'next') {
      if (window.__playerPlayNext) window.__playerPlayNext();
      else { var n = $('next-btn'); if (n) n.click(); }
    } else if (cmd === 'back') {
      var b = $('back-btn');
      if (b && !b.disabled) b.click();
    }
  }

  ch.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'request-state') send();
    else if (m.type === 'cmd') run(m.cmd);
  };

  // ---- what triggers an update ---------------------------------------------
  var mo = new MutationObserver(sendSoon);
  var nameNode = $('current-song-name');
  if (nameNode) mo.observe(nameNode, { childList: true, characterData: true, subtree: true });
  var backNode = $('back-btn');
  if (backNode) mo.observe(backNode, { attributes: true, attributeFilter: ['disabled'] });

  // Mood changes (set before the new song's audio even loads).
  new MutationObserver(send)
    .observe(root, { attributes: true, attributeFilter: ['data-mood'] });

  window.addEventListener('player:songchange', sendSoon);
  window.addEventListener('appearance:change', send);
  window.addEventListener('player:playpause', sendSoon);

  var wait = setInterval(function () {
    audio = $('audio-player');
    if (!audio) return;
    clearInterval(wait);
    ['play', 'pause', 'ended', 'emptied', 'loadstart', 'loadedmetadata'].forEach(function (ev) {
      audio.addEventListener(ev, sendSoon);
    });
    send();
  }, 300);

  send();
})();
