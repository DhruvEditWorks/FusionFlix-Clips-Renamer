'use strict';
/**
 * FUSION FLIX — path safety helpers.
 *
 * Every path that arrives from the renderer is treated as untrusted input and
 * checked here before it reaches fs / ffmpeg / the shell.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const UNC_PATH = /^\\\\[^\\]+\\[^\\]+/;

function isWindowsPlatform() {
  return process.platform === 'win32';
}

/** Removes surrounding quotes/whitespace and normalises separators. */
function cleanInputPath(input) {
  let p = String(input == null ? '' : input).trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  return p;
}

/** Rejects NUL bytes and absurdly long strings outright. */
function hasIllegalChars(p) {
  return /[\u0000-\u001f]/.test(p) || p.length > 4096;
}

/** True for absolute Windows (C:\… or \\server\share) or POSIX (/…) paths. */
function isAbsolutePath(p) {
  const s = cleanInputPath(p);
  if (!s) return false;
  return WINDOWS_DRIVE.test(s) || UNC_PATH.test(s) || path.isAbsolute(s) || path.posix.isAbsolute(s);
}

/** Absolute Windows path check that works even when running on Linux (tests). */
function isWindowsAbsolutePath(p) {
  const s = cleanInputPath(p);
  return WINDOWS_DRIVE.test(s) || UNC_PATH.test(s);
}

/**
 * Validates a path coming from the renderer.
 * Returns { ok:true, path } or { ok:false, reason }.
 */
function validatePath(input) {
  const raw = cleanInputPath(input);
  if (!raw) return { ok: false, reason: 'Empty path.' };
  if (hasIllegalChars(raw)) return { ok: false, reason: 'Path contains illegal characters.' };
  if (!isAbsolutePath(raw)) return { ok: false, reason: 'Only absolute paths are accepted.' };
  return { ok: true, path: path.normalize(raw) };
}

/** Validates a path that must point at an existing file. */
function validateExistingFile(input) {
  const v = validatePath(input);
  if (!v.ok) return v;
  try {
    const st = fs.statSync(v.path);
    if (!st.isFile()) return { ok: false, reason: 'That path is not a file.' };
  } catch (_) {
    return { ok: false, reason: 'The file could not be found.' };
  }
  return v;
}

/** Normalises separators for storage/display (keeps native form on Windows). */
function normalizePath(p) {
  const s = cleanInputPath(p);
  if (!s) return '';
  if (isWindowsAbsolutePath(s)) return path.win32.normalize(s);
  return path.normalize(s);
}

/** Windows-style key for case-insensitive path comparison. */
function pathKey(p) {
  const s = path.normalize(cleanInputPath(p));
  return isWindowsPlatform() || isWindowsAbsolutePath(s) ? s.toLowerCase() : s;
}

/** True when `child` is inside `parent` (or equals it). */
function isInside(parent, child) {
  if (!parent || !child) return false;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : path.sep;
  const p = path.normalize(parent).replace(/[\\/]+$/, '');
  const c = path.normalize(child).replace(/[\\/]+$/, '');
  const keyP = pathKey(p);
  const keyC = pathKey(c);
  if (keyP === keyC) return true;
  const withSep = keyP.endsWith(sep) ? keyP : keyP + sep;
  return keyC.startsWith(withSep);
}

/** Joins parts onto a base folder, refusing to escape it. */
function safeJoin(base, ...parts) {
  const joined = path.join(base, ...parts);
  if (!isInside(base, joined)) {
    throw new Error('Refusing to write outside the target folder.');
  }
  return joined;
}

/**
 * Returns a path that does not exist yet, by appending _01, _02 …
 * `exists` defaults to fs.existsSync — injectable for tests.
 */
function uniquePath(target, exists = fs.existsSync) {
  if (!exists(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let i = 1; i < 9999; i++) {
    const candidate = path.join(dir, `${stem}_${String(i).padStart(2, '0')}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error('Could not find an unused file name.');
}

/** Best-effort base folder for the app's own data (never source footage). */
function defaultCacheDir(userDataDir) {
  if (userDataDir) return path.join(userDataDir, 'thumbnails');
  return path.join(os.tmpdir(), 'fusion-flix-thumbnails');
}

/** Free bytes on the volume containing `p` (undefined when unsupported). */
async function freeSpaceAt(p) {
  try {
    if (typeof fs.promises.statfs !== 'function') return undefined;
    const stats = await fs.promises.statfs(p);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return undefined;
  }
}

/** Human readable byte size. */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  isWindowsPlatform,
  cleanInputPath,
  hasIllegalChars,
  isAbsolutePath,
  isWindowsAbsolutePath,
  validatePath,
  validateExistingFile,
  normalizePath,
  pathKey,
  isInside,
  safeJoin,
  uniquePath,
  defaultCacheDir,
  freeSpaceAt,
  formatBytes,
};
