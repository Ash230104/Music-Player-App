'use strict';

const { app, BrowserWindow, Menu, dialog, shell, screen, ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

app.setPath('userData', path.join(app.getPath('appData'), 'Music Player'));

const { createServer } = require('./server');
const { createDownloader } = require('./downloader');
const { createBinaries } = require('./binaries');
const { createGoogleAuth } = require('./google-auth');

// FIXED port - see the note at the top of server.js (your library is stored per origin).
const PORT = parseInt(process.env.MUSIC_PLAYER_PORT || '48731', 10);
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

const log = (...args) => console.log('[music-player]', ...args);

let win = null;
let miniWin = null;
let miniHasSong = false;
let server = null;
let downloader = null;
let binaries = null;
let quitting = false;

// ------------------------------------------------------------------ paths --
const userData = app.getPath('userData');
const downloadsDir = path.join(userData, 'downloads');
const importDir = path.join(userData, 'import_queue');
const userBinDir = path.join(userData, 'bin');
const resourcesBinDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, 'bin');
const rendererDir = path.join(__dirname, 'renderer');
const iconPath = path.join(__dirname, 'build', 'icon.png');
const settingsFile = path.join(userData, 'settings.json');
const { createLibraryStore } = require('./library-store');
const libraryDir = path.join(userData, 'library');

// --------------------------------------------------------------- settings --
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    return {};
  }
}
function writeSettings(patch) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
  } catch (err) {
    log('Could not save settings:', err.message);
  }
}

// Let the keyboard's media keys (play/pause/next/prev) reach the page's Media Session handlers.
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');

// -------------------------------------------------------- single instance --
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.setAppUserModelId('com.musicplayer.desktop');
  app.whenReady().then(start).catch(fatal);
}

function fatal(err) {
  dialog.showErrorBox('Solance could not start', String((err && err.stack) || err));
  app.exit(1);
}

// ---------------------------------------------------------------- startup --
async function start() {
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(importDir, { recursive: true });

  // Leftovers from a previous run (songs are already in your library by now).
  for (const f of fs.readdirSync(downloadsDir)) {
    fs.rmSync(path.join(downloadsDir, f), { force: true, recursive: true });
  }

  binaries = createBinaries({ resourcesBinDir, userBinDir, log });

  const libraryStore = createLibraryStore({ libraryDir, log });

  // Google sign-in (optional): lets the downloader read the user's private YouTube playlists.
  const google = createGoogleAuth({
    userData,
    safeStorage,
    openExternal: (u) => {
      if (u.startsWith('https://accounts.google.com/')) shell.openExternal(u);
    },
    redirectUri: `http://127.0.0.1:${PORT}/oauth/google/callback`,
    log,
    // Bring the app back to the front once the browser tab finishes signing in.
    onSignedIn: () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    },
  });

  server = createServer({
    port: PORT,
    rendererDir,
    downloadsDir,
    importDir,
    libraryStore,
    google,
    onDownload: (url, known) => downloader.enqueue(url, known),
    onCancel: () => downloader.cancel(),
    log,
  });
  downloader = createDownloader({ binaries, downloadsDir, publish: server.publish, log, google });

  try {
    await server.listen();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'Solance',
        `Port ${PORT} is already in use by another program.\n\n` +
          'Close that program, or start Solance with a different port by setting ' +
          'MUSIC_PLAYER_PORT.\n\n(Note: a different port is treated as a separate library.)'
      );
      return app.exit(1);
    }
    throw err;
  }

  buildMenu();
  createWindow();

  // Prepare / update yt-dlp in the background; never blocks the UI.
  binaries.prepare().then(async () => {
    const missing = binaries.missing();
    if (missing.length) {
      dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Downloader files are missing',
        detail:
          `Missing: ${missing.join(', ')}\n\nPlaying and managing music still works, but YouTube ` +
          'downloads need these. Run "npm run fetch-binaries" and rebuild the app.',
      });
      return;
    }
    const last = readSettings().lastYtdlpUpdateCheck || 0;
    if (Date.now() - last > UPDATE_CHECK_EVERY_MS) {
      const r = await binaries.update();
      log('yt-dlp auto-update:', r.ok ? 'ok' : 'failed', r.output.split('\n').pop());
      if (r.ok) writeSettings({ lastYtdlpUpdateCheck: Date.now() });
    }
  });
}

// ----------------------------------------------------------------- window --
const stateFile = path.join(userData, 'window-state.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const onScreen =
      Number.isFinite(s.x) &&
      Number.isFinite(s.y) &&
      screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return s.x >= b.x - 20 && s.y >= b.y - 20 && s.x < b.x + b.width - 100 && s.y < b.y + b.height - 100;
      });
    return { ...s, x: onScreen ? s.x : undefined, y: onScreen ? s.y : undefined };
  } catch (_) {
    return {};
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (_) { /* not critical */ }
}

const MIN_WIDTH_FRACTION = 0.5; // minimum window width = 40% of the screen it is on
const MIN_HEIGHT = 600;

function minWidthFor(display) {
  return Math.max(420, Math.round(display.workAreaSize.width * MIN_WIDTH_FRACTION));
}

function applyMinSize() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const minW = minWidthFor(display);
  win.setMinimumSize(minW, MIN_HEIGHT);
  const [w, h] = win.getSize();
  if (!win.isMaximized() && !win.isFullScreen() && w < minW) win.setSize(minW, h);
}

function createWindow() {
  const state = loadWindowState();
  const startDisplay =
    Number.isFinite(state.x) && Number.isFinite(state.y)
      ? screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width || 1200, height: state.height || 820 })
      : screen.getPrimaryDisplay();
  const minWidth = minWidthFor(startDisplay);

  win = new BrowserWindow({
    width: Math.max(state.width || 1200, minWidth),
    height: state.height || 820,
    x: state.x,
    y: state.y,
    minWidth,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true, // press Alt to show the menu
    backgroundColor: '#16213e',
    title: 'Solance',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep timers/UI alive while minimized
    },
  });

  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Only ever show our own pages. Anything else opens in the default browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(server.origin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
    if (miniWin && !miniWin.isDestroyed()) miniWin.destroy(); // otherwise the app never quits
    miniWin = null;
  });

  // Keep the 40% rule right if the window moves to another monitor / resolution changes.
  win.on('moved', applyMinSize);
  screen.on('display-metrics-changed', applyMinSize);

  // Mini player: appears while the main window is minimized.
  ['minimize', 'restore', 'show', 'focus'].forEach((ev) => win.on(ev, syncMiniPlayer));

  win.loadURL(`${server.origin}/`);
  createMiniPlayer();
}

// ------------------------------------------------------------ mini player --
const MINI_W = 420;
const MINI_H = 76;
const MINI_MARGIN = 12; // gap to the screen edge when snapped to a corner
let miniCorner = readSettings().miniCorner || { h: 'right', v: 'bottom' };
let miniSnapping = false;
let miniGlide = null;

function miniCornerPos(display, corner) {
  const a = display.workArea; // respects the taskbar / dock
  return {
    x: corner.h === 'left' ? a.x + MINI_MARGIN : a.x + a.width - MINI_W - MINI_MARGIN,
    y: corner.v === 'top' ? a.y + MINI_MARGIN : a.y + a.height - MINI_H - MINI_MARGIN,
  };
}

// Slide the mini window to `to` (ease-out), ignoring the move events this causes.
function glideMini(to) {
  if (miniGlide) clearInterval(miniGlide);
  const from = miniWin.getBounds();
  const t0 = Date.now();
  const DURATION = 200;
  miniSnapping = true;
  miniGlide = setInterval(() => {
    if (!miniWin || miniWin.isDestroyed()) return clearInterval(miniGlide);
    const k = Math.min(1, (Date.now() - t0) / DURATION);
    const e = 1 - Math.pow(1 - k, 3);
    miniWin.setBounds({
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
      width: MINI_W,
      height: MINI_H,
    });
    if (k >= 1) {
      clearInterval(miniGlide);
      miniGlide = null;
      setTimeout(() => { miniSnapping = false; }, 60);
    }
  }, 16);
}

// After a drag: pick the screen quarter the window's centre is in and snap to that corner.
function snapMini() {
  if (!miniWin || miniWin.isDestroyed() || miniSnapping) return;
  const b = miniWin.getBounds();
  const display = screen.getDisplayMatching(b);
  const a = display.workArea;
  miniCorner = {
    h: b.x + b.width / 2 < a.x + a.width / 2 ? 'left' : 'right',
    v: b.y + b.height / 2 < a.y + a.height / 2 ? 'top' : 'bottom',
  };
  writeSettings({ miniCorner });
  glideMini(miniCornerPos(display, miniCorner));
}

function createMiniPlayer() {
  const pos = miniCornerPos(screen.getDisplayMatching(win.getBounds()), miniCorner);
  miniWin = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Solance (mini)',
    webPreferences: {
      preload: path.join(__dirname, 'preload-mini.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.webContents.on('will-navigate', (e) => e.preventDefault());
  miniWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.MINI_DEVTOOLS) miniWin.webContents.openDevTools({ mode: 'detach' }); // debugging aid
  miniWin.loadURL(`${server.origin}/mini.html`);
}

let miniShowTimer = null;
let miniFade = null;

// One place decides whether the mini-player should be visible: only while the main window is
// minimized and a song is loaded. Window events can arrive in bursts (and a minimized window reports
// bogus bounds), so showing is debounced and re-checked; hiding is immediate.
function syncMiniPlayer() {
  if (!miniWin || miniWin.isDestroyed()) return;
  const want = !!(miniHasSong && win && !win.isDestroyed() && win.isMinimized());
  if (!want) {
    clearTimeout(miniShowTimer);
    miniShowTimer = null;
    if (miniFade) { clearInterval(miniFade); miniFade = null; }
    if (miniWin.isVisible()) miniWin.hide();
    return;
  }
  if (miniWin.isVisible() || miniShowTimer) return; // already showing / about to show
  miniShowTimer = setTimeout(() => {
    miniShowTimer = null;
    if (!miniWin || miniWin.isDestroyed() || !win || win.isDestroyed()) return;
    if (!miniHasSong || !win.isMinimized() || miniWin.isVisible()) return;
    revealMiniPlayer();
  }, 80);
}

function revealMiniPlayer() {
  // Reappear in the remembered corner of the screen the app is on. (getBounds() of a minimized
  // window is off-screen on Windows, so use the restored bounds.)
  if (miniGlide) { clearInterval(miniGlide); miniGlide = null; miniSnapping = false; }
  const pos = miniCornerPos(screen.getDisplayMatching(win.getNormalBounds()), miniCorner);
  miniWin.setBounds({ ...pos, width: MINI_W, height: MINI_H });

  // Fade in from fully transparent so a stale first frame never flashes (Windows/macOS only).
  const canFade = typeof miniWin.setOpacity === 'function' && process.platform !== 'linux';
  if (canFade) miniWin.setOpacity(0);
  miniWin.showInactive(); // don't steal focus from whatever the user is doing
  if (!canFade) return;
  const t0 = Date.now();
  const DELAY = 60; // let the page paint first
  const DURATION = 160;
  miniFade = setInterval(() => {
    if (!miniWin || miniWin.isDestroyed()) return clearInterval(miniFade);
    const k = Math.min(1, Math.max(0, (Date.now() - t0 - DELAY) / DURATION));
    miniWin.setOpacity(k);
    if (k >= 1) { clearInterval(miniFade); miniFade = null; }
  }, 16);
}

const fromMini = (e) => miniWin && !miniWin.isDestroyed() && e.sender === miniWin.webContents;

ipcMain.on('mini:has-song', (e, has) => {
  if (!fromMini(e)) return;
  miniHasSong = !!has;
  syncMiniPlayer(); // song loaded/cleared while minimized
});

// Dragging is done by the page (not the OS drag region, which can swallow button clicks).
let miniDragFrom = null;
ipcMain.on('mini:drag-start', (e) => {
  if (!fromMini(e)) return;
  if (miniGlide) { clearInterval(miniGlide); miniGlide = null; miniSnapping = false; }
  miniDragFrom = miniWin.getBounds();
});
ipcMain.on('mini:drag-move', (e, dx, dy) => {
  if (!fromMini(e) || !miniDragFrom) return;
  miniWin.setBounds({
    x: Math.round(miniDragFrom.x + dx),
    y: Math.round(miniDragFrom.y + dy),
    width: MINI_W,
    height: MINI_H,
  });
});
ipcMain.on('mini:drag-end', (e) => {
  if (!fromMini(e) || !miniDragFrom) return;
  miniDragFrom = null;
  snapMini();
});

ipcMain.on('mini:restore', (e) => {
  if (!fromMini(e) || !win || win.isDestroyed()) return;
  if (miniWin.isVisible()) miniWin.hide();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// ------------------------------------------------------------------- menu --
async function say(options) {
  const opts = { type: 'info', buttons: ['OK'], ...options };
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

async function manualUpdate(channel) {
  if (downloader.isBusy()) {
    return say({
      message: 'Downloads are in progress',
      detail: 'Wait for them to finish (or choose Downloader → Cancel downloads), then try again.',
    });
  }
  const before = await binaries.getVersion();
  const r = await binaries.update(channel);
  const after = await binaries.getVersion();
  if (r.ok) writeSettings({ lastYtdlpUpdateCheck: Date.now() });
  return say({
    type: r.ok ? 'info' : 'error',
    message: r.ok
      ? before && before === after
        ? `yt-dlp is up to date (${after})`
        : `yt-dlp updated to ${after || 'the latest version'}`
      : 'Could not update yt-dlp',
    detail: r.output.split('\n').slice(-8).join('\n'),
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open import folder',
          click: () => shell.openPath(importDir),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Downloader',
      submenu: [
        { label: 'Update yt-dlp', click: () => manualUpdate() },
        {
          label: 'Switch to nightly builds and update (if downloads fail)',
          click: () => manualUpdate('nightly'),
        },
        {
          label: 'Switch back to stable builds and update',
          click: () => manualUpdate('stable'),
        },
        {
          label: 'Show yt-dlp version',
          click: async () => say({ message: `yt-dlp ${(await binaries.getVersion()) || '(not found)'}` }),
        },
        { type: 'separator' },
        {
          label: 'Cancel downloads',
          click: () => {
            downloader.cancel();
            say({ message: 'Downloads cancelled' });
          },
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open app data folder', click: () => shell.openPath(userData) },
        { label: 'Analyzer self-test', click: () => win.loadURL(`${server.origin}/analyzer-test.html`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------- shutdown --
app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    if (downloader) downloader.cancel(); // kills only yt-dlp/ffmpeg we started
  } catch (_) { /* ignore */ }
  const done = () => app.exit(0);
  if (server) server.close().then(done, done);
  else done();
  setTimeout(done, 2000).unref(); // never hang on quit
});
