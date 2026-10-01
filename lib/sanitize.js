/*
 * FUSION FLIX — shared library (works in Node and in the browser/Electron
 * renderer). This file is the single source of truth; renderer/lib/ holds a
 * byte-identical copy produced by `npm run sync` (tools/sync-lib.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FFSanitize = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * FUSION FLIX — filename sanitising helpers.
   *
   * Everything that ends up as a file name on disk passes through here.
   * Pure functions only: no fs, no electron. Unit-tested in tests/filenames.test.js
   */

  /** Characters Windows forbids in file names. */
  const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
  /** Device names Windows reserves (case-insensitive, with or without extension). */
  const RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);

  /** Maximum length we allow for a generated file name (characters). */
  const MAX_NAME_LENGTH = 120;

  /**
   * Makes any user-provided text safe to use as a file name.
   * - strips characters Windows rejects
   * - collapses whitespace runs
   * - removes trailing dots/spaces (Windows silently drops them, which breaks compares)
   * - avoids reserved device names
   * - never returns an empty string
   */
  function sanitizeFileName(input, options = {}) {
    const fallback = options.fallback === undefined ? 'clip' : String(options.fallback);
    let name = String(input == null ? '' : input);

    // Normalise exotic whitespace (incl. NBSP) to plain spaces.
    name = name.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
    name = name.replace(FORBIDDEN_CHARS, options.replacement === undefined ? ' ' : options.replacement);
    name = name.replace(/\s+/g, ' ').trim();

    // Windows strips these anyway; compare-safety means we strip them too.
    name = name.replace(/[. ]+$/g, '');

    // Reserved device name check (on the stem, ignoring extension).
    const stem = name.split('.')[0].toUpperCase();
    if (RESERVED_NAMES.has(stem)) name = `_${name}`;

    if (name.length > MAX_NAME_LENGTH) {
      // Trim on a character basis but never split a surrogate pair.
      let cut = name.slice(0, MAX_NAME_LENGTH);
      const last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
      name = cut.replace(/[. ]+$/g, '').trim();
    }

    return name || fallback;
  }

  /** Two-digit zero padding used by the standard naming format. */
  function pad2(n) {
    const v = Math.max(0, Math.trunc(Number(n) || 0));
    return String(v).padStart(2, '0');
  }

  /** Scene folders are always Scene_01, Scene_02 … (never Shot/Take folders). */
  function sceneFolderName(sceneNumber) {
    const n = Math.max(0, Math.trunc(Number(sceneNumber) || 0));
    return `Scene_${String(n).padStart(2, '0')}`;
  }

  /** Folder used for clips that have no scene assigned yet. */
  const UNASSIGNED_FOLDER = 'Unassigned';

  /** Extension of a path or name, lower-cased, without the dot. '' when none. */
  function extOf(p) {
    const s = String(p || '');
    const base = s.replace(/\\/g, '/').split('/').pop() || '';
    const i = base.lastIndexOf('.');
    if (i <= 0) return ''; // dotfiles have no extension
    return base.slice(i + 1).toLowerCase();
  }

  /** Base name (no directory, no extension). */
  function baseNameOf(p) {
    const s = String(p || '');
    const base = s.replace(/\\/g, '/').split('/').pop() || '';
    const i = base.lastIndexOf('.');
    return i <= 0 ? base : base.slice(0, i);
  }

  /** Replaces the extension of `p` with `ext` (ext without dot). */
  function withExt(p, ext) {
    return `${baseNameOf(p)}.${String(ext).replace(/^\./, '')}`;
  }

  /** Joins a folder + name using the separator style of `folder`. */
  function joinDisplay(folder, name) {
    const f = String(folder || '');
    const sep = f.includes('\\') && !f.includes('/') ? '\\' : '/';
    return f ? `${f.replace(/[\\/]+$/, '')}${sep}${name}` : name;
  }


  return {
  FORBIDDEN_CHARS,
  RESERVED_NAMES,
  MAX_NAME_LENGTH,
  UNASSIGNED_FOLDER,
  sanitizeFileName,
  pad2,
  sceneFolderName,
  extOf,
  baseNameOf,
  withExt,
  joinDisplay,
};
});
