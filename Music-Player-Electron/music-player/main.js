'use strict';

const { app, BrowserWindow, Menu, dialog, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const { createServer } = require('./server');
const { createDownloader } = require('./downloader');
const { createBinaries } = require('./binaries');

// FIXED port - see the note at the top of server.js (your library is stored per origin).
const PORT = parseInt(process.env.MUSIC_PLAYER_PORT || '48731', 10);
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

const log = (...args) => console.log('[music-player]', ...args);

let win = null;
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
  dialog.showErrorBox('Music Player could not start', String((err && err.stack) || err));
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

  server = createServer({
    port: PORT,
    rendererDir,
    downloadsDir,
    importDir,
    onDownload: (url, known) => downloader.enqueue(url, known),
    onCancel: () => downloader.cancel(),
    log,
  });
  downloader = createDownloader({ binaries, downloadsDir, publish: server.publish, log });

  try {
    await server.listen();
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'Music Player',
        `Port ${PORT} is already in use by another program.\n\n` +
          'Close that program, or start Music Player with a different port by setting ' +
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

function createWindow() {
  const state = loadWindowState();

  win = new BrowserWindow({
    width: state.width || 1200,
    height: state.height || 820,
    x: state.x,
    y: state.y,
    minWidth: 420,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true, // press Alt to show the menu
    backgroundColor: '#16213e',
    title: 'Music Player',
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
  });

  win.loadURL(`${server.origin}/`);
}

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
