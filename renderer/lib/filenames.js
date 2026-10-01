/*
 * FUSION FLIX — shared library (works in Node and in the browser/Electron
 * renderer). This file is the single source of truth; renderer/lib/ holds a
 * byte-identical copy produced by `npm run sync` (tools/sync-lib.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sanitize'));
  } else {
    root.FFLib = factory(root.FFSanitize);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sanitize) {
  /**
   * FUSION FLIX — naming engine + project helpers.
   *
   * Pure functions shared by the main process, the preload bridge and the tests.
   * The renderer calls them through window.FF.core.*
   *
   * Standard name format:      S-[Scene]_SH-[Shot]_T-[Take]_([Scene]-[Shot]-[Take]).ext
   * Extra clips:               S-[Scene]_SH-[Shot]_T-[Take]_EXTRA_([Scene]-[Shot]-[Take]).ext
   *
   * The bracket always repeats Scene, Shot and Take (0 when a tag is switched
   * off) so an exported file is self-describing: S-1_SH-5_T-15_(1-5-15).mp4
   * Custom name enabled:       <custom name>.ext   (S/SH/T kept as metadata)
   */

  const {
    sanitizeFileName,
    pad2,
    sceneFolderName,
    UNASSIGNED_FOLDER,
    extOf,
    baseNameOf,
  } = sanitize;

  /** Video container extension → MIME type used by the media streaming protocol. */
  const VIDEO_EXTENSIONS = Object.freeze([
    'mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'mpg', 'mpeg',
    'm2ts', 'mts', 'ts', '3gp', '3g2', 'mxf', 'ogv', 'vob', 'dv', 'rm', 'rmvb',
    'asf', 'f4v', 'mp2', 'm2v', 'm4s',
  ]);

  const MIME_BY_EXT = Object.freeze({
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    m4s: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv',
    asf: 'video/x-ms-asf',
    flv: 'video/x-flv',
    f4v: 'video/mp4',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    m2v: 'video/mpeg',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    mts: 'video/mp2t',
    '3gp': 'video/3gpp',
    '3g2': 'video/3gpp2',
    mxf: 'application/mxf',
    ogv: 'video/ogg',
    vob: 'video/dvd',
    dv: 'video/dv',
    rm: 'application/vnd.rn-realmedia',
    rmvb: 'application/vnd.rn-realmedia-vbr',
  });

  /** Default settings for a brand new project (mirrors lib/settings.js defaults). */
  const DEFAULT_PROJECT_SETTINGS = Object.freeze({
    defaultExportLocation: '',
    defaultExportMode: 'folder', // export always copies (ZIP export was removed in 1.2.0)
    previewQuality: 'medium', // 'low' | 'medium' | 'high'
    autosaveEnabled: true,
    duplicateNaming: 'suffix', // 'suffix' | 'skip'
    timecodeFallback: 'file-time', // 'file-time' | 'zero' | 'index'
    theme: 'cinema', // 'cinema' | 'midnight'
  });

  const STATUS = Object.freeze({
    NEW: 'new',
    APPLIED: 'applied',
    EXPORTED: 'exported',
    SKIPPED: 'skipped',
    MISSING: 'missing',
  });

  /** True when the file looks like a supported video container. */
  function isSupportedVideo(filePath) {
    return VIDEO_EXTENSIONS.includes(extOf(filePath));
  }

  /** MIME for a path, falling back to a generic video type. */
  function mimeFor(filePath) {
    return MIME_BY_EXT[extOf(filePath)] || 'application/octet-stream';
  }

  function toIntOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(99999, n));
  }

  /** "01:05:15" / "00-00-01" / 3915.5 (seconds) → "HH-MM-SS". */
  function formatTimePart(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return secondsToTimePart(value);
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '00-00-00';

    if (/^-?\d+(\.\d+)?$/.test(raw)) return secondsToTimePart(Number(raw));

    // HH:MM:SS[:;.]FF  or  HH-MM-SS
    const m = raw.match(/^(\d{1,3})[:;.\-](\d{1,2})[:;.\-](\d{1,2})/);
    if (m) return `${pad2(m[1])}-${pad2(m[2])}-${pad2(m[3])}`;

    // MM:SS
    const m2 = raw.match(/^(\d{1,3})[:;.](\d{1,2})$/);
    if (m2) return `${pad2(0)}-${pad2(m2[1])}-${pad2(m2[2])}`;

    return '00-00-00';
  }

  /** Seconds → "HH-MM-SS" (hours can grow past 99 — clamped for sanity). */
  function secondsToTimePart(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.min(99, Math.floor(total / 3600));
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${pad2(h)}-${pad2(m)}-${pad2(s)}`;
  }

  /** "HH-MM-SS" → seconds. */
  function timePartToSeconds(timePart) {
    const m = String(timePart || '').match(/^(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /**
   * Computes the time text stored on a clip.
   * Prefers real source timecode, then the project's configured fallback.
   */
  function computeTimeText(meta = {}, options = {}) {
    const fallback = options.timecodeFallback || DEFAULT_PROJECT_SETTINGS.timecodeFallback;
    const index = Number.isFinite(options.index) ? options.index : 0;

    const rawTimecode = meta.timecode ? String(meta.timecode).trim() : '';
    const timecodeIsReal = Boolean(rawTimecode) && meta.timecodeFromSource !== false;
    if (timecodeIsReal) return formatTimePart(rawTimecode);

    if (fallback === 'zero') return '00-00-00';
    if (fallback === 'index') return secondsToTimePart(index);
    // 'file-time' — the moment the file was last written (stable, never random).
    const stamp = Number(meta.mtimeMs);
    if (Number.isFinite(stamp) && stamp > 0) {
      const d = new Date(stamp);
      return `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
    }
    return '00-00-00';
  }

  /** True when a clip has a usable custom name. */
  function hasCustomName(clip) {
    return Boolean(clip && clip.customOn && String(clip.custom || '').trim());
  }

  /**
   * The bracketed part of the file name: the Scene, Shot and Take numbers,
   * separated by dashes and nothing else — e.g. `(1-5-15)`.
   *
   * This used to be the clip time (`(01-05-15)`); the numbers people actually
   * sort footage by are the tags, so the brackets carry those now. A tag that
   * is switched off (or still empty) counts as 0, so the three positions always
   * stay readable.
   */
  function sceneShotTakePart(clip) {
    const num = (on, value) => (on && value !== null && value !== undefined && value !== '' ? toIntOrNull(value) : 0);
    const scene = num(clip && clip.sceneOn, clip && clip.scene);
    const shot = num(clip && clip.shotOn, clip && clip.shot);
    const take = num(clip && clip.takeOn, clip && clip.take);
    return `${scene === null ? 0 : scene}-${shot === null ? 0 : shot}-${take === null ? 0 : take}`;
  }

  /**
   * Builds the base name for a clip (no extension, no directory).
   * `clip` fields used: customOn, custom, sceneOn, scene, shotOn, shot, takeOn,
   * take, extra, fileName.
   */
  function buildBaseName(clip) {
    if (!clip || typeof clip !== 'object') return 'clip';

    if (hasCustomName(clip)) {
      // Custom name overrides the standard name but not the stored metadata.
      return sanitizeFileName(String(clip.custom).trim(), { fallback: 'clip' });
    }

    const parts = [];
    if (clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== '') {
      parts.push(`S-${toIntOrNull(clip.scene)}`);
    }
    if (clip.shotOn && clip.shot !== null && clip.shot !== undefined && clip.shot !== '') {
      parts.push(`SH-${toIntOrNull(clip.shot)}`);
    }
    if (clip.takeOn && clip.take !== null && clip.take !== undefined && clip.take !== '') {
      parts.push(`T-${toIntOrNull(clip.take)}`);
    }

    let base = parts.join('_');
    if (!base) {
      // Nothing enabled yet: fall back to the original name so the preview is
      // never empty or mysterious, but mark it clearly as "not named yet".
      const original = sanitizeFileName(baseNameOf(clip.fileName || clip.sourcePath || ''), { fallback: 'clip' });
      base = original;
    }

    if (clip.extra) base += '_EXTRA';

    // (Scene-Shot-Take) — never the time, never anything else.
    return `${base}_(${sceneShotTakePart(clip)})`;
  }

  /** True when the clip still uses the un-tagged fallback name. */
  function needsNaming(clip) {
    const anyEnabled = Boolean(
      (clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== '') ||
        (clip.shotOn && clip.shot !== null && clip.shot !== undefined && clip.shot !== '') ||
        (clip.takeOn && clip.take !== null && clip.take !== undefined && clip.take !== '') ||
        hasCustomName(clip)
    );
    return !anyEnabled;
  }

  /** Full output file name for a clip, extension preserved from the source. */
  function finalFileName(clip) {
    const ext = extOf(clip && (clip.fileName || clip.sourcePath)) || 'mp4';
    return `${buildBaseName(clip)}.${ext}`;
  }

  /** Relative path inside the export root — folders are created per Scene only. */
  function finalRelativePath(clip) {
    const folder = clip && clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== ''
      ? sceneFolderName(clip.scene)
      : UNASSIGNED_FOLDER;
    return `${folder}/${finalFileName(clip)}`;
  }

  /** Extra display flags used by the clip list. */
  function clipBadges(clip) {
    return {
      scene: clip.sceneOn ? toIntOrNull(clip.scene) : null,
      shot: clip.shotOn ? toIntOrNull(clip.shot) : null,
      take: clip.takeOn ? toIntOrNull(clip.take) : null,
      extra: Boolean(clip.extra),
      custom: hasCustomName(clip),
    };
  }

  /** Duration seconds → "1:04" / "1:02:03" (display helper). */
  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
    return `${m}:${pad2(s)}`;
  }

  /** Playback clock "mm:ss.d" for the preview (used under the timeline). */
  function formatClock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${pad2(m)}:${s.toFixed(1).padStart(4, '0')}`;
  }

  /** Frames per second rounding for display. */
  function formatFps(fps) {
    const v = Number(fps);
    if (!Number.isFinite(v) || v <= 0) return '';
    const rounded = Math.round(v * 100) / 100;
    return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
  }

  /** "1920 × 1080" */
  function formatResolution(w, h) {
    const W = Math.trunc(Number(w) || 0);
    const H = Math.trunc(Number(h) || 0);
    return W > 0 && H > 0 ? `${W} × ${H}` : '';
  }

  /** Scene/shot/take tuple used for duplicate detection. */
  function sstKey(clip) {
    const s = clip.sceneOn ? toIntOrNull(clip.scene) : null;
    const sh = clip.shotOn ? toIntOrNull(clip.shot) : null;
    const t = clip.takeOn ? toIntOrNull(clip.take) : null;
    if (s === null && sh === null && t === null) return '';
    return `${s === null ? '' : s}|${sh === null ? '' : sh}|${t === null ? '' : t}`;
  }

  /**
   * Sort helpers. Keys: import | scene | shot | take | filename.
   * Disabled fields always sort last, then by import order.
   */
  const SORT_KEYS = Object.freeze(['import', 'scene', 'shot', 'take', 'filename']);

  function sortClips(clips, key = 'import', dir = 1, enabled = {}) {
    const list = clips.slice();
    const sign = dir === -1 ? -1 : 1;
    const valueOf = (clip, k) => {
      if (k === 'filename') {
        return String(clip.fileName || '').toLowerCase();
      }
      const on = clip[`${k}On`];
      const v = clip[k];
      if (!on || v === null || v === undefined || v === '') return Infinity;
      return Number(v);
    };
    list.sort((a, b) => {
      if (key === 'import') return sign * ((a.order ?? 0) - (b.order ?? 0));
      const av = valueOf(a, key);
      const bv = valueOf(b, key);
      if (av === bv) return (a.order ?? 0) - (b.order ?? 0);
      if (av === Infinity) return 1;
      if (bv === Infinity) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return sign * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      }
      return sign * (av - bv);
    });
    if (key !== 'import' && enabled.secondary !== false) {
      // keep it stable and predictable; nothing else to do
    }
    return list;
  }

  /** Project summary used by the export panel and the status bar. */
  function projectSummary(clips) {
    const scenes = new Set();
    let extras = 0;
    let processed = 0;
    let missing = 0;
    let totalDuration = 0;
    for (const clip of clips) {
      if (clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== '') {
        scenes.add(toIntOrNull(clip.scene));
      }
      if (clip.extra) extras += 1;
      if (clip.status === STATUS.APPLIED || clip.status === STATUS.EXPORTED) processed += 1;
      if (clip.status === STATUS.MISSING) missing += 1;
      totalDuration += Number(clip.meta && clip.meta.duration) || 0;
    }
    return {
      total: clips.length,
      processed,
      scenes: scenes.size,
      extras,
      missing,
      totalDuration,
    };
  }


  return {
  VIDEO_EXTENSIONS,
  MIME_BY_EXT,
  DEFAULT_PROJECT_SETTINGS,
  STATUS,
  SORT_KEYS,
  isSupportedVideo,
  mimeFor,
  toIntOrNull,
  formatTimePart,
  secondsToTimePart,
  timePartToSeconds,
  computeTimeText,
  hasCustomName,
  buildBaseName,
  needsNaming,
  finalFileName,
  finalRelativePath,
  clipBadges,
  formatDuration,
  formatClock,
  formatFps,
  formatResolution,
  sstKey,
  sortClips,
  projectSummary,
  sceneFolderName,
  sceneShotTakePart,
  UNASSIGNED_FOLDER,
  sanitizeFileName,
  extOf,
  baseNameOf,
  pad2,
};
});
