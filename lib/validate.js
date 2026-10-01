/*
 * FUSION FLIX — shared library (works in Node and in the browser/Electron
 * renderer). This file is the single source of truth; renderer/lib/ holds a
 * byte-identical copy produced by `npm run sync` (tools/sync-lib.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./filenames'));
  } else {
    root.FFValidate = factory(root.FFLib);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (filenames) {
  /**
   * FUSION FLIX — validation & pre-export planning.
   *
   * Used by the renderer (live warnings while tagging) and by the main process
   * (authoritative checks right before files are written). Pure functions.
   */

  const {
    finalFileName,
    finalRelativePath,
    isSupportedVideo,
    extOf,
    STATUS,
    sstKey,
    buildBaseName,
    formatDuration,
  } = filenames;

  const LEVEL = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

  function issue(level, code, message, extra) {
    return Object.assign({ level, code, message }, extra || {});
  }

  /**
   * Validates a single clip's metadata (no disk access).
   * Returns an array of issues (possibly empty).
   */
  function validateClip(clip) {
    const out = [];

    if (!clip) return [issue(LEVEL.ERROR, 'no-clip', 'This clip is not available.')];

    if (clip.sceneOn && (clip.scene === null || clip.scene === undefined || clip.scene === '')) {
      out.push(issue(LEVEL.ERROR, 'scene-empty', 'Scene is enabled but empty.', { field: 'scene' }));
    }
    if (clip.shotOn && (clip.shot === null || clip.shot === undefined || clip.shot === '')) {
      out.push(issue(LEVEL.ERROR, 'shot-empty', 'Shot is enabled but empty.', { field: 'shot' }));
    }
    if (clip.takeOn && (clip.take === null || clip.take === undefined || clip.take === '')) {
      out.push(issue(LEVEL.ERROR, 'take-empty', 'Take is enabled but empty.', { field: 'take' }));
    }
    for (const field of ['scene', 'shot', 'take']) {
      const v = clip[field];
      if (v !== null && v !== undefined && v !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
        out.push(issue(LEVEL.ERROR, `bad-${field}`, `${field[0].toUpperCase()}${field.slice(1)} must be a whole number (0 or more).`, { field }));
      }
    }

    if (clip.customOn) {
      const custom = String(clip.custom || '').trim();
      if (!custom) {
        out.push(issue(LEVEL.ERROR, 'custom-empty', 'Custom name is enabled but empty.', { field: 'custom' }));
      } else if (/[<>:"/\\|?*\u0000-\u001f]/.test(custom)) {
        out.push(issue(LEVEL.WARNING, 'custom-chars', 'Custom name contains characters Windows does not allow — they will be replaced automatically.', { field: 'custom' }));
      }
    }

    const ext = extOf(clip.fileName || clip.sourcePath);
    if (!ext) {
      out.push(issue(LEVEL.ERROR, 'no-extension', 'The source file has no extension, so the output format is unknown.'));
    } else if (!isSupportedVideo(`x.${ext}`)) {
      out.push(issue(LEVEL.WARNING, 'unsupported-ext', `".${ext}" is not a recognised video format. It will be copied as-is.`));
    }

    if (clip.status === STATUS.MISSING) {
      out.push(issue(LEVEL.ERROR, 'missing-media', 'Media Missing — the source file could not be found. Use Relink Clip.'));
    }

    return out;
  }

  /**
   * Validates the whole project and computes duplicate information.
   *
   * Returns:
   * {
   *   byClip: { [clipId]: issue[] },
   *   duplicates: { name: [clipId...] },        // same Scene folder + same name
   *   duplicateSST: { key: [clipId...] },       // same Scene/Shot/Take combination
   *   errorCount, warningCount, affectedIds: Set-like array
   * }
   */
  function validateProject(clips) {
    const byClip = Object.create(null);
    const byPath = Object.create(null);
    const sst = Object.create(null);
    let errorCount = 0;
    let warningCount = 0;

    for (const clip of clips || []) {
      const list = validateClip(clip);
      byClip[clip.id] = list;
    }

    // Duplicate output names (folder + file name), case-insensitive like Windows.
    for (const clip of clips || []) {
      const rel = finalRelativePath(clip).toLowerCase();
      (byPath[rel] = byPath[rel] || []).push(clip.id);
    }
    const duplicates = Object.create(null);
    for (const rel of Object.keys(byPath)) {
      if (byPath[rel].length > 1) duplicates[rel] = byPath[rel];
    }

    // Duplicate Scene/Shot/Take combinations.
    for (const clip of clips || []) {
      const key = sstKey(clip);
      if (!key) continue;
      (sst[key] = sst[key] || []).push(clip.id);
    }
    const duplicateSST = Object.create(null);
    for (const key of Object.keys(sst)) {
      if (sst[key].length > 1) duplicateSST[key] = sst[key];
    }

    for (const clip of clips || []) {
      const list = byClip[clip.id] || [];
      const rel = finalRelativePath(clip).toLowerCase();
      const dupName = duplicates[rel];
      if (dupName && dupName.length > 1) {
        list.push(
          issue(LEVEL.WARNING, 'duplicate-name', `Another clip exports as "${finalFileName(clip)}". A suffix (_01, _02 …) will be added automatically.`, {
            auto: true,
          })
        );
      }
      const key = sstKey(clip);
      if (key && duplicateSST[key] && duplicateSST[key].length > 1) {
        list.push(issue(LEVEL.WARNING, 'duplicate-sst', 'Another clip already uses this Scene / Shot / Take combination.', { auto: true }));
      }
      for (const it of list) {
        if (it.level === LEVEL.ERROR) errorCount += 1;
        else if (it.level === LEVEL.WARNING) warningCount += 1;
      }
    }

    const affectedIds = [];
    for (const id of Object.keys(byClip)) if (byClip[id] && byClip[id].length) affectedIds.push(id);

    return { byClip, duplicates, duplicateSST, errorCount, warningCount, affectedIds };
  }

  /**
   * Deterministic duplicate resolution: keeps the first clip's name, then adds
   * _01, _02 … (before the extension) to later clips in the same folder.
   * Returns a map clipId → { fileName, relPath, renamed } and the collision list.
   */
  function resolveOutputNames(clips) {
    const used = Object.create(null);
    const result = Object.create(null);
    const renamed = [];

    for (const clip of clips || []) {
      const folder = finalRelativePath(clip).split('/')[0];
      const name = finalFileName(clip);
      const key = `${folder}/${name}`.toLowerCase();
      let outName = name;
      if (used[key] === undefined) {
        used[key] = 1;
      } else {
        const n = used[key];
        used[key] = n + 1;
        const dot = outName.lastIndexOf('.');
        const stem = dot > 0 ? outName.slice(0, dot) : outName;
        const ext = dot > 0 ? outName.slice(dot) : '';
        let candidate = `${stem}_${String(n).padStart(2, '0')}${ext}`;
        let guard = n;
        while (used[`${folder}/${candidate}`.toLowerCase()] !== undefined && guard < 9999) {
          guard += 1;
          candidate = `${stem}_${String(guard).padStart(2, '0')}${ext}`;
        }
        used[`${folder}/${candidate}`.toLowerCase()] = 1;
        outName = candidate;
        renamed.push({ id: clip.id, from: name, to: candidate });
      }
      result[clip.id] = { fileName: outName, relPath: `${folder}/${outName}` };
    }

    return { byId: result, renamed };
  }

  /** Human readable summary lines for the export panel. */
  function buildSummary(clips, validation) {
    const scenes = new Set();
    let extras = 0;
    let processed = 0;
    let warnings = validation ? validation.warningCount : 0;
    let unnamed = 0;
    let duration = 0;

    for (const clip of clips || []) {
      if (clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== '') scenes.add(Number(clip.scene));
      if (clip.extra) extras += 1;
      if (clip.status === STATUS.APPLIED || clip.status === STATUS.EXPORTED) processed += 1;
      if (!clip.sceneOn && !clip.shotOn && !clip.takeOn && !(clip.customOn && String(clip.custom || '').trim())) unnamed += 1;
      duration += Number(clip.meta && clip.meta.duration) || 0;
    }

    return {
      total: (clips || []).length,
      processed,
      scenes: scenes.size,
      extras,
      unnamed,
      warnings,
      errors: validation ? validation.errorCount : 0,
      duration,
      durationText: formatDuration(duration),
    };
  }

  /** Short label for the clip row: "S-1 · SH-5 · T-15 · EXTRA". */
  function badgeLabel(clip) {
    const bits = [];
    if (clip.sceneOn) bits.push(`S-${clip.scene}`);
    if (clip.shotOn) bits.push(`SH-${clip.shot}`);
    if (clip.takeOn) bits.push(`T-${clip.take}`);
    if (clip.extra) bits.push('EXTRA');
    if (clip.customOn && String(clip.custom || '').trim()) bits.push('CUSTOM');
    return bits.join('  ');
  }


  return {
  LEVEL,
  validateClip,
  validateProject,
  resolveOutputNames,
  buildSummary,
  badgeLabel,
  buildBaseName,
};
});
