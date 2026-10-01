'use strict';
/**
 * FUSION FLIX — export engine.
 *
 * Safety model (this is the important part):
 *   • source footage is READ ONLY — files are copied / hard-linked, never moved
 *   • existing files are never overwritten silently (settings.duplicateNaming)
 *   • every destination path is validated to stay inside the chosen root
 *   • export never blocks the UI: work happens in the main process, progress is
 *     streamed to the renderer for every file (and every copied chunk), and it
 *     can be cancelled at any time
 *
 * What an export IS: a plain file copy. Every clip is copied into the chosen
 * destination folder and the copy gets the new name. Nothing else — no
 * re-encoding, no hard links, no extra report files. If you only want the
 * files renamed in place, use the rename engine (lib/renamer.js) instead: it
 * moves nothing and copies nothing, so it is instant even on terabytes.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createReadStream, createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');

const { validateProject, resolveOutputNames } = require('./validate');
const { finalFileName, finalRelativePath, sceneFolderName, UNASSIGNED_FOLDER, STATUS, isSupportedVideo, extOf } = require('./filenames');
const { validatePath, isInside, safeJoin, freeSpaceAt, formatBytes, uniquePath } = require('./paths');

const COPY_CHUNK = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Planning (pre-flight checks shown in the export panel)
// ---------------------------------------------------------------------------
/**
 * Builds an export plan without writing anything.
 *
 * @param {object[]} clips
 * @param {object} options {
 *   destination:string,
 *   duplicateNaming:'suffix'|'skip',
 *   layout:'flat'|'scenes'   flat = everything straight into the destination
 *                            folder (the default), scenes = Scene_01/… folders
 * }
 * @returns {Promise<object>} plan
 */
async function planExport(clips, options = {}) {
  const list = Array.isArray(clips) ? clips : [];
  // Export copies. (ZIP export was removed in 1.2.0 — if you want no copying at
  // all, use Rename instead.)
  const mode = 'folder';
  const layout = options.layout === 'scenes' ? 'scenes' : 'flat';
  const destination = options.destination || '';
  const duplicateNaming = options.duplicateNaming === 'skip' ? 'skip' : 'suffix';

  const validation = validateProject(list);
  const naming = resolveOutputNames(list);
  const entries = [];
  const problems = [];
  let totalBytes = 0;
  let usable = 0;
  let extrasCount = 0;
  const scenes = new Set();

  for (const clip of list) {
    const named = naming.byId[clip.id] || { fileName: finalFileName(clip), relPath: finalRelativePath(clip) };
    // flat  -> the destination folder itself
    // scenes-> Scene_01 / Scene_02 / … (Unassigned when a clip has no Scene)
    const sceneFolder =
      layout === 'scenes'
        ? (clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== ''
            ? sceneFolderName(clip.scene)
            : UNASSIGNED_FOLDER)
        : '';
    const entry = {
      id: clip.id,
      sourcePath: clip.sourcePath,
      fileName: named.fileName,
      relPath: sceneFolder ? `${sceneFolder}/${named.fileName}` : named.fileName,
      folder: sceneFolder,
      bytes: Number(clip.size) || 0,
      scene: clip.sceneOn && clip.scene !== null && clip.scene !== undefined && clip.scene !== '' ? Number(clip.scene) : null,
      extra: Boolean(clip.extra),
      renamed: naming.renamed.some((r) => r.id === clip.id),
      status: 'ready',
      problem: '',
    };

    // -- source checks ------------------------------------------------------
    if (!entry.sourcePath) {
      entry.status = 'blocked';
      entry.problem = 'This clip has no source file attached.';
    } else if (!validatePath(entry.sourcePath).ok) {
      entry.status = 'blocked';
      entry.problem = 'The source file path is not valid.';
    } else {
      let st = null;
      try {
        st = await fsp.stat(entry.sourcePath);
      } catch (_) {
        st = null;
      }
      if (!st || !st.isFile()) {
        entry.status = 'blocked';
        entry.problem = 'The source file is missing or unreadable. Relink it or delete the clip from the project.';
      } else {
        entry.bytes = st.size;
        if (!isSupportedVideo(entry.fileName)) {
          entry.problem = `".${extOf(entry.fileName)}" is not a video format — it will be copied unchanged.`;
        }
      }
    }

    // -- metadata checks ----------------------------------------------------
    const clipIssues = (validation.byClip[clip.id] || []).filter((i) => i.level === 'error');
    if (clipIssues.length && entry.status === 'ready') {
      // Metadata problems do not block a copy, but they do raise warnings.
      entry.problem = entry.problem || clipIssues[0].message;
    }

    if (entry.status === 'blocked') problems.push({ id: clip.id, message: entry.problem, level: 'error' });
    else {
      usable += 1;
      totalBytes += entry.bytes;
      if (entry.extra) extrasCount += 1;
      if (entry.scene !== null) scenes.add(entry.scene);
      if (entry.problem) problems.push({ id: clip.id, message: entry.problem, level: 'warning' });
    }

    entries.push(entry);
  }

  // -- destination checks --------------------------------------------------
  const destinationChecks = { ok: true, messages: [], freeBytes: undefined, neededBytes: totalBytes };
  if (!destination) {
    destinationChecks.ok = false;
    destinationChecks.messages.push({ level: 'error', message: 'Choose an export destination first.' });
  } else {
    const dv = validatePath(destination);
    if (!dv.ok) {
      destinationChecks.ok = false;
      destinationChecks.messages.push({ level: 'error', message: `The destination is not valid: ${dv.reason}` });
    } else {
      let problem = '';
      try {
        const st = await fsp.stat(dv.path);
        if (!st.isDirectory()) problem = 'The destination is not a folder.';
      } catch (_) {
        try {
          await fsp.mkdir(dv.path, { recursive: true });
        } catch (err) {
          problem = 'The destination folder could not be created or accessed.';
        }
      }
      if (problem) {
        destinationChecks.ok = false;
        destinationChecks.messages.push({ level: 'error', message: problem });
      } else {
        const free = await freeSpaceAt(dv.path);
        destinationChecks.freeBytes = free;
        if (typeof free === 'number' && free > 0 && free < totalBytes + 32 * 1024 * 1024) {
          destinationChecks.ok = false;
          destinationChecks.messages.push({
            level: 'error',
            message: `Not enough free space at the destination: ${formatBytes(free)} available, about ${formatBytes(totalBytes)} needed.`,
          });
        }
      }
    }
  }

  // Duplicate names that were auto-resolved.
  if (naming.renamed.length) {
    destinationChecks.messages.push({
      level: 'info',
      message: `${naming.renamed.length} duplicate output name${naming.renamed.length === 1 ? '' : 's'} will be saved with a _01, _02 … suffix.`,
    });
  }
  if (layout === 'scenes' && list.some((c) => !c.sceneOn || c.scene === null)) {
    destinationChecks.messages.push({
      level: 'info',
      message: `Clips without a Scene go to a "${UNASSIGNED_FOLDER}" folder.`,
    });
  }
  if (layout === 'flat') {
    destinationChecks.messages.push({
      level: 'info',
      message: 'Every clip is copied straight into the destination folder with its new name.',
    });
  }
  if (duplicateNaming === 'skip') {
    destinationChecks.messages.push({
      level: 'info',
      message: 'Duplicate handling is set to "Skip" — clips whose destination file already exists will be skipped.',
    });
  }

  const summary = {
    total: list.length,
    ready: usable,
    blocked: list.length - usable,
    scenes: scenes.size,
    extras: extrasCount,
    warnings: validation.warningCount + problems.filter((p) => p.level === 'warning').length,
    errors: validation.errorCount + problems.filter((p) => p.level === 'error').length,
    totalBytes,
    totalBytesText: formatBytes(totalBytes),
    mode,
    layout,
    destination,
    renamed: naming.renamed.length,
  };

  // Folder preview: nothing to list in flat mode (everything lands in the
  // destination itself), the Scene folders otherwise.
  const folders =
    layout === 'scenes'
      ? Array.from(scenes)
          .sort((a, b) => a - b)
          .map((n) => sceneFolderName(n))
          .concat(list.some((c) => !c.sceneOn || c.scene === null || c.scene === '') ? [UNASSIGNED_FOLDER] : [])
      : [];

  return { entries, problems, summary, destinationChecks, folders, validation };
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------
async function copyWithProgress(src, dest, onBytes, token) {
  let copied = 0;
  const read = createReadStream(src, { highWaterMark: COPY_CHUNK });
  const write = createWriteStream(dest, { highWaterMark: COPY_CHUNK });
  read.on('data', (chunk) => {
    copied += chunk.length;
    if (onBytes) onBytes(chunk.length);
  });
  await pipeline(read, write, { signal: token && token.signal });
  return copied;
}

/**
 * Creates the output file: a plain, independent copy of the source.
 *
 * A hard link would be instant and free, but the "copy" would then share its
 * data with the original — editing or deleting one would affect the other.
 * Exported footage has to be a real duplicate, so this always streams a copy.
 */
async function materialise(src, dest, onBytes, token, onStage) {
  if (onStage) onStage('copying');
  const bytes = await copyWithProgress(src, dest, onBytes, token);
  return { method: 'copy', bytes };
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------
class ExportJob {
  /**
   * @param {object} plan     result of planExport()
   * @param {object} options  { mode, destination, duplicateNaming, keepGoing, resourcesDir }
   * @param {Function} emit   progress callback (throttled by the caller)
   */
  constructor(plan, options, emit) {
    this.plan = plan;
    this.options = options;
    this.emit = emit || (() => {});
    this.cancelled = false;
    this.abortController = new AbortController();
    this.results = [];
    this.startedAt = Date.now();
    this.bytesTotal = plan.summary.totalBytes || 0;
    this.bytesDone = 0;
    this.lastEmit = 0;
    this.destination = options.destination;
    this.mode = 'folder';
    this.layout = plan.summary.layout || 'flat';
    this.stage = 'starting';
  }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    this.emitProgress({ force: true });
  }

  get token() {
    return { get cancelled() { return false; }, signal: this.abortController.signal, _job: this };
  }

  _token() {
    const job = this;
    return {
      get cancelled() {
        return job.cancelled;
      },
      signal: this.abortController.signal,
    };
  }

  emitProgress(extra = {}) {
    const now = Date.now();
    if (!extra.force && now - this.lastEmit < 90) return;
    this.lastEmit = now;
    const done = this.results.length;
    const total = this.plan.entries.length;
    const elapsed = (now - this.startedAt) / 1000;
    const ratio = this.bytesTotal > 0 ? this.bytesDone / this.bytesTotal : done / Math.max(1, total);
    const eta = ratio > 0.02 && ratio < 1 ? Math.max(0, Math.round((elapsed / ratio) * (1 - ratio))) : null;
    const current = this.currentEntry || null;
    this.emit(
      Object.assign(
        {
          bytesDone: this.bytesDone,
          bytesTotal: this.bytesTotal,
          percent: Math.max(0, Math.min(100, Math.round(ratio * 1000) / 10)),
          completed: done,
          total,
          currentName: current ? current.fileName : '',
          currentSource: current ? path.basename(current.sourcePath || '') : '',
          currentScene:
        this.layout === 'scenes' && current
          ? current.scene === null
            ? UNASSIGNED_FOLDER
            : sceneFolderName(current.scene)
          : '',
          destination: this.destination,
          elapsedSeconds: Math.round(elapsed),
          etaSeconds: eta,
          stage: this.stage || 'copying',
        },
        extra
      )
    );
  }

  async run() {
    try {
      await fsp.mkdir(this.destination, { recursive: true });
    } catch (_) {
      throw new Error('The export destination could not be created. Check that the drive is connected and writable.');
    }
    // Paint the very first state immediately (name of the first clip, 0 %).
    this.currentEntry = this.plan.entries[0] || null;
    this.emitProgress({ force: true, stage: 'starting' });
    return this.runFolder();
  }

  async runFolder() {
    const skipExisting = this.options.duplicateNaming === 'skip';
    this.stage = 'copying';
    for (const entry of this.plan.entries) {
      if (this.cancelled) break;
      this.currentEntry = entry;

      if (entry.status === 'blocked') {
        this.results.push({ id: entry.id, status: 'failed', message: entry.problem, fileName: entry.fileName });
        this.emitProgress({ force: true });
        if (this.options.keepGoing === false) break;
        continue;
      }

      try {
        // flat exports (the default) land directly in the destination, Scene
        // exports get their Scene_xx sub-folder created on demand.
        const folder = entry.folder ? safeJoin(this.destination, entry.folder) : this.destination;
        if (entry.folder) await fsp.mkdir(folder, { recursive: true });

        let target = safeJoin(folder, entry.fileName);
        if (fs.existsSync(target)) {
          if (skipExisting) {
            this.bytesDone += entry.bytes;
            this.results.push({ id: entry.id, status: 'skipped', message: 'A file with this name already exists.', fileName: entry.fileName, path: target });
            this.emitProgress();
            continue;
          }
          target = uniquePath(target); // never overwrite: _01, _02 …
        }

        const res = await materialise(entry.sourcePath, target, (n) => {
          this.bytesDone += n;
          this.emitProgress();
        }, this._token());

        this.results.push({ id: entry.id, status: 'exported', fileName: path.basename(target), path: target, method: res.method, bytes: res.bytes });
      } catch (err) {
        if (this.cancelled) break;
        this.results.push({
          id: entry.id,
          status: 'failed',
          message: friendlyError(err, entry),
          fileName: entry.fileName,
        });
        if (this.options.keepGoing === false) break;
      }
      this.emitProgress({ force: true });
    }

    const exported = this.results.filter((r) => r.status === 'exported').length;
    const skipped = this.results.filter((r) => r.status === 'skipped').length;
    const failed = this.results.filter((r) => r.status === 'failed').length;

    return {
      ok: !this.cancelled,
      cancelled: this.cancelled,
      mode: 'folder',
      layout: this.layout,
      destination: this.destination,
      exported,
      skipped,
      failed,
      results: this.results,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

/** Turns low-level errors into something a filmmaker can act on. */
function friendlyError(err, entry) {
  const code = err && err.code;
  const name = entry && entry.fileName ? entry.fileName : 'this clip';
  if (code === 'ENOENT') return `Unable to export ${name}. The source file may be missing or inaccessible.`;
  if (code === 'EACCES' || code === 'EPERM') return `Unable to export ${name}. The file is in use or access was denied.`;
  if (code === 'ENOSPC') return 'Not enough space left on the destination drive.';
  if (code === 'ABORT_ERR') return 'Export cancelled.';
  const msg = err && err.message ? err.message : 'Unknown error.';
  if (/outside the target folder/i.test(msg)) return 'Refused to write outside the destination folder.';
  return `Unable to export ${name}. ${msg}`;
}

module.exports = { planExport, ExportJob, friendlyError, materialise, copyWithProgress, COPY_CHUNK };
