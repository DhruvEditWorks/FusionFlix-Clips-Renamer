'use strict';
/**
 * FUSION FLIX — persistent app settings (separate from project files).
 * Stored in Electron's userData folder as settings.json.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULTS = Object.freeze({
  // Export
  defaultExportLocation: '',
  defaultExportMode: 'folder', // 'folder' only — copies of the footage
  // Where the copies land inside the destination: 'flat' puts every renamed
  // file straight into the chosen folder, 'scenes' creates Scene_01/… folders.
  exportLayout: 'flat',
  // Preview
  previewQuality: 'medium', // 'low' | 'medium' | 'high'  -> hover preview width
  hoverPreroll: true, // hovering a clip loads it into the main preview too
  // Hover shuttle: moving the pointer to the left/right of the player shuttles
  // backwards / forwards. OFF by default — it was found to be distracting.
  hoverShuttle: false,
  // Skip the copy step entirely: rename the files in place instead of exporting.
  preferRename: true,
  // Tagging
  // Scene / Shot / Take start switched on for every newly imported clip.
  defaultSceneOn: true,
  defaultShotOn: true,
  defaultTakeOn: true,
  defaultSceneValue: 1,
  defaultShotValue: 1,
  defaultTakeValue: 1,
  // Ticking Scene / Shot / Take (mouse or shortcut) fills the box from the
  // previous clip + 1 when it is still empty.
  autoFillFromPrevious: true,
  // Ticking Custom Name switches Scene / Shot / Take off (the custom name
  // replaces the standard S-x_SH-y_T-z filename anyway).
  customNameClearsTagging: true,
  // Files
  autosaveEnabled: true,
  autosaveSeconds: 30,
  duplicateNaming: 'suffix', // 'suffix' | 'skip'
  timecodeFallback: 'file-time', // 'file-time' | 'zero' | 'index'
  // Appearance
  theme: 'cinema', // 'cinema' | 'midnight' | 'daylight'
  accentColor: '#f0562f',
  focusMode: false, // start with the side panels hidden (preview only)
  // Keyboard
  shortcuts: {}, // { actionId: 'Ctrl+X' } — empty means "use the defaults"
  // Housekeeping
  thumbnailCacheDir: '',
  // Optional explicit media-engine paths (Settings → Locate FFmpeg)
  ffmpegPath: '',
  ffprobePath: '',
  confirmDelete: true,
  lastProjectDir: '',
  // Saved pane sizes of the workspace: width of the clip list on the right and
  // height of the renaming console at the bottom (the preview takes the rest).
  layout: { right: 0, consoleH: 0 },
  windowBounds: null,
  demoProjectCreated: false,
});

const PREVIEW_WIDTHS = Object.freeze({ low: 320, medium: 480, high: 720 });

let settingsPath = '';
let cache = null;

function init(userDataDir) {
  settingsPath = path.join(userDataDir, 'settings.json');
  cache = null;
  return load();
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    if (settingsPath && fs.existsSync(settingsPath)) {
      stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (_) {
    stored = {};
  }
  cache = Object.assign({}, DEFAULTS, stored && typeof stored === 'object' ? stored : {});
  return cache;
}

async function save(patch) {
  const current = load();
  const next = Object.assign({}, current, patch || {});
  // never persist unknown junk
  for (const key of Object.keys(next)) {
    if (!(key in DEFAULTS)) delete next[key];
  }
  cache = next;
  try {
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tmp, settingsPath);
  } catch (_) {
    /* non-fatal */
  }
  return cache;
}

function get() {
  return Object.assign({}, load());
}

function previewWidth() {
  const q = load().previewQuality;
  return PREVIEW_WIDTHS[q] || PREVIEW_WIDTHS.medium;
}

module.exports = { DEFAULTS, PREVIEW_WIDTHS, init, load, get, save, previewWidth, get path() { return settingsPath; } };
