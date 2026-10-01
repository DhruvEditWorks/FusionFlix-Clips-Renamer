'use strict';
/**
 * FUSION FLIX — rename engine (rename, do not copy).
 *
 * Export copies footage into a destination folder, which is slow for large rushes.
 * This engine does what most editors actually want: it renames the files
 * **in place**, in the folder they already live in.
 *
 * Safety model — renaming is the one operation that touches the user's own
 * files, so it is deliberately conservative:
 *   • it only ever runs after an explicit opt-in (the panel's confirmation box)
 *   • a file is never overwritten: a clashing target becomes name_01, _02 …
 *   • nothing is renamed until the whole plan is verified
 *   • the plan records every from → to pair, so UNDO RENAME can always put the
 *     originals back (the log is stored in the project file too)
 *   • case-only renames (clip.MP4 → CLIP.MP4) go through a temporary name,
 *     because Windows cannot tell the two apart
 *   • a file that is open/locked is reported and skipped, never forced
 *   • progress is streamed for every single file, so the bar moves with reality
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { validateProject, resolveOutputNames } = require('./validate');
const { finalFileName, isSupportedVideo, extOf } = require('./filenames');
const { safeJoin, uniquePath, formatBytes } = require('./paths');

/** Windows refuses paths longer than this (unless long paths are enabled). */
const MAX_WINDOWS_PATH = 255;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------
/**
 * Builds a rename plan without touching the disk.
 *
 * @param {object[]} clips
 * @param {object} options { renameMode:'in-place'|'into-folder', targetFolder:string, duplicateNaming:'suffix'|'skip' }
 */
async function planRename(clips, options = {}) {
  const list = Array.isArray(clips) ? clips : [];
  const intoFolder = options.renameMode === 'into-folder' ? String(options.targetFolder || '') : '';
  const duplicateNaming = options.duplicateNaming === 'skip' ? 'skip' : 'suffix';

  const validation = validateProject(list);
  const naming = resolveOutputNames(list);
  const problems = [];
  const entries = [];

  let totalBytes = 0;
  let ready = 0;
  let unchanged = 0;
  let blocked = 0;

  // Targets already claimed by this plan (case-insensitive, like Windows).
  const claimed = new Map();

  for (const clip of list) {
    const named = naming.byId[clip.id] || { fileName: finalFileName(clip), relPath: finalFileName(clip) };
    const sourcePath = String(clip.sourcePath || '');
    const sourceDir = sourcePath ? path.dirname(sourcePath) : '';
    const desiredDir = intoFolder || sourceDir;
    const entry = {
      id: clip.id,
      sourcePath,
      originalName: path.basename(sourcePath),
      fileName: named.fileName,
      folder: desiredDir,
      targetPath: '',
      bytes: Number(clip.size) || 0,
      scene: clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== '' ? Number(clip.scene) : null,
      custom: Boolean(clip.customOn && String(clip.custom || '').trim()),
      status: 'ready', // ready | unchanged | blocked | skipped
      problem: '',
    };

    // ---- individual checks -------------------------------------------------
    const issues = (validation.byClip && validation.byClip[clip.id]) || [];
    const hardError = issues.find((i) => i.level === 'error');
    if (hardError) {
      entry.status = 'blocked';
      entry.problem = hardError.message;
    }
    if (entry.status === 'ready' && !sourcePath) {
      entry.status = 'blocked';
      entry.problem = 'The clip has no source file recorded.';
    }
    if (entry.status === 'ready' && !fs.existsSync(sourcePath)) {
      entry.status = 'blocked';
      entry.problem = 'The source file is missing from disk. Use Relink Clip first.';
    }
    if (entry.status === 'ready' && !isSupportedVideo(sourcePath)) {
      entry.status = 'blocked';
      entry.problem = `Unsupported file type (${extOf(sourcePath) || 'no extension'}).`;
    }
    if (entry.status === 'ready' && !named.fileName) {
      entry.status = 'blocked';
      entry.problem = 'The output filename is empty.';
    }
    if (entry.status === 'ready' && /[\\/:*?"<>|]/.test(named.fileName)) {
      entry.status = 'blocked';
      entry.problem = 'The filename contains characters Windows does not allow.';
    }
    if (entry.status === 'ready' && /[. ]$/.test(named.fileName.replace(/\.[^.]+$/, ''))) {
      entry.status = 'blocked';
      entry.problem = 'Windows does not allow filenames ending in a dot or a space.';
    }
    if (entry.status === 'ready' && !desiredDir) {
      entry.status = 'blocked';
      entry.problem = 'No destination folder could be worked out for this clip.';
    }

    // ---- target path -------------------------------------------------------
    if (entry.status === 'ready') {
      let target = safeJoin(desiredDir, desiredFileName(named.fileName, path.extname(sourcePath)));
      if (process.platform === 'win32' && target.length > MAX_WINDOWS_PATH) {
        entry.status = 'blocked';
        entry.problem = 'The path would be too long for Windows. Shorten the custom name.';
      } else {
        const key = process.platform === 'win32' ? target.toLowerCase() : target;
        const claim = claimed.get(key);
        if (claim) {
          // Two clips resolve to the same name — never let one eat the other.
          if (duplicateNaming === 'skip') {
            entry.status = 'skipped';
            entry.problem = `Another clip in this batch already uses "${path.basename(target)}".`;
          } else {
            target = uniqueTarget(target, claimed);
            entry.problem = `Duplicate name — renamed to "${path.basename(target)}".`;
          }
        } else if (fs.existsSync(target) && !sameFile(target, sourcePath)) {
          if (duplicateNaming === 'skip') {
            entry.status = 'skipped';
            entry.problem = `"${path.basename(target)}" already exists in the folder.`;
          } else {
            target = uniqueTarget(target, claimed);
            entry.problem = `A file with that name already existed — renamed to "${path.basename(target)}".`;
          }
        }
        claimed.set(process.platform === 'win32' ? target.toLowerCase() : target, entry.id);
        entry.targetPath = target;
        if (sameFile(target, sourcePath)) {
          entry.status = 'unchanged';
          entry.problem = 'Already has the correct name.';
        }
      }
    }

    if (entry.status === 'ready') {
      ready += 1;
      totalBytes += entry.bytes;
    } else if (entry.status === 'unchanged') {
      unchanged += 1;
    } else {
      blocked += 1;
    }
    if (entry.problem && entry.status === 'ready') {
      problems.push({ id: clip.id, level: 'info', message: `${entry.originalName}: ${entry.problem}` });
    } else if (entry.problem) {
      problems.push({ id: clip.id, level: 'error', message: `${entry.originalName}: ${entry.problem}` });
    }
    entries.push(entry);
  }

  const summary = {
    total: list.length,
    ready,
    unchanged,
    blocked,
    folder: entries.find((e) => e.status === 'ready') ? entries.find((e) => e.status === 'ready').folder : intoFolder || '',
    totalBytes,
    totalBytesText: formatBytes(totalBytes),
    mode: intoFolder ? 'into-folder' : 'in-place',
    renamed: naming.renamed.length,
    warnings: validation.warningCount,
    errors: validation.errorCount,
  };

  return { entries, problems, summary, validation };
}

/** Keeps the source extension, but honours a custom name that already has one. */
function desiredFileName(fileName, sourceExtension) {
  const wanted = String(fileName || '').trim();
  if (!wanted) return wanted;
  const wantedExt = path.extname(wanted);
  if (wantedExt) return wanted;
  return `${wanted}${sourceExtension || ''}`;
}

/** true when two paths point at the same file (case-insensitive on Windows). */
function sameFile(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Finds a free target name: name_01.mp4, name_02.mp4 … skipping claimed ones. */
function uniqueTarget(target, claimed) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 9999; i += 1) {
    const candidate = path.join(dir, `${base}_${String(i).padStart(2, '0')}${ext}`);
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (!fs.existsSync(candidate) && !claimed.has(key)) {
      claimed.set(key, true);
      return candidate;
    }
  }
  return uniquePath(target);
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------
class RenameJob {
  /**
   * @param {object} plan     result of planRename()
   * @param {object} options  { duplicateNaming, keepGoing }
   * @param {Function} emit   progress callback
   */
  constructor(plan, options, emit) {
    this.plan = plan;
    this.options = options || {};
    this.emit = emit || (() => {});
    this.cancelled = false;
    this.results = [];
    this.changes = []; // { id, from, to } — the undo log
    this.startedAt = Date.now();
    this.lastEmit = 0;
    this.todos = plan.entries.filter((e) => e.status === 'ready');
    this.total = this.todos.length;
    this.currentEntry = null;
  }

  cancel() {
    this.cancelled = true;
    this.emitProgress({ force: true });
  }

  emitProgress(extra = {}) {
    const now = Date.now();
    if (!extra.force && now - this.lastEmit < 60) return;
    this.lastEmit = now;
    const done = this.results.filter((r) => r.status === 'renamed').length;
    const handled = this.results.length;
    const elapsed = (now - this.startedAt) / 1000;
    const ratio = this.total > 0 ? handled / this.total : 1;
    const eta = ratio > 0.05 && ratio < 1 ? Math.max(0, Math.round((elapsed / ratio) * (1 - ratio))) : null;
    const current = this.currentEntry;
    this.emit(
      Object.assign(
        {
          stage: 'renaming',
          percent: Math.max(0, Math.min(100, Math.round(ratio * 1000) / 10)),
          completed: handled,
          renamed: done,
          total: this.total,
          currentName: current ? current.originalName : '',
          currentTarget: current ? path.basename(current.targetPath) : '',
          folder: current ? current.folder : this.plan.summary.folder,
          elapsedSeconds: Math.round(elapsed),
          etaSeconds: eta,
        },
        extra
      )
    );
  }

  /** Renames one file, handling Windows' case-only and locked-file quirks. */
  async renameOne(entry) {
    const from = entry.sourcePath;
    const to = entry.targetPath;
    if (sameFile(from, to)) return { changed: false };

    const caseOnly = process.platform === 'win32' && from.toLowerCase() === to.toLowerCase() && from !== to;
    if (caseOnly) {
      // Windows cannot rename a file to a different case directly.
      const temp = path.join(path.dirname(to), `.ffx-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await fsp.rename(from, temp);
      try {
        await fsp.rename(temp, to);
      } catch (err) {
        await fsp.rename(temp, from).catch(() => {});
        throw err;
      }
      return { changed: true, temp: true };
    }

    await fsp.rename(from, to);
    return { changed: true };
  }

  async run() {
    this.emitProgress({ force: true });
    for (const entry of this.todos) {
      if (this.cancelled) break;
      this.currentEntry = entry;
      // Give the renderer a chance to paint before a very fast batch blurs past.
      await new Promise((resolve) => setImmediate(resolve));
      try {
        const res = await this.renameOne(entry);
        if (res.changed) this.changes.push({ id: entry.id, from: entry.sourcePath, to: entry.targetPath });
        this.results.push({
          id: entry.id,
          status: 'renamed',
          from: entry.sourcePath,
          to: entry.targetPath,
          fileName: path.basename(entry.targetPath),
          bytes: entry.bytes,
          note: entry.problem || '',
          changed: Boolean(res.changed),
        });
      } catch (err) {
        this.results.push({
          id: entry.id,
          status: 'failed',
          from: entry.sourcePath,
          fileName: entry.originalName,
          message: friendlyRenameError(err, entry),
        });
        if (this.options.keepGoing === false) break;
      }
      this.emitProgress({ force: true });
    }

    const failed = this.results.filter((r) => r.status === 'failed');
    const renamed = this.results.filter((r) => r.status === 'renamed' && r.changed).length;
    const untouched = this.results.length - renamed;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    this.emitProgress({ stage: 'done', percent: 100, completed: this.results.length, force: true });

    return {
      ok: failed.length === 0,
      cancelled: this.cancelled,
      folder: this.plan.summary.folder,
      renamed,
      untouched, // already correct or skipped by the user
      skipped: this.plan.entries.filter((e) => e.status === 'unchanged' || e.status === 'skipped').length,
      blocked: this.plan.entries.filter((e) => e.status === 'blocked').length,
      failed: failed.map((f) => ({ id: f.id, fileName: f.fileName, message: f.message })),
      changes: this.changes,
      elapsedSeconds: Math.round(elapsed),
      total: this.plan.entries.length,
    };
  }
}

function friendlyRenameError(err, entry) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return `Windows would not let the file be renamed. Close any app using "${entry.originalName}" (or the Explorer preview pane) and try again.`;
  }
  if (code === 'EBUSY') return `"${entry.originalName}" is in use by another program.`;
  if (code === 'ENOENT') return `"${entry.originalName}" disappeared before it could be renamed.`;
  if (code === 'EEXIST') return `"${path.basename(entry.targetPath)}" already exists.`;
  if (code === 'ENAMETOOLONG') return 'The new name is too long for this drive.';
  return `Could not rename "${entry.originalName}"${err && err.code ? ` (${err.code})` : ''}.`;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
/**
 * Renames the files back. Missing/renamed-again files are reported, never
 * guessed at.
 *
 * @param {Array<{from:string,to:string}>} changes
 */
async function undoRename(changes, options = {}) {
  const list = Array.isArray(changes) ? changes.slice().reverse() : [];
  const emit = options.emit || (() => {});
  const results = [];
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false;
  for (let i = 0; i < list.length; i += 1) {
    if (shouldCancel()) break;
    const change = list[i];
    try {
      if (!fs.existsSync(change.to)) {
        results.push({ ...change, status: 'failed', message: 'The renamed file is no longer there.' });
      } else if (fs.existsSync(change.from)) {
        results.push({ ...change, status: 'failed', message: 'A file with the original name exists again — nothing was overwritten.' });
      } else {
        await fsp.rename(change.to, change.from);
        results.push({ ...change, status: 'restored' });
      }
    } catch (err) {
      results.push({ ...change, status: 'failed', message: friendlyRenameError(err, { originalName: path.basename(change.to), targetPath: change.from }) });
    }
    emit({ percent: Math.round(((i + 1) / Math.max(1, list.length)) * 1000) / 10, completed: i + 1, total: list.length });
  }
  const restored = results.filter((r) => r.status === 'restored').length;
  return { ok: restored === list.length, restored, results };
}

module.exports = { planRename, RenameJob, undoRename, MAX_WINDOWS_PATH, sameFile, desiredFileName };
