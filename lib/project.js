'use strict';
/**
 * FUSION FLIX — project files (.ffclip)
 *
 * A project file stores *metadata only*: source paths, order, Scene/Shot/Take,
 * Extra flag, custom name, generated filename, project + export settings.
 * Source footage is never copied into a project file and never modified.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { DEFAULT_PROJECT_SETTINGS, STATUS, computeTimeText } = require('./filenames');

const PROJECT_EXT = '.ffclip';
const PROJECT_VERSION = 1;

/** Fields that must never be written to a project file (transient/runtime). */
const TRANSIENT_CLIP_FIELDS = ['thumb', 'thumbLoading', 'issues', 'element'];

function newId(prefix = 'c') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createEmptyProject(name = 'Untitled Project') {
  return {
    version: PROJECT_VERSION,
    app: 'Fusion Flix Clip Renamer & Sorter',
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: Object.assign({}, DEFAULT_PROJECT_SETTINGS),
    exportSettings: {
      mode: DEFAULT_PROJECT_SETTINGS.defaultExportMode,
      destination: '',
      includeUnassigned: true,
    },
    clips: [],
  };
}

/** Strips runtime-only fields and clamps unknown values before writing. */
function serialize(project) {
  const clips = (project.clips || []).map((clip, index) => {
    const out = {
      id: clip.id,
      order: Number.isFinite(clip.order) ? clip.order : index,
      sourcePath: clip.sourcePath || '',
      fileName: clip.fileName || '',
      relPath: clip.relPath || '',
      size: Number(clip.size) || 0,
      mtimeMs: Number(clip.mtimeMs) || 0,
      sceneOn: Boolean(clip.sceneOn),
      shotOn: Boolean(clip.shotOn),
      takeOn: Boolean(clip.takeOn),
      scene: clip.scene === undefined ? null : clip.scene,
      shot: clip.shot === undefined ? null : clip.shot,
      take: clip.take === undefined ? null : clip.take,
      extra: Boolean(clip.extra),
      customOn: Boolean(clip.customOn),
      custom: String(clip.custom || ''),
      timeText: clip.timeText || '00-00-00',
      status: clip.status || STATUS.NEW,
      note: String(clip.note || ''),
      meta: {
        duration: Number(clip.meta && clip.meta.duration) || 0,
        width: Number(clip.meta && clip.meta.width) || 0,
        height: Number(clip.meta && clip.meta.height) || 0,
        fps: Number(clip.meta && clip.meta.fps) || 0,
        videoCodec: (clip.meta && clip.meta.videoCodec) || '',
        audioCodec: (clip.meta && clip.meta.audioCodec) || '',
        hasAudio: Boolean(clip.meta && clip.meta.hasAudio),
        timecode: (clip.meta && clip.meta.timecode) || '',
        timecodeFromSource: Boolean(clip.meta && clip.meta.timecodeFromSource),
        probeError: (clip.meta && clip.meta.probeError) || '',
      },
    };
    for (const key of TRANSIENT_CLIP_FIELDS) delete out[key];
    return out;
  });

  return {
    version: PROJECT_VERSION,
    app: project.app || 'Fusion Flix Clip Renamer & Sorter',
    name: project.name || 'Untitled Project',
    createdAt: project.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: Object.assign({}, DEFAULT_PROJECT_SETTINGS, project.settings || {}),
    exportSettings: Object.assign({ mode: 'folder', destination: '', includeUnassigned: true }, project.exportSettings || {}),
    // Renames made by the app, oldest first — the log that UNDO RENAME uses.
    // Stored with the project so the originals can be put back even later.
    renameLog: (project.renameLog || []).slice(-500).map((c) => ({ id: c.id, from: c.from, to: c.to, at: c.at || '' })),
    clips,
  };
}

/** Rebuilds a runtime project from parsed JSON, tolerating older/odd files. */
function deserialize(json) {
  if (!json || typeof json !== 'object') throw new Error('This file is not a Fusion Flix project.');
  if (json.app && !/fusion flix/i.test(String(json.app))) throw new Error('This file is not a Fusion Flix project.');
  if (!Array.isArray(json.clips)) throw new Error('This project file has no clip list.');

  const project = createEmptyProject(json.name || 'Untitled Project');
  project.createdAt = json.createdAt || project.createdAt;
  project.settings = Object.assign({}, DEFAULT_PROJECT_SETTINGS, json.settings || {});
  project.exportSettings = Object.assign({ mode: 'folder', destination: '', includeUnassigned: true }, json.exportSettings || {});
  project.renameLog = Array.isArray(json.renameLog) ? json.renameLog.filter((c) => c && c.from && c.to) : [];

  project.clips = json.clips.map((raw, index) => {
    const sourcePath = String(raw.sourcePath || '');
    const fileName = raw.fileName || path.basename(sourcePath) || `clip_${index + 1}`;
    const meta = Object.assign(
      {
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
        videoCodec: '',
        audioCodec: '',
        hasAudio: false,
        timecode: '',
        timecodeFromSource: false,
        probeError: '',
      },
      raw.meta || {}
    );
    const clip = {
      id: raw.id || newId(),
      order: Number.isFinite(raw.order) ? raw.order : index,
      sourcePath,
      fileName,
      relPath: raw.relPath || '',
      size: Number(raw.size) || 0,
      mtimeMs: Number(raw.mtimeMs) || 0,
      sceneOn: Boolean(raw.sceneOn),
      shotOn: Boolean(raw.shotOn),
      takeOn: Boolean(raw.takeOn),
      scene: raw.scene === undefined ? null : raw.scene,
      shot: raw.shot === undefined ? null : raw.shot,
      take: raw.take === undefined ? null : raw.take,
      extra: Boolean(raw.extra),
      customOn: Boolean(raw.customOn),
      custom: String(raw.custom || ''),
      timeText: raw.timeText || computeTimeText(meta, { index, timecodeFallback: project.settings.timecodeFallback }),
      status: raw.status || STATUS.NEW,
      note: String(raw.note || ''),
      meta,
    };
    return clip;
  });

  return project;
}

/** Atomic save: write a temp file, then rename over the target. */
async function save(project, filePath) {
  const payload = serialize(project);
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
  return { filePath, clipCount: payload.clips.length, bytes: Buffer.byteLength(JSON.stringify(payload)) };
}

async function load(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error('This project file looks damaged and could not be read.');
  }
  return deserialize(json);
}

/** Ensures the project extension is present. */
function withProjectExt(filePath) {
  if (!filePath) return filePath;
  return filePath.toLowerCase().endsWith(PROJECT_EXT) ? filePath : `${filePath}${PROJECT_EXT}`;
}

// ---------------------------------------------------------------------------
// Autosave + crash recovery (metadata only — never touches source footage)
// ---------------------------------------------------------------------------
function autosaveDir(userDataDir) {
  return path.join(userDataDir, 'autosave');
}

function recoveryKey(projectPath) {
  const base = projectPath || 'unsaved-project';
  return crypto.createHash('sha1').update(path.normalize(base)).digest('hex').slice(0, 16);
}

/**
 * Writes the autosave snapshot for a project.
 * For never-saved projects the key is derived from the project id/name.
 */
async function writeAutosave(userDataDir, project, projectPath, { clean = false } = {}) {
  const dir = autosaveDir(userDataDir);
  await fsp.mkdir(dir, { recursive: true });
  const key = recoveryKey(projectPath || project.recoveryId || project.name);
  const payload = serialize(project);
  payload.savedPath = projectPath || '';
  payload.autosavedAt = new Date().toISOString();
  payload.clean = clean;

  const file = path.join(dir, `${key}.json`);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

/** Lists recoverable autosaves (skips snapshots that were saved cleanly). */
async function listRecoverable(userDataDir) {
  const dir = autosaveDir(userDataDir);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      const json = JSON.parse(await fsp.readFile(full, 'utf8'));
      if (json.clean) continue;
      const st = await fsp.stat(full);
      out.push({
        key: name.replace(/\.json$/, ''),
        file: full,
        path: json.savedPath || '',
        name: json.name || 'Untitled Project',
        clipCount: Array.isArray(json.clips) ? json.clips.length : 0,
        autosavedAt: json.autosavedAt || st.mtime.toISOString(),
      });
    } catch (_) {
      /* ignore damaged snapshot */
    }
  }
  out.sort((a, b) => String(b.autosavedAt).localeCompare(String(a.autosavedAt)));
  return out;
}

async function readRecoverable(userDataDir, key) {
  const full = path.join(autosaveDir(userDataDir), `${key}.json`);
  const json = JSON.parse(await fsp.readFile(full, 'utf8'));
  const project = deserialize(json);
  return { project, savedPath: json.savedPath || '', autosavedAt: json.autosavedAt || '' };
}

async function discardRecoverable(userDataDir, key) {
  try {
    await fsp.unlink(path.join(autosaveDir(userDataDir), `${key}.json`));
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Re-checks every clip against the disk. Returns the clip ids that are missing
 * so the renderer can offer Relink Clip.
 */
async function findMissingClips(project) {
  const missing = [];
  for (const clip of project.clips || []) {
    let ok = false;
    try {
      const st = await fsp.stat(clip.sourcePath);
      ok = st.isFile();
    } catch (_) {
      ok = false;
    }
    if (!ok) missing.push(clip.id);
  }
  return missing;
}

module.exports = {
  PROJECT_EXT,
  PROJECT_VERSION,
  newId,
  createEmptyProject,
  serialize,
  deserialize,
  save,
  load,
  withProjectExt,
  autosaveDir,
  writeAutosave,
  listRecoverable,
  readRecoverable,
  discardRecoverable,
  findMissingClips,
  recoveryKey,
};
