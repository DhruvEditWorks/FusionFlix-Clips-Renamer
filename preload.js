'use strict';
/**
 * FUSION FLIX — preload bridge.
 *
 * This is the ONLY door between the sandboxed renderer and Node/Electron.
 * Nothing else is exposed: no fs, no path, no child_process, no ipcRenderer
 * object itself — only named operations.
 *
 * NOTE: this preload runs with `sandbox: true`, so it may not require() local
 * files. The channel names below are therefore inlined; tests/ipc.test.js
 * fails the build if they ever drift from lib/ipc.js.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// --- BEGIN CHANNELS (kept in sync with lib/ipc.js — see tests/ipc.test.js) ---
const CHANNELS = {
  APP_INFO: 'app:info',
  APP_SET_TITLE: 'app:setTitle',
  APP_QUIT_CONFIRM: 'app:quitConfirm',
  APP_CONFIRM_CLOSE: 'app:confirmClose',
  APP_RELOAD_MENU: 'app:reloadMenu',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHECK_ENGINES: 'settings:checkEngines',
  SETTINGS_CLEAR_THUMBS: 'settings:clearThumbs',
  SETTINGS_PRUNE_THUMBS: 'settings:pruneThumbs',
  SETTINGS_CHOOSE_CACHE: 'settings:chooseCache',
  SETTINGS_LOCATE_ENGINE: 'settings:locateEngine',

  DIALOG_OPEN_CLIPS: 'dialog:openClips',
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',
  DIALOG_OPEN_PROJECT: 'dialog:openProject',
  DIALOG_SAVE_PROJECT: 'dialog:saveProject',
  DIALOG_CHOOSE_DESTINATION: 'dialog:chooseDestination',
  DIALOG_CHOOSE_VIDEO: 'dialog:chooseVideo',
  DIALOG_MESSAGE: 'dialog:message',

  IMPORT_PATHS: 'import:paths',
  IMPORT_CANCEL: 'import:cancel',
  IMPORT_PROGRESS: 'import:progress',

  MEDIA_THUMB: 'media:thumb',
  MEDIA_PROXY: 'media:proxy',
  MEDIA_PROXY_CANCEL: 'media:proxyCancel',
  MEDIA_PROXY_PROGRESS: 'media:proxyProgress',
  MEDIA_PROBE: 'media:probe',

  PROJECT_SAVE: 'project:save',
  PROJECT_OPEN: 'project:open',
  PROJECT_CHECK_MEDIA: 'project:checkMedia',
  PROJECT_RELINK: 'project:relink',
  PROJECT_REGISTER_MEDIA: 'project:registerMedia',
  PROJECT_SET_PATH: 'project:setPath',

  AUTOSAVE_WRITE: 'autosave:write',
  AUTOSAVE_LIST: 'autosave:list',
  AUTOSAVE_READ: 'autosave:read',
  AUTOSAVE_DISCARD: 'autosave:discard',
  AUTOSAVE_TICK: 'autosave:tick',

  EXPORT_PLAN: 'export:plan',
  EXPORT_START: 'export:start',
  EXPORT_CANCEL: 'export:cancel',
  EXPORT_PROGRESS: 'export:progress',
  EXPORT_DONE: 'export:done',

  // rename (rename the files in place — no copying)
  RENAME_PLAN: 'rename:plan',
  RENAME_START: 'rename:start',
  RENAME_CANCEL: 'rename:cancel',
  RENAME_PROGRESS: 'rename:progress',
  RENAME_DONE: 'rename:done',
  RENAME_UNDO: 'rename:undo',

  // optional media-engine download (Settings → Download FFmpeg)
  ENGINE_DOWNLOAD: 'engine:download',
  ENGINE_DOWNLOAD_CANCEL: 'engine:downloadCancel',
  ENGINE_DOWNLOAD_PROGRESS: 'engine:downloadProgress',
  ENGINE_DOWNLOAD_DONE: 'engine:downloadDone',

  DEMO_GENERATE: 'demo:generate',
  SHELL_SHOW_ITEM: 'shell:showItem',
  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_OPEN_URL: 'shell:openUrl',
  APP_TOGGLE_FULLSCREEN: 'app:toggleFullscreen',

  MENU_ACTION: 'menu:action',
  BEFORE_CLOSE: 'app:beforeClose',
  ENGINE_NOTICE: 'engine:notice',
};
// --- END CHANNELS ---------------------------------------------------------

/** Events the renderer is allowed to subscribe to. */
const EVENT_CHANNELS = new Set([
  CHANNELS.MENU_ACTION,
  CHANNELS.IMPORT_PROGRESS,
  CHANNELS.EXPORT_PROGRESS,
  CHANNELS.EXPORT_DONE,
  CHANNELS.RENAME_PROGRESS,
  CHANNELS.RENAME_DONE,
  CHANNELS.ENGINE_DOWNLOAD_PROGRESS,
  CHANNELS.ENGINE_DOWNLOAD_DONE,
  CHANNELS.AUTOSAVE_TICK,
  CHANNELS.BEFORE_CLOSE,
  CHANNELS.ENGINE_NOTICE,
  CHANNELS.MEDIA_PROXY_PROGRESS,
]);

const registered = new Map();

function on(channel, listener) {
  if (!EVENT_CHANNELS.has(channel) || typeof listener !== 'function') return;
  const wrapped = (_event, payload) => {
    try {
      listener(payload);
    } catch (err) {
      // A broken listener must never take the app down.
      console.error('[fusion-flix] listener error:', err && err.message);
    }
  };
  if (!registered.has(channel)) registered.set(channel, new Map());
  registered.get(channel).set(listener, wrapped);
  ipcRenderer.on(channel, wrapped);
}

/**
 * Unsubscribes a listener.
 *
 * `off(channel)` clears the channel; `off(channel, fn)` removes that one
 * listener — and when it cannot find it, it removes NOTHING.
 *
 * Both halves matter. Every function handed across the context bridge gets a
 * fresh proxy inside this file, so a renderer function is not always equal to
 * itself here; the old code treated "not found" as "clear the channel", which
 * silently unhooked the application's own handlers (a rename would finish and
 * no report ever appeared). Matching on source text is no safer — bridged
 * functions can all report "[native code]" — so identity is the only rule and
 * an unknown listener is a harmless no-op.
 */
function off(channel, listener) {
  const map = registered.get(channel);
  if (!map) return;
  if (!listener) {
    for (const wrapped of map.values()) ipcRenderer.removeListener(channel, wrapped);
    map.clear();
    return;
  }
  if (map.has(listener)) {
    ipcRenderer.removeListener(channel, map.get(listener));
    map.delete(listener);
  }
  // Unknown listener: leave every other subscriber alone.
}

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('FF', {
  channels: CHANNELS,

  appInfo: call(CHANNELS.APP_INFO),
  setTitle: call(CHANNELS.APP_SET_TITLE),
  quitConfirm: call(CHANNELS.APP_QUIT_CONFIRM),
  confirmClose: call(CHANNELS.APP_CONFIRM_CLOSE),
  reloadMenu: call(CHANNELS.APP_RELOAD_MENU),

  settings: {
    get: call(CHANNELS.SETTINGS_GET),
    set: call(CHANNELS.SETTINGS_SET),
    checkEngines: call(CHANNELS.SETTINGS_CHECK_ENGINES),
    clearThumbs: call(CHANNELS.SETTINGS_CLEAR_THUMBS),
    pruneThumbs: call(CHANNELS.SETTINGS_PRUNE_THUMBS),
    chooseCacheDir: call(CHANNELS.SETTINGS_CHOOSE_CACHE),
    locateEngine: call(CHANNELS.SETTINGS_LOCATE_ENGINE),
  },

  dialog: {
    openClips: call(CHANNELS.DIALOG_OPEN_CLIPS),
    openFolder: call(CHANNELS.DIALOG_OPEN_FOLDER),
    openProject: call(CHANNELS.DIALOG_OPEN_PROJECT),
    saveProject: call(CHANNELS.DIALOG_SAVE_PROJECT),
    chooseDestination: call(CHANNELS.DIALOG_CHOOSE_DESTINATION),
    chooseVideo: call(CHANNELS.DIALOG_CHOOSE_VIDEO),
    message: call(CHANNELS.DIALOG_MESSAGE),
  },

  importClips: {
    run: call(CHANNELS.IMPORT_PATHS),
    cancel: call(CHANNELS.IMPORT_CANCEL),
  },

  media: {
    thumbnail: call(CHANNELS.MEDIA_THUMB),
    /** Builds (or reuses) a playable H.264 preview proxy for one clip. */
    proxy: call(CHANNELS.MEDIA_PROXY),
    cancelProxy: call(CHANNELS.MEDIA_PROXY_CANCEL),
    probe: call(CHANNELS.MEDIA_PROBE),
  },

  project: {
    save: call(CHANNELS.PROJECT_SAVE),
    open: call(CHANNELS.PROJECT_OPEN),
    checkMedia: call(CHANNELS.PROJECT_CHECK_MEDIA),
    relink: call(CHANNELS.PROJECT_RELINK),
    registerMedia: call(CHANNELS.PROJECT_REGISTER_MEDIA),
    setPath: call(CHANNELS.PROJECT_SET_PATH),
  },

  autosave: {
    write: call(CHANNELS.AUTOSAVE_WRITE),
    list: call(CHANNELS.AUTOSAVE_LIST),
    read: call(CHANNELS.AUTOSAVE_READ),
    discard: call(CHANNELS.AUTOSAVE_DISCARD),
  },

  exporter: {
    plan: call(CHANNELS.EXPORT_PLAN),
    start: call(CHANNELS.EXPORT_START),
    cancel: call(CHANNELS.EXPORT_CANCEL),
  },

  /**
   * Rename the files in place (no copying). The renderer must send an explicit
   * `confirmed: true` — nothing here touches a source file by accident.
   */
  renamer: {
    plan: call(CHANNELS.RENAME_PLAN),
    start: call(CHANNELS.RENAME_START),
    cancel: call(CHANNELS.RENAME_CANCEL),
    undo: call(CHANNELS.RENAME_UNDO),
  },

  /** Optional FFmpeg download (the app runs fine without it). */
  engineDownload: {
    start: call(CHANNELS.ENGINE_DOWNLOAD),
    cancel: call(CHANNELS.ENGINE_DOWNLOAD_CANCEL),
  },

  demo: { generate: call(CHANNELS.DEMO_GENERATE) },

  shell: {
    showItem: call(CHANNELS.SHELL_SHOW_ITEM),
    openPath: call(CHANNELS.SHELL_OPEN_PATH),
    /** Opens a link in the user's browser — the URL is checked against a list. */
    openUrl: call(CHANNELS.SHELL_OPEN_URL),
  },

  /** Window full screen (Ctrl+F). */
  toggleFullscreen: call(CHANNELS.APP_TOGGLE_FULLSCREEN),

  on,
  off,

  /** Safe file-path lookup for drag & drop (Electron ≥ 32 removed File.path). */
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (_) {
      return '';
    }
  },

  /** URL builders for the validating streaming protocols. */
  mediaUrl(filePath) {
    return `ffmedia://clip/${encodeURIComponent(String(filePath || ''))}`;
  },
  thumbUrl(filePath) {
    return `ffthumb://thumb/${encodeURIComponent(String(filePath || ''))}`;
  },
});
