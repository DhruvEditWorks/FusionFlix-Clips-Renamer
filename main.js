'use strict';
/**
 * FUSION FLIX — CLIP RENAMER & SORTER
 * Electron main process.
 *
 * Responsibilities
 *   • create the window + native menu
 *   • every filesystem, FFmpeg and dialog operation (renderer has no Node access)
 *   • stream local video into the renderer through a validating custom protocol
 *   • project save/load/autosave, import pipeline, export job
 *
 * Security model
 *   • contextIsolation: true, nodeIntegration: false, sandbox: true
 *   • the renderer only reaches the outside world through preload.js IPC
 *   • all paths coming from the renderer are validated (absolute, no NUL, and
 *     for media streaming: must belong to the open project)
 *   • FFmpeg/FFprobe are spawned directly with an argument array, never a shell
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net, session, nativeTheme, screen } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');

const IPC = require('./lib/ipc');
const settingsStore = require('./lib/settings');
const media = require('./lib/media');
const projectLib = require('./lib/project');
const demo = require('./lib/demo');
const { planExport, ExportJob } = require('./lib/exporter');
const { planRename, RenameJob, undoRename } = require('./lib/renamer');
const engineDownload = require('./lib/engine-download');
const {
  VIDEO_EXTENSIONS,
  isSupportedVideo,
  mimeFor,
  computeTimeText,
  finalFileName,
  finalRelativePath,
  STATUS,
  toIntOrNull,
} = require('./lib/filenames');
const paths = require('./lib/paths');

const APP_TITLE = 'Fusion Flix Clip Renamer & Sorter';
const FOOTER_TEXT = 'A free to use tool by Fusion Flix (Dhruv Sharma) 💓';

let mainWindow = null;
let userDataDir = '';
let cacheDir = '';
let currentProjectPath = '';
let autosaveTimer = null;
let allowClose = false;

// Paths the renderer is allowed to stream. Everything else is refused.
const allowedMedia = new Set();
// Thumbnail cache paths the renderer may display.
const allowedThumbs = new Set();

const isDev = process.argv.includes('--dev');

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Custom protocols (declared before app ready)
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ffmedia',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false },
  },
  {
    scheme: 'ffthumb',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false },
  },
]);

/** Engine options for lib/media: explicit Settings paths win over auto-detection. */
function engineOptions() {
  const stored = settingsStore.load();
  return {
    resourcesDir: process.resourcesPath,
    ffmpegPath: stored.ffmpegPath || '',
    ffprobePath: stored.ffprobePath || '',
  };
}

function rememberMedia(filePath) {
  const key = paths.pathKey(filePath);
  allowedMedia.add(key);
}

function registerAllowedClips(clips) {
  allowedMedia.clear();
  for (const clip of clips || []) {
    if (clip && clip.sourcePath) rememberMedia(clip.sourcePath);
  }
}

function isAllowedMedia(filePath) {
  return allowedMedia.has(paths.pathKey(filePath));
}

// ---------------------------------------------------------------------------
// Media + thumbnail streaming (with HTTP range support so scrubbing is smooth)
// ---------------------------------------------------------------------------
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

async function streamFile(request, filePath, size) {
  const type = mimeFor(filePath);
  const rangeHeader = request.headers.get('Range');
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    // Lets the renderer draw a frame to a canvas for the built-in thumbnail
    // fallback (used when FFmpeg is not available).
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };

  const range = rangeHeader ? parseRange(rangeHeader, size) : null;

  if (request.method === 'HEAD') {
    const head = Object.assign({}, headers, { 'Content-Length': String(range ? range.end - range.start + 1 : size) });
    if (range) head['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    return new Response(null, { status: range ? 206 : 200, headers: head });
  }

  if (range) {
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: Object.assign({}, headers, {
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      }),
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: Object.assign({}, headers, { 'Content-Length': String(size) }),
  });
}

function registerProtocols() {
  protocol.handle('ffmedia', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const v = paths.validatePath(filePath);
      if (!v.ok) return new Response('Invalid media path.', { status: 400 });
      if (!isSupportedVideo(v.path)) return new Response('Unsupported media type.', { status: 415 });
      // Project clips, plus the preview proxies the app itself writes into the
      // cache folder (generated stills and proxies are app-owned, never input).
      const inCache = Boolean(cacheDir) && paths.isInside(cacheDir, v.path);
      if (!inCache && !isAllowedMedia(v.path)) return new Response('This file is not part of the open project.', { status: 403 });

      let st;
      try {
        st = await fsp.stat(v.path);
      } catch (_) {
        return new Response('Media missing.', { status: 404 });
      }
      if (!st.isFile()) return new Response('Not a file.', { status: 404 });
      return await streamFile(request, v.path, st.size);
    } catch (err) {
      return new Response('Media could not be read.', { status: 500 });
    }
  });

  protocol.handle('ffthumb', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const v = paths.validatePath(filePath);
      if (!v.ok || !paths.isInside(cacheDir, v.path)) return new Response('Not found.', { status: 404 });
      let st;
      try {
        st = await fsp.stat(v.path);
      } catch (_) {
        return new Response('Not found.', { status: 404 });
      }
      const stream = fs.createReadStream(v.path);
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(st.size),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (_) {
      return new Response('Not found.', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
/**
 * Keeps a remembered window comfortably inside the display it is opening on.
 * Without this a window saved on a bigger monitor could come back larger than
 * the screen (dialogs then land in odd corners and parts of the UI get cut off).
 */
function fittedWindowBounds(saved) {
  const stored = saved || {};
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.max(1080, Math.min(Number(stored.width) || 1520, work.width));
  const height = Math.max(660, Math.min(Number(stored.height) || 940, work.height));
  const wantedX = Number.isFinite(stored.x) ? stored.x : Math.round(work.x + (work.width - width) / 2);
  const wantedY = Number.isFinite(stored.y) ? stored.y : Math.round(work.y + (work.height - height) / 2);
  return {
    width,
    height,
    x: Math.min(Math.max(wantedX, work.x), Math.max(work.x, work.x + work.width - width)),
    y: Math.min(Math.max(wantedY, work.y), Math.max(work.y, work.y + work.height - height)),
  };
}

function createWindow() {
  const bounds = fittedWindowBounds(settingsStore.load().windowBounds);
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1080,
    minHeight: 660,
    backgroundColor: '#0b0c0e',
    show: false,
    title: APP_TITLE,
    icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('close', (event) => {
    try {
      const b = mainWindow.getBounds();
      settingsStore.save({ windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
    } catch (_) {}

    // Give the renderer a chance to protect unsaved project metadata.
    if (!allowClose) {
      event.preventDefault();
      send(IPC.BEFORE_CLOSE, { at: Date.now() });
      return;
    }
    stopAutosave();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in the real browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Never show a raw stack trace to the user.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    dialog
      .showMessageBox({
        type: 'error',
        title: 'Fusion Flix',
        message: 'The application window stopped unexpectedly.',
        detail: `Reason: ${details.reason}. Reopen the app — your project metadata is autosaved.`,
        buttons: ['Close'],
      })
      .then(() => app.quit())
      .catch(() => app.quit());
  });

  return mainWindow;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => send(IPC.MENU_ACTION, 'new-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send(IPC.MENU_ACTION, 'open-project') },
        { type: 'separator' },
        { label: 'Import Clips…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send(IPC.MENU_ACTION, 'import-clips') },
        { label: 'Import Folder…', accelerator: 'CmdOrCtrl+Shift+F', click: () => send(IPC.MENU_ACTION, 'import-folder') },
        { label: 'Load Sample Project', click: () => send(IPC.MENU_ACTION, 'load-sample') },
        { type: 'separator' },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => send(IPC.MENU_ACTION, 'save-project') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send(IPC.MENU_ACTION, 'save-project-as') },
        { type: 'separator' },
        { label: 'Rename Files In Place…', accelerator: 'CmdOrCtrl+Shift+R', click: () => send(IPC.MENU_ACTION, 'open-rename') },
        { label: 'Export Copies (Scene folders)…', accelerator: 'CmdOrCtrl+E', click: () => send(IPC.MENU_ACTION, 'open-export') },
        { type: 'separator' },
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send(IPC.MENU_ACTION, 'undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send(IPC.MENU_ACTION, 'redo') },
        { type: 'separator' },
        { label: 'Apply to Clip', accelerator: 'CmdOrCtrl+Return', click: () => send(IPC.MENU_ACTION, 'apply') },
        { label: 'Apply & Next', accelerator: 'Return', click: () => send(IPC.MENU_ACTION, 'apply-next') },
        { type: 'separator' },
        { label: 'Relink Missing Media…', click: () => send(IPC.MENU_ACTION, 'relink') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send(IPC.MENU_ACTION, 'settings') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: () => send(IPC.MENU_ACTION, 'shortcuts') },
        { label: 'Check Media Engine (FFmpeg)', click: () => send(IPC.MENU_ACTION, 'check-engines') },
        { type: 'separator' },
        { label: 'About Fusion Flix', click: () => send(IPC.MENU_ACTION, 'about') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------
const importState = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
};

/** Recursively collects supported video files (skips hidden/system folders). */
async function scanPaths(inputPaths, onTick) {
  const files = [];
  const warnings = [];
  const seen = new Set();

  async function walk(dir, depth) {
    if (importState.cancelled) return;
    if (depth > 12) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Could not open folder "${path.basename(dir)}" — it may be protected or offline.`);
      return;
    }
    for (const entry of entries) {
      if (importState.cancelled) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^\$(RECYCLE|Recycle)/i.test(entry.name) || /^System Volume Information$/i.test(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!isSupportedVideo(full)) continue;
        const key = paths.pathKey(full);
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(full);
        if (files.length % 25 === 0 && onTick) onTick(files.length);
      }
    }
  }

  for (const input of inputPaths) {
    if (importState.cancelled) break;
    const v = paths.validatePath(input);
    if (!v.ok) {
      warnings.push(`Skipped an entry that is not a readable path.`);
      continue;
    }
    let st = null;
    try {
      st = await fsp.stat(v.path);
    } catch (_) {
      warnings.push(`"${path.basename(v.path)}" could not be opened — it may have been moved, or the drive is not connected.`);
      continue;
    }
    if (st.isDirectory()) {
      await walk(v.path, 0);
    } else if (st.isFile()) {
      if (!isSupportedVideo(v.path)) {
        warnings.push(`"${path.basename(v.path)}" is not a supported video format and was skipped.`);
      } else {
        const key = paths.pathKey(v.path);
        if (!seen.has(key)) {
          seen.add(key);
          files.push(v.path);
        }
      }
    }
    if (onTick) onTick(files.length);
  }

  return { files, warnings };
}

/** Runs a small worker pool over `items` (used for ffprobe during import). */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      if (importState.cancelled) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function buildClipFromFile(filePath, order, settings) {
  const stat = await fsp.stat(filePath).catch(() => null);
  const meta = await media.probeFile(filePath, engineOptions());
  const stored = settingsStore.load();
  const prefs = Object.assign({}, stored, settings || {});
  const timecodeFallback = prefs.timecodeFallback || stored.timecodeFallback;
  const toValue = (raw) => {
    const n = toIntOrNull(raw);
    return n === null ? 0 : n;
  };
  return {
    id: projectLib.newId(),
    order,
    sourcePath: filePath,
    fileName: path.basename(filePath),
    relPath: '',
    size: stat ? stat.size : 0,
    mtimeMs: stat ? stat.mtimeMs : 0,
    // Scene / Shot / Take start enabled according to the user's preferences
    // (Settings → Tagging). Values begin at the configured starting number.
    sceneOn: prefs.defaultSceneOn !== false,
    shotOn: prefs.defaultShotOn !== false,
    takeOn: prefs.defaultTakeOn !== false,
    scene: prefs.defaultSceneOn !== false ? toValue(prefs.defaultSceneValue) : null,
    shot: prefs.defaultShotOn !== false ? toValue(prefs.defaultShotValue) : null,
    take: prefs.defaultTakeOn !== false ? toValue(prefs.defaultTakeValue) : null,
    extra: false,
    customOn: false,
    custom: '',
    timeText: computeTimeText(Object.assign({}, meta, { mtimeMs: stat ? stat.mtimeMs : 0 }), { index: order, timecodeFallback }),
    status: meta.probeError ? STATUS.NEW : STATUS.NEW,
    note: '',
    meta,
  };
}

async function runImport(inputPaths, options = {}) {
  if (importState.running) throw new Error('An import is already running.');
  importState.running = true;
  importState.cancelled = false;
  importState.total = 0;
  importState.done = 0;

  const settings = Object.assign({}, settingsStore.load(), options.projectSettings || {});
  const startedAt = Date.now();

  try {
    send(IPC.IMPORT_PROGRESS, { stage: 'scanning', found: 0, total: 0, percent: 0, message: 'Looking for clips…' });

    const scan = await scanPaths(inputPaths, (found) => {
      send(IPC.IMPORT_PROGRESS, {
        stage: 'scanning',
        found,
        total: 0,
        percent: 0,
        message: found === 1 ? 'Found 1 clip…' : `Found ${found} clips…`,
      });
    });

    if (importState.cancelled) {
      return { cancelled: true, clips: [], warnings: scan.warnings, found: scan.files.length };
    }

    importState.total = scan.files.length;
    send(IPC.IMPORT_PROGRESS, {
      stage: 'reading',
      found: scan.files.length,
      total: scan.files.length,
      percent: 0,
      message: scan.files.length ? `Reading metadata from ${scan.files.length} clips…` : 'No supported video files were found.',
    });

    const clips = [];
    await pool(scan.files, 4, async (filePath, index) => {
      try {
        const clip = await buildClipFromFile(filePath, index, settings);
        clips[index] = clip;
        rememberMedia(filePath);
        if (clip.meta && clip.meta.probeError) {
          scan.warnings.push(`"${path.basename(filePath)}" could not be fully read and is marked for review.`);
        }
      } catch (err) {
        scan.warnings.push(`"${path.basename(filePath)}" could not be imported — the file may be damaged or in use.`);
      }
      importState.done += 1;
      const percent = importState.total ? Math.round((importState.done / importState.total) * 100) : 0;
      send(IPC.IMPORT_PROGRESS, {
        stage: 'reading',
        found: importState.total,
        total: importState.total,
        done: importState.done,
        percent,
        current: path.basename(filePath),
        message: `Reading metadata — ${importState.done} of ${importState.total}`,
      });
    });

    const found = clips.filter(Boolean);

    send(IPC.IMPORT_PROGRESS, {
      stage: 'done',
      found: found.length,
      total: found.length,
      done: found.length,
      percent: 100,
      message: found.length ? `Imported ${found.length} clips.` : 'No clips were imported.',
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });

    return {
      cancelled: importState.cancelled,
      clips: found,
      warnings: scan.warnings.slice(0, 50),
      found: scan.files.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    };
  } finally {
    importState.running = false;
  }
}

// ---------------------------------------------------------------------------
// Thumbnail service (lazy, queued, cached)
// ---------------------------------------------------------------------------
const thumbQueue = [];
const thumbInflight = new Map();
let thumbActive = 0;
const THUMB_CONCURRENCY = 2;

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive += 1;
    media
      .ensureThumbnail(
        Object.assign(
          {
            filePath: job.sourcePath,
            cacheDir: cacheDir,
            width: job.width || settingsStore.previewWidth(),
            duration: job.duration,
            variant: job.variant || 'thumb',
          },
          engineOptions()
        )
      )
      .then((res) => {
        allowedThumbs.add(paths.pathKey(res.path));
        job.resolve({ ok: true, path: res.path, cached: res.cached, id: job.id });
      })
      .catch((err) =>
        job.resolve({
          ok: false,
          id: job.id,
          error: err.message,
          // Signals the renderer that it may build a thumbnail itself instead.
          fallback: err && err.code === 'ENGINE_MISSING' ? 'renderer' : '',
        })
      )
      .finally(() => {
        thumbActive -= 1;
        thumbInflight.delete(job.id);
        pumpThumbs();
      });
  }
}

function requestThumbnail(payload) {
  const { id, sourcePath, duration, width, variant } = payload || {};
  if (!id || !sourcePath) return Promise.resolve({ ok: false, id, error: 'Missing clip information.' });
  const v = paths.validatePath(sourcePath);
  if (!v.ok) return Promise.resolve({ ok: false, id, error: v.reason });
  if (!isSupportedVideo(v.path)) return Promise.resolve({ ok: false, id, error: 'Unsupported media type.' });

  const existing = thumbInflight.get(id);
  if (existing) return existing.promise;

  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  const job = {
    id,
    sourcePath: v.path,
    duration: Number(duration) || 0,
    width: Number(width) || 0,
    variant: variant === 'still' ? 'still' : 'thumb',
    resolve: resolveFn,
    promise,
  };
  thumbInflight.set(id, job);
  thumbQueue.push(job);
  pumpThumbs();
  return promise;
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------
function startAutosave() {
  stopAutosave();
  const s = settingsStore.load();
  if (!s.autosaveEnabled) return;
  const seconds = Math.max(10, Math.min(300, Number(s.autosaveSeconds) || 30));
  autosaveTimer = setInterval(() => send(IPC.AUTOSAVE_TICK, { at: Date.now() }), seconds * 1000);
}

function stopAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = null;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(payload, event);
    } catch (err) {
      // Never leak stack traces to the renderer.
      return {
        __error: true,
        message: (err && err.message) || 'Something went wrong. Please try again.',
      };
    }
  });
}

function registerIpc() {
  // ---- app / settings ----------------------------------------------------
  handle(IPC.APP_INFO, async () => ({
    appName: APP_TITLE,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    footer: FOOTER_TEXT,
    userData: userDataDir,
    cacheDir,
    projectPath: currentProjectPath,
    supportedExtensions: VIDEO_EXTENSIONS,
  }));

  handle(IPC.SETTINGS_GET, async () => settingsStore.get());
  handle(IPC.SETTINGS_SET, async (patch) => settingsStore.save(patch || {}));
  handle(IPC.SETTINGS_CHECK_ENGINES, async () => media.checkEngines(process.resourcesPath, engineOptions()));

  // Let the user point the app at ffmpeg.exe / ffprobe.exe (Settings → Locate).
  handle(IPC.SETTINGS_LOCATE_ENGINE, async (payload) => {
    const which = payload && payload.which === 'ffprobe' ? 'ffprobe' : 'ffmpeg';
    const res = await dialog.showOpenDialog(mainWindow, {
      title: `Locate ${which}.exe`,
      buttonLabel: 'Use this file',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
    const chosen = res.filePaths[0];
    const v = paths.validateExistingFile(chosen);
    if (!v.ok) return { ok: false, error: v.reason };

    // Verify it really is the tool we expect before saving it.
    media.resetEngineCache();
    const probe = await media.checkEngines(process.resourcesPath, { resourcesDir: process.resourcesPath, ffmpegPath: which === 'ffmpeg' ? chosen : '', ffprobePath: which === 'ffprobe' ? chosen : '' });
    const info = probe[which];
    if (!info || !info.ok) {
      media.resetEngineCache();
      return { ok: false, error: `That file does not look like a working ${which}. Please choose the real ${which}.exe.` };
    }
    const patch = which === 'ffmpeg' ? { ffmpegPath: chosen } : { ffprobePath: chosen };
    await settingsStore.save(patch);
    media.resetEngineCache();
    const engines = await media.checkEngines(process.resourcesPath, engineOptions());
    return { ok: true, which, path: chosen, version: info.version, engines };
  });
  handle(IPC.SETTINGS_CLEAR_THUMBS, async () => {
    allowedThumbs.clear();
    const res = await media.clearThumbnailCache(cacheDir);
    return res;
  });
  handle(IPC.SETTINGS_PRUNE_THUMBS, async () => media.pruneThumbnailCache(cacheDir));
  handle(IPC.SETTINGS_CHOOSE_CACHE, async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a thumbnail cache folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const chosen = res.filePaths[0];
    try {
      await fsp.mkdir(chosen, { recursive: true });
    } catch (_) {
      return { ok: false, error: 'That folder could not be used.' };
    }
    cacheDir = chosen;
    await settingsStore.save({ thumbnailCacheDir: chosen });
    return { ok: true, cacheDir };
  });

  // ---- dialogs -----------------------------------------------------------
  handle(IPC.DIALOG_OPEN_CLIPS, async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import clips',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video clips', extensions: VIDEO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled ? { ok: false, filePaths: [] } : { ok: true, filePaths: res.filePaths };
  });

  handle(IPC.DIALOG_OPEN_FOLDER, async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a folder of clips',
      buttonLabel: 'Import folder',
      properties: ['openDirectory'],
    });
    return res.canceled ? { ok: false, folderPath: '' } : { ok: true, folderPath: res.filePaths[0] };
  });

  handle(IPC.DIALOG_OPEN_PROJECT, async () => {
    const s = settingsStore.load();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open project',
      defaultPath: s.lastProjectDir || undefined,
      properties: ['openFile'],
      filters: [{ name: 'Fusion Flix Project', extensions: ['ffclip'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    await settingsStore.save({ lastProjectDir: path.dirname(res.filePaths[0]) });
    return { ok: true, filePath: res.filePaths[0] };
  });

  handle(IPC.DIALOG_SAVE_PROJECT, async (payload) => {
    const s = settingsStore.load();
    const suggested = (payload && payload.name) || 'My Project';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save project as',
      defaultPath: path.join(s.lastProjectDir || app.getPath('documents'), `${suggested}${projectLib.PROJECT_EXT}`),
      filters: [{ name: 'Fusion Flix Project', extensions: ['ffclip'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    await settingsStore.save({ lastProjectDir: path.dirname(res.filePath) });
    return { ok: true, filePath: projectLib.withProjectExt(res.filePath) };
  });

  handle(IPC.DIALOG_CHOOSE_DESTINATION, async (payload) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: payload && payload.title ? payload.title : 'Choose export folder',
      buttonLabel: 'Use this folder',
      defaultPath: (payload && payload.defaultPath) || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? { ok: false } : { ok: true, folderPath: res.filePaths[0] };
  });

  handle(IPC.DIALOG_CHOOSE_VIDEO, async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Relink clip — choose the source file',
      properties: ['openFile'],
      filters: [
        { name: 'Video clips', extensions: VIDEO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled ? { ok: false } : { ok: true, filePath: res.filePaths[0] };
  });

  handle(IPC.DIALOG_MESSAGE, async (payload) => {
    const p = payload || {};
    const res = await dialog.showMessageBox(mainWindow, {
      type: p.type || 'info',
      title: p.title || 'Fusion Flix',
      message: p.message || '',
      detail: p.detail || '',
      buttons: p.buttons && p.buttons.length ? p.buttons : ['OK'],
      defaultId: Number.isInteger(p.defaultId) ? p.defaultId : 0,
      cancelId: Number.isInteger(p.cancelId) ? p.cancelId : undefined,
      noLink: true,
    });
    return { response: res.response };
  });

  // ---- import ------------------------------------------------------------
  handle(IPC.IMPORT_PATHS, async (payload) => {
    const inputPaths = (payload && payload.paths) || [];
    if (!Array.isArray(inputPaths) || !inputPaths.length) return { ok: false, error: 'No files or folders were provided.', clips: [], warnings: [] };
    const result = await runImport(inputPaths, { projectSettings: payload && payload.projectSettings });
    return Object.assign({ ok: true }, result);
  });
  handle(IPC.IMPORT_CANCEL, async () => {
    importState.cancelled = true;
    return { ok: true };
  });

  // ---- media -------------------------------------------------------------
  handle(IPC.MEDIA_THUMB, async (payload) => requestThumbnail(payload));

  // ---- preview proxies (playable H.264 stand-in for camera codecs) --------
  let activeProxy = null;

  handle(IPC.MEDIA_PROXY, async (payload) => {
    const { id, sourcePath, duration, width } = payload || {};
    if (!sourcePath) return { ok: false, id, error: 'Missing clip information.' };
    const v = paths.validatePath(sourcePath);
    if (!v.ok) return { ok: false, id, error: v.reason };
    if (!isSupportedVideo(v.path)) return { ok: false, id, error: 'Unsupported media type.' };
    if (!isAllowedMedia(v.path)) return { ok: false, id, error: 'This file is not part of the open project.' };

    // One proxy at a time: this runs while the user is looking at a clip.
    if (activeProxy) activeProxy.cancel();

    const token = { cancelled: false, child: null, kill: null };
    const cancel = () => {
      token.cancelled = true;
      if (typeof token.kill === 'function') token.kill();
    };
    activeProxy = { id, cancel };

    const settings = settingsStore.load();
    const engine = engineOptions();
    const sendProgress = (ratio, stage) => {
      send(IPC.MEDIA_PROXY_PROGRESS, {
        id,
        stage: stage || 'building',
        percent: Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100))),
      });
    };
    sendProgress(0, 'building');

    try {
      const res = await media.ensureProxy({
        filePath: v.path,
        cacheDir,
        resourcesDir: engine.resourcesDir,
        ffmpegPath: settings.ffmpegPath || engine.ffmpegPath,
        duration: Number(duration) || 0,
        width: Number(width) || 1280,
        token,
        onProgress: (ratio) => sendProgress(ratio, 'building'),
      });
      if (token.cancelled) return { ok: false, id, cancelled: true };
      sendProgress(1, 'ready');
      return { ok: true, id, path: res.path, cached: res.cached };
    } catch (err) {
      const code = (err && err.code) || '';
      const missing = code === 'ENGINE_MISSING';
      return {
        ok: false,
        id,
        code,
        error: missing
          ? 'The media engine (FFmpeg) is not installed, so this clip cannot be prepared for preview.'
          : (err && err.message) || 'The preview could not be prepared.',
        engineMissing: missing,
      };
    } finally {
      if (activeProxy && activeProxy.id === id) activeProxy = null;
    }
  });

  handle(IPC.MEDIA_PROXY_CANCEL, async (payload) => {
    if (!activeProxy) return { ok: false };
    if (payload && payload.id && payload.id !== activeProxy.id) return { ok: false };
    activeProxy.cancel();
    return { ok: true };
  });
  handle(IPC.MEDIA_PROBE, async (payload) => {
    const v = paths.validateExistingFile(payload && payload.path);
    if (!v.ok) return { ok: false, error: v.reason };
    const meta = await media.probeFile(v.path, engineOptions());
    return { ok: true, meta, size: (await fsp.stat(v.path)).size, mtimeMs: (await fsp.stat(v.path)).mtimeMs };
  });

  // ---- project -----------------------------------------------------------
  handle(IPC.PROJECT_SAVE, async (payload) => {
    const { project, filePath } = payload || {};
    if (!project) return { ok: false, error: 'Nothing to save.' };
    let target = filePath;
    if (!target) {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save project',
        defaultPath: path.join(settingsStore.load().lastProjectDir || app.getPath('documents'), `${project.name || 'My Project'}${projectLib.PROJECT_EXT}`),
        filters: [{ name: 'Fusion Flix Project', extensions: ['ffclip'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
      target = projectLib.withProjectExt(res.filePath);
    }
    const v = paths.validatePath(target);
    if (!v.ok) return { ok: false, error: v.reason };
    const result = await projectLib.save(project, v.path);
    currentProjectPath = v.path;
    await settingsStore.save({ lastProjectDir: path.dirname(v.path) });
    // a clean save supersedes any pending crash-recovery snapshot
    await projectLib.writeAutosave(userDataDir, project, v.path, { clean: true });
    return { ok: true, filePath: result.filePath, clipCount: result.clipCount };
  });

  handle(IPC.PROJECT_OPEN, async (payload) => {
    const filePath = payload && payload.filePath;
    const v = paths.validatePath(filePath);
    if (!v.ok) return { ok: false, error: v.reason };
    const project = await projectLib.load(v.path);
    currentProjectPath = v.path;
    registerAllowedClips(project.clips);
    await settingsStore.save({ lastProjectDir: path.dirname(v.path) });
    return { ok: true, project, filePath: v.path };
  });

  handle(IPC.PROJECT_CHECK_MEDIA, async (payload) => {
    const clips = (payload && payload.clips) || [];
    const missing = [];
    const sizes = {};
    for (const clip of clips) {
      if (!clip || !clip.sourcePath) {
        missing.push(clip && clip.id);
        continue;
      }
      const key = paths.pathKey(clip.sourcePath);
      if (sizes[key] === undefined) {
        let st = null;
        try {
          st = await fsp.stat(clip.sourcePath);
        } catch (_) {
          st = null;
        }
        sizes[key] = st && st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
      }
      if (!sizes[key]) missing.push(clip.id);
      else rememberMedia(clip.sourcePath);
    }
    return { ok: true, missing };
  });

  handle(IPC.PROJECT_RELINK, async (payload) => {
    const { clipId, newPath } = payload || {};
    const v = paths.validateExistingFile(newPath);
    if (!v.ok) return { ok: false, error: v.reason };
    if (!isSupportedVideo(v.path)) {
      return { ok: false, error: 'That file is not a supported video format. Please choose a video clip.' };
    }
    const meta = await media.probeFile(v.path, engineOptions());
    let st = null;
    try {
      st = await fsp.stat(v.path);
    } catch (_) {}
    rememberMedia(v.path);
    return {
      ok: true,
      clipId,
      sourcePath: v.path,
      fileName: path.basename(v.path),
      size: st ? st.size : 0,
      mtimeMs: st ? st.mtimeMs : 0,
      meta,
    };
  });

  handle(IPC.PROJECT_REGISTER_MEDIA, async (payload) => {
    const clips = (payload && payload.clips) || [];
    registerAllowedClips(clips);
    return { ok: true, count: allowedMedia.size };
  });

  handle(IPC.PROJECT_SET_PATH, async (payload) => {
    const p = payload && payload.filePath;
    if (!p) {
      currentProjectPath = '';
      return { ok: true, filePath: '' };
    }
    const v = paths.validatePath(p);
    if (!v.ok) return { ok: false, error: v.reason };
    currentProjectPath = v.path;
    return { ok: true, filePath: currentProjectPath };
  });

  // ---- autosave / recovery ----------------------------------------------
  handle(IPC.AUTOSAVE_WRITE, async (payload) => {
    const { project, filePath, clean } = payload || {};
    if (!project) return { ok: false };
    const file = await projectLib.writeAutosave(userDataDir, project, filePath || currentProjectPath, { clean: Boolean(clean) });
    return { ok: true, file, at: new Date().toISOString() };
  });
  handle(IPC.AUTOSAVE_LIST, async () => ({ ok: true, entries: await projectLib.listRecoverable(userDataDir) }));
  handle(IPC.AUTOSAVE_READ, async (payload) => {
    const res = await projectLib.readRecoverable(userDataDir, payload && payload.key);
    registerAllowedClips(res.project.clips);
    return Object.assign({ ok: true }, res);
  });
  handle(IPC.AUTOSAVE_DISCARD, async (payload) => projectLib.discardRecoverable(userDataDir, payload && payload.key));

  // ---- export ------------------------------------------------------------
  let activeJob = null;

  handle(IPC.EXPORT_PLAN, async (payload) => {
    const { clips, options } = payload || {};
    const settings = settingsStore.get();
    const opts = Object.assign(
      { layout: settings.exportLayout, duplicateNaming: settings.duplicateNaming, defaultExportLocation: settings.defaultExportLocation },
      options || {}
    );
    if (!opts.destination && opts.defaultExportLocation) opts.destination = opts.defaultExportLocation;
    const plan = await planExport(clips || [], opts);
    for (const entry of plan.entries) rememberMedia(entry.sourcePath);
    return { ok: true, plan: Object.assign({}, plan, { validation: undefined }) };
  });

  handle(IPC.EXPORT_START, async (payload) => {
    if (activeJob) return { ok: false, error: 'An export is already running.' };
    const { clips, options } = payload || {};
    const settings = settingsStore.get();
    const opts = Object.assign({ layout: settings.exportLayout, duplicateNaming: settings.duplicateNaming }, options || {});
    const plan = await planExport(clips || [], opts);
    if (!plan.destinationChecks.ok) {
      return { ok: false, error: (plan.destinationChecks.messages.find((m) => m.level === 'error') || {}).message || 'The export cannot start yet.', plan: Object.assign({}, plan, { validation: undefined }) };
    }
    const job = new ExportJob(plan, opts, (progress) => send(IPC.EXPORT_PROGRESS, progress));
    activeJob = job;
    send(IPC.EXPORT_PROGRESS, { stage: 'starting', percent: 0, completed: 0, total: plan.entries.length, destination: opts.destination });
    job
      .run()
      .then((result) => {
        activeJob = null;
        send(IPC.EXPORT_DONE, Object.assign({ ok: true }, result));
      })
      .catch((err) => {
        activeJob = null;
        send(IPC.EXPORT_DONE, { ok: false, error: (err && err.message) || 'The export could not be completed.' });
      });
    return { ok: true, started: true, total: plan.entries.length, destination: opts.destination, mode: opts.mode, layout: plan.summary.layout };
  });

  handle(IPC.EXPORT_CANCEL, async () => {
    if (!activeJob) return { ok: false, error: 'No export is running.' };
    activeJob.cancel();
    return { ok: true };
  });

  // ---- engines / demo / shell -------------------------------------------
  handle(IPC.DEMO_GENERATE, async () => {
    const already = demo.sampleExists(userDataDir);
    if (!already) {
      const engines = await media.checkEngines(process.resourcesPath, engineOptions());
      send(IPC.IMPORT_PROGRESS, {
        stage: 'sample',
        percent: 0,
        message: engines.ffmpeg.ok ? 'Creating sample clips with FFmpeg…' : 'Setting up sample clips…',
      });
    }
    const res = await demo.generateSampleClips(
      userDataDir,
      (done, total, label) => {
        send(IPC.IMPORT_PROGRESS, {
          stage: 'sample',
          percent: total ? Math.round((done / total) * 100) : 0,
          message: `Creating sample clip ${Math.min(done + 1, total)} of ${total} — ${label}`,
        });
      },
      process.resourcesPath,
      engineOptions()
    );
    for (const f of res.files) rememberMedia(f);
    return { ok: true, files: res.files, dir: res.dir, reused: already };
  });

  handle(IPC.SHELL_SHOW_ITEM, async (payload) => {
    const v = paths.validatePath(payload && payload.path);
    if (!v.ok) return { ok: false, error: v.reason };
    shell.showItemInFolder(v.path);
    return { ok: true };
  });

  handle(IPC.SHELL_OPEN_PATH, async (payload) => {
    const v = paths.validatePath(payload && payload.path);
    if (!v.ok) return { ok: false, error: v.reason };
    const err = await shell.openPath(v.path);
    return err ? { ok: false, error: 'The folder could not be opened.' } : { ok: true };
  });

  // ---- rename the files in place -----------------------------------------
  // This is the fast path: no copying, no extra disk space. It is the ONE
  // operation that touches the user's own files, so the renderer has to send
  // an explicit confirmation and the plan is verified before anything moves.
  let activeRename = null;
  let activeDownload = null;

  handle(IPC.RENAME_PLAN, async (payload) => {
    const { clips, options } = payload || {};
    const settings = settingsStore.get();
    const opts = Object.assign({ duplicateNaming: settings.duplicateNaming }, options || {});
    const plan = await planRename(clips || [], opts);
    for (const entry of plan.entries) if (entry.sourcePath) rememberMedia(entry.sourcePath);
    return { ok: true, plan: Object.assign({}, plan, { validation: undefined }) };
  });

  handle(IPC.RENAME_START, async (payload) => {
    if (activeRename) return { ok: false, error: 'A rename is already running.' };
    const { clips, options, confirmed } = payload || {};
    if (confirmed !== true) {
      return { ok: false, error: 'Renaming the original files needs an explicit confirmation.' };
    }
    const settings = settingsStore.get();
    const opts = Object.assign({ duplicateNaming: settings.duplicateNaming }, options || {});
    const plan = await planRename(clips || [], opts);
    const job = new RenameJob(plan, opts, (progress) => send(IPC.RENAME_PROGRESS, progress));
    activeRename = job;
    // The caller gets the result from this very call, so the UI can never be left
    // waiting on a progress dialog because an event went missing. The
    // RENAME_DONE broadcast stays for anyone else listening (menu actions, tests).
    try {
      const result = await job.run();
      activeRename = null;
      // The files have new names now — the streaming allow-list has to learn
      // them, otherwise the preview of a just-renamed clip is refused and the
      // player reports a broken file.
      for (const change of result.changes || []) if (change.to) rememberMedia(change.to);
      const payload = Object.assign({ ok: true }, result);
      send(IPC.RENAME_DONE, payload);
      return Object.assign({ started: true, finished: true }, payload);
    } catch (err) {
      activeRename = null;
      const payload = { ok: false, error: (err && err.message) || 'The files could not be renamed.' };
      send(IPC.RENAME_DONE, payload);
      return payload;
    }
  });

  handle(IPC.RENAME_CANCEL, async () => {
    if (!activeRename) return { ok: false, error: 'No rename is running.' };
    activeRename.cancel();
    return { ok: true };
  });

  handle(IPC.RENAME_UNDO, async (payload) => {
    const changes = (payload && payload.changes) || [];
    if (!changes.length) return { ok: false, error: 'There is nothing to put back.' };
    const res = await undoRename(changes, {
      emit: (progress) => send(IPC.RENAME_PROGRESS, Object.assign({ stage: 'undoing' }, progress)),
    });
    // Same story in reverse: the originals exist again and must be streamable.
    for (const item of res.results || []) if (item.status === 'restored' && item.from) rememberMedia(item.from);
    return res;
  });

  /**
   * Where a downloaded engine should live.
   *
   * The normal installer puts it next to the app (resources/ffmpeg). A portable
   * build unpacks into a temp folder that is wiped when the app closes, so there
   * it goes into the user's own data folder — which lib/media also searches.
   */
  function engineTargetDir() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(userDataDir, 'ffmpeg');
    return path.join(process.resourcesPath, 'ffmpeg');
  }

  // ---- optional FFmpeg download ------------------------------------------
  handle(IPC.ENGINE_DOWNLOAD, async (payload) => {
    if (activeDownload) return { ok: false, error: 'A download is already running.' };
    const controller = new AbortController();
    activeDownload = controller;
    const targetDir = engineTargetDir();
    const url = payload && payload.url ? String(payload.url) : '';
    engineDownload
      .installEngine({
        url,
        targetDir,
        signal: controller.signal,
        onProgress: (progress) => send(IPC.ENGINE_DOWNLOAD_PROGRESS, progress),
      })
      .then(async (result) => {
        activeDownload = null;
        media.resetEngineCache && media.resetEngineCache();
        const engines = await media.checkEngines(process.resourcesPath, engineOptions());
        send(IPC.ENGINE_DOWNLOAD_DONE, { ok: true, installed: result.installed, source: result.source, engines });
      })
      .catch((err) => {
        activeDownload = null;
        const cancelled = err && err.code === 'CANCELLED';
        send(IPC.ENGINE_DOWNLOAD_DONE, {
          ok: false,
          cancelled,
          error: cancelled ? 'Download cancelled.' : (err && err.message) || 'The engine could not be downloaded.',
        });
      });
    return { ok: true, started: true, targetDir };
  });

  handle(IPC.ENGINE_DOWNLOAD_CANCEL, async () => {
    if (!activeDownload) return { ok: false, error: 'No download is running.' };
    activeDownload.abort();
    return { ok: true };
  });

  // ---- links and full screen ---------------------------------------------
  /** The only external links the app opens — checked against an allow-list. */
  const ALLOWED_URLS = [
    /^https:\/\/(www\.)?youtube\.com\/@fusiononyoutube(\?.*)?$/i,
    /^https:\/\/(www\.)?youtube\.com\/channel\/[A-Za-z0-9_-]+(\?.*)?$/i,
  ];

  handle(IPC.SHELL_OPEN_URL, async (payload) => {
    const url = String((payload && payload.url) || '');
    if (!ALLOWED_URLS.some((rx) => rx.test(url))) {
      return { ok: false, error: 'That link is not part of the application.' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  handle(IPC.APP_TOGGLE_FULLSCREEN, async () => {
    if (!mainWindow) return { ok: false };
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return { ok: true, fullscreen: next };
  });

  handle(IPC.APP_SET_TITLE, async (payload) => {
    if (!mainWindow) return { ok: false };
    const name = (payload && payload.name) || '';
    const dirty = Boolean(payload && payload.dirty);
    mainWindow.setTitle(`${name ? `${dirty ? '• ' : ''}${name} — ` : ''}${APP_TITLE}`);
    return { ok: true };
  });

  handle(IPC.APP_QUIT_CONFIRM, async (payload) => {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Unsaved changes',
      message: payload && payload.message ? payload.message : 'You have unsaved changes in this project.',
      detail: 'Save the project metadata before closing? Your original footage is never modified.',
      buttons: ['Save and Exit', 'Exit Without Saving', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return { response: res.response };
  });

  handle(IPC.APP_CONFIRM_CLOSE, async () => {
    allowClose = true;
    stopAutosave();
    if (mainWindow) mainWindow.close();
    return { ok: true };
  });

  handle(IPC.APP_RELOAD_MENU, async () => {
    buildMenu();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/*
 * On Windows the media stack can decode HEVC/H.265 in hardware even though the
 * bundled software decoder cannot. Asking for the platform decoder costs
 * nothing when the machine has no support (the clip simply falls through to the
 * preview-proxy path), and it makes many camera files play natively instead.
 */
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

app.whenReady().then(async () => {
  userDataDir = app.getPath('userData');
  // Portable builds keep their downloaded engine in here too.
  media.setExtraEngineDirs([path.join(userDataDir, 'ffmpeg')]);
  const stored = settingsStore.init(userDataDir);
  cacheDir = stored.thumbnailCacheDir || paths.defaultCacheDir(userDataDir);
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
  } catch (_) {}

  app.setName(APP_TITLE);
  if (process.platform === 'win32') app.setAppUserModelId('com.fusionflix.cliprenamer');
  nativeTheme.themeSource = 'dark';

  registerProtocols();
  registerIpc();
  buildMenu();
  createWindow();
  startAutosave();

  // Housekeeping: keep the thumbnail cache from growing forever.
  media.pruneThumbnailCache(cacheDir).catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  stopAutosave();
});

// Basic hardening: refuse permission requests and unexpected new windows.
app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

process.on('uncaughtException', (err) => {
  // Log to the console only; the UI shows friendly errors through IPC.
  console.error('[fusion-flix] uncaught exception:', err && err.message ? err.message : err);
});

process.on('unhandledRejection', (err) => {
  console.error('[fusion-flix] unhandled rejection:', err && err.message ? err.message : err);
});

// Exposed for the headless end-to-end test harness only.
if (process.env.FF_E2E === '1') {
  module.exports = {
    getWindow: () => mainWindow,
    fittedWindowBounds,
    getState: () => ({ userDataDir, cacheDir, currentProjectPath, allowedMedia: Array.from(allowedMedia) }),
    getApp: () => app,
  };
}
