'use strict';
/**
 * FUSION FLIX — IPC channel names.
 * Kept in one place so main.js and preload.js can never drift apart.
 */

module.exports = Object.freeze({
  // app
  APP_INFO: 'app:info',
  APP_SET_TITLE: 'app:setTitle',
  APP_QUIT_CONFIRM: 'app:quitConfirm',
  APP_CONFIRM_CLOSE: 'app:confirmClose',
  APP_RELOAD_MENU: 'app:reloadMenu',

  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHECK_ENGINES: 'settings:checkEngines',
  SETTINGS_CLEAR_THUMBS: 'settings:clearThumbs',
  SETTINGS_PRUNE_THUMBS: 'settings:pruneThumbs',
  SETTINGS_CHOOSE_CACHE: 'settings:chooseCache',
  SETTINGS_LOCATE_ENGINE: 'settings:locateEngine',

  // dialogs
  DIALOG_OPEN_CLIPS: 'dialog:openClips',
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',
  DIALOG_OPEN_PROJECT: 'dialog:openProject',
  DIALOG_SAVE_PROJECT: 'dialog:saveProject',
  DIALOG_CHOOSE_DESTINATION: 'dialog:chooseDestination',
  DIALOG_CHOOSE_VIDEO: 'dialog:chooseVideo',
  DIALOG_MESSAGE: 'dialog:message',

  // import
  IMPORT_PATHS: 'import:paths',
  IMPORT_CANCEL: 'import:cancel',
  IMPORT_PROGRESS: 'import:progress',

  // media
  MEDIA_THUMB: 'media:thumb',
  MEDIA_PROBE: 'media:probe',
  MEDIA_PROXY: 'media:proxy',
  MEDIA_PROXY_CANCEL: 'media:proxyCancel',
  MEDIA_PROXY_PROGRESS: 'media:proxyProgress',

  // project
  PROJECT_SAVE: 'project:save',
  PROJECT_OPEN: 'project:open',
  PROJECT_CHECK_MEDIA: 'project:checkMedia',
  PROJECT_RELINK: 'project:relink',
  PROJECT_REGISTER_MEDIA: 'project:registerMedia',
  PROJECT_SET_PATH: 'project:setPath',

  // autosave / recovery
  AUTOSAVE_WRITE: 'autosave:write',
  AUTOSAVE_LIST: 'autosave:list',
  AUTOSAVE_READ: 'autosave:read',
  AUTOSAVE_DISCARD: 'autosave:discard',
  AUTOSAVE_TICK: 'autosave:tick',

  // export
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

  // demo + shell
  DEMO_GENERATE: 'demo:generate',
  SHELL_SHOW_ITEM: 'shell:showItem',
  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_OPEN_URL: 'shell:openUrl',
  APP_TOGGLE_FULLSCREEN: 'app:toggleFullscreen',

  // events pushed from main → renderer
  MENU_ACTION: 'menu:action',
  BEFORE_CLOSE: 'app:beforeClose',
  ENGINE_NOTICE: 'engine:notice',
});
