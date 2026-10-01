'use strict';
/**
 * Fusion Flix — path safety, export engine and project-file tests.
 * These touch the real filesystem inside a temporary folder.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const P = require('../lib/paths');
const { planExport, ExportJob } = require('../lib/exporter');
const project = require('../lib/project');
const F = require('../lib/filenames');

let tmpRoot;

function makeTemp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'fusion-flix-test-'));
}

async function writeFakeClip(dir, name, bytes = 2048) {
  const p = path.join(dir, name);
  await fsp.writeFile(p, Buffer.alloc(bytes, 7));
  return p;
}

function clipFor(sourcePath, over) {
  const st = fs.statSync(sourcePath);
  return Object.assign(
    {
      id: path.basename(sourcePath),
      order: 0,
      sourcePath,
      fileName: path.basename(sourcePath),
      size: st.size,
      sceneOn: true,
      scene: 1,
      shotOn: true,
      shot: 1,
      takeOn: true,
      take: 1,
      extra: false,
      customOn: false,
      custom: '',
      timeText: '00-00-01',
      status: 'applied',
      meta: { duration: 5 },
    },
    over || {}
  );
}

test.before(async () => {
  tmpRoot = await makeTemp();
});

test.after(async () => {
  try {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  } catch (_) {}
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
test('only absolute paths are accepted from the renderer', () => {
  assert.strictEqual(P.validatePath('relative/clip.mp4').ok, false);
  assert.strictEqual(P.validatePath('').ok, false);
  assert.strictEqual(P.validatePath('C:\\footage\\clip.mp4').ok, true);
  assert.strictEqual(P.validatePath('\\\\NAS\\share\\clip.mp4').ok, true);
  assert.strictEqual(P.validatePath('/home/user/clip.mp4').ok, true);
  assert.strictEqual(P.validatePath('C:\\bad\u0000name.mp4').ok, false);
});

test('safeJoin refuses to escape the destination', () => {
  const base = path.join(tmpRoot, 'dest');
  assert.ok(P.safeJoin(base, 'Scene_01', 'a.mp4').startsWith(base));
  assert.throws(() => P.safeJoin(base, '..', '..', 'evil.mp4'));
});

test('windows-style containment checks work on any platform', () => {
  assert.strictEqual(P.isInside('C:\\Exports', 'C:\\Exports\\Scene_01\\a.mp4'), true);
  assert.strictEqual(P.isInside('C:\\Exports', 'C:\\Exports2\\a.mp4'), false);
  assert.strictEqual(P.isInside('C:\\Exports', 'D:\\Other\\a.mp4'), false);
  assert.strictEqual(P.pathKey('C:\\Exports\\Clip.MP4'), 'c:\\exports\\clip.mp4');
});

test('uniquePath never collides with an existing file', () => {
  const exists = new Set(['/x/a.mp4', '/x/a_01.mp4']);
  const result = P.uniquePath('/x/a.mp4', (p) => exists.has(p));
  assert.strictEqual(result, '/x/a_02.mp4');
});

test('formatBytes is human readable', () => {
  assert.strictEqual(P.formatBytes(512), '512 B');
  assert.strictEqual(P.formatBytes(2048), '2.0 KB');
  assert.match(P.formatBytes(5 * 1024 * 1024 * 1024), /GB/);
});

// ---------------------------------------------------------------------------
// Export planning
// ---------------------------------------------------------------------------
test('planExport groups by Scene only when the Scene layout is asked for', async () => {
  const dir = path.join(tmpRoot, 'footage');
  await fsp.mkdir(dir, { recursive: true });
  const a = await writeFakeClip(dir, 'a.mp4');
  const b = await writeFakeClip(dir, 'b.mp4');
  const c = await writeFakeClip(dir, 'c.mp4');

  const clips = [
    clipFor(a, { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 }),
    clipFor(b, { sceneOn: true, scene: 1, shotOn: true, shot: 2, takeOn: true, take: 1, extra: true }),
    clipFor(c, { sceneOn: true, scene: 2, shotOn: true, shot: 5, takeOn: true, take: 15 }),
  ];

  const plan = await planExport(clips, { mode: 'folder', layout: 'scenes', destination: path.join(tmpRoot, 'out1') });
  assert.strictEqual(plan.summary.layout, 'scenes');
  assert.strictEqual(plan.summary.total, 3);
  assert.strictEqual(plan.summary.scenes, 2);
  assert.strictEqual(plan.summary.extras, 1);
  assert.strictEqual(plan.summary.ready, 3);
  assert.deepStrictEqual(
    plan.entries.map((e) => e.relPath).sort(),
    ['Scene_01/S-1_SH-1_T-1_(1-1-1).mp4', 'Scene_01/S-1_SH-2_T-1_EXTRA_(1-2-1).mp4', 'Scene_02/S-2_SH-5_T-15_(2-5-15).mp4'].sort()
  );
  // Only scene folders — never Shot or Take folders.
  assert.ok(!plan.entries.some((e) => /Shot_|Take_/.test(e.relPath)));
});

test('the default export layout is flat: renamed files straight into the destination', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'out-flat');
  const clips = [
    clipFor(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 }),
    clipFor(path.join(dir, 'b.mp4'), { sceneOn: true, scene: 2, shotOn: true, shot: 5, takeOn: true, take: 15 }),
  ];
  const plan = await planExport(clips, { destination: dest });

  assert.strictEqual(plan.summary.layout, 'flat', 'flat is the default');
  assert.deepStrictEqual(plan.folders, [], 'no folders are announced');
  assert.ok(!plan.entries.some((e) => e.folder), 'no clip carries a sub-folder');
  assert.deepStrictEqual(
    plan.entries.map((e) => e.relPath).sort(),
    ['S-1_SH-1_T-1_(1-1-1).mp4', 'S-2_SH-5_T-15_(2-5-15).mp4'].sort()
  );

  const job = new ExportJob(plan, { destination: dest, keepGoing: true }, () => {});
  const result = await job.run();
  assert.strictEqual(result.layout, 'flat');
  assert.strictEqual(result.exported, 2);
  assert.ok(fs.existsSync(path.join(dest, 'S-1_SH-1_T-1_(1-1-1).mp4')), 'file sits in the destination itself');
  assert.ok(!fs.existsSync(path.join(dest, 'Scene_01')), 'no Scene folder is created in flat mode');
});

test('an export always produces a real, independent copy (never a hard link)', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'out-copy');
  const src = path.join(dir, 'a.mp4');
  const clips = [clipFor(src, { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 })];
  const plan = await planExport(clips, { destination: dest });
  const job = new ExportJob(plan, { destination: dest, keepGoing: true }, () => {});
  const result = await job.run();

  const out = path.join(dest, 'S-1_SH-1_T-1_(1-1-1).mp4');
  assert.strictEqual(result.results[0].method, 'copy', 'the copy method is reported');
  assert.strictEqual(await fsp.readFile(out, 'utf8'), await fsp.readFile(src, 'utf8'), 'bytes match');
  // Different inode = different file: editing or deleting one cannot touch the other.
  assert.notStrictEqual(fs.statSync(out).ino, fs.statSync(src).ino, 'the export is not a hard link to the source');
  assert.strictEqual(fs.statSync(src).nlink, 1, 'the source gained no extra link');
});

test('an export writes nothing but the clips — no report or manifest files', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'out-clean');
  const clips = [clipFor(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 })];
  const plan = await planExport(clips, { destination: dest });
  await new ExportJob(plan, { destination: dest, keepGoing: true }, () => {}).run();

  const written = fs.readdirSync(dest);
  assert.deepStrictEqual(written, ['S-1_SH-1_T-1_(1-1-1).mp4'], `only footage, got ${written.join(', ')}`);
});

test('planExport flags missing source files instead of failing', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const ghost = path.join(dir, 'gone.mp4');
  const plan = await planExport([clipFor(path.join(dir, 'a.mp4')), Object.assign(clipFor(path.join(dir, 'a.mp4')), { id: 'ghost', sourcePath: ghost })], {
    mode: 'folder',
    destination: path.join(tmpRoot, 'out2'),
  });
  assert.strictEqual(plan.summary.ready, 1);
  assert.strictEqual(plan.summary.blocked, 1);
  const blocked = plan.entries.find((e) => e.status === 'blocked');
  assert.match(blocked.problem, /missing|unreadable/i);
});

test('planExport refuses an unusable destination', async () => {
  const plan = await planExport([], { mode: 'folder', destination: '' });
  assert.strictEqual(plan.destinationChecks.ok, false);
  assert.ok(plan.destinationChecks.messages.some((m) => m.level === 'error'));
});

// ---------------------------------------------------------------------------
// Folder export
// ---------------------------------------------------------------------------
test('folder export writes Scene folders with renamed copies and leaves sources untouched', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'export-folder');
  const clips = [
    clipFor(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 }),
    clipFor(path.join(dir, 'b.mp4'), { sceneOn: true, scene: 2, shotOn: true, shot: 5, takeOn: true, take: 15, timeText: '01-05-15' }),
  ];
  const plan = await planExport(clips, { mode: 'folder', layout: 'scenes', destination: dest });
  const job = new ExportJob(plan, { mode: 'folder', layout: 'scenes', destination: dest, keepGoing: true }, () => {});
  const result = await job.run();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.exported, 2);
  assert.ok(fs.existsSync(path.join(dest, 'Scene_01', 'S-1_SH-1_T-1_(1-1-1).mp4')));
  assert.ok(fs.existsSync(path.join(dest, 'Scene_02', 'S-2_SH-5_T-15_(2-5-15).mp4')));
  assert.ok(!fs.existsSync(path.join(dest, 'Scene_01', 'Shot_01')), 'no Shot folders are created');
  // Sources still exist with their original names.
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  assert.ok(fs.existsSync(path.join(dir, 'b.mp4')));
  // Nothing extra is written next to the footage.
  assert.ok(!fs.existsSync(path.join(dest, 'Fusion_Flix_export_report.json')), 'no export report file');
});

test('export never overwrites an existing destination file', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'export-existing');
  const target = path.join(dest, 'Scene_01', 'S-1_SH-1_T-1_(1-1-1).mp4');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, 'ORIGINAL CONTENT');

  const clips = [clipFor(path.join(dir, 'a.mp4'))];
  const plan = await planExport(clips, { mode: 'folder', layout: 'scenes', destination: dest, duplicateNaming: 'suffix' });
  const job = new ExportJob(plan, { mode: 'folder', layout: 'scenes', destination: dest, duplicateNaming: 'suffix' }, () => {});
  await job.run();

  assert.strictEqual(await fsp.readFile(target, 'utf8'), 'ORIGINAL CONTENT', 'existing file is untouched');
  assert.ok(fs.existsSync(path.join(dest, 'Scene_01', 'S-1_SH-1_T-1_(1-1-1)_01.mp4')), 'a suffixed copy is written instead');
});

test('duplicate naming "skip" leaves the clip out instead of writing a copy', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'export-skip');
  const target = path.join(dest, 'Scene_01', 'S-1_SH-1_T-1_(1-1-1).mp4');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, 'KEEP');

  const clips = [clipFor(path.join(dir, 'a.mp4'))];
  const plan = await planExport(clips, { mode: 'folder', layout: 'scenes', destination: dest, duplicateNaming: 'skip' });
  const job = new ExportJob(plan, { mode: 'folder', layout: 'scenes', destination: dest, duplicateNaming: 'skip' }, () => {});
  const result = await job.run();

  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.exported, 0);
  assert.strictEqual(await fsp.readFile(target, 'utf8'), 'KEEP');
});

test('blocked clips do not stop the rest of the export', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'export-partial');
  const clips = [
    clipFor(path.join(dir, 'a.mp4'), { id: 'ok' }),
    Object.assign(clipFor(path.join(dir, 'a.mp4')), { id: 'ghost', sourcePath: path.join(dir, 'nope.mp4') }),
  ];
  const plan = await planExport(clips, { mode: 'folder', destination: dest });
  const job = new ExportJob(plan, { mode: 'folder', destination: dest, keepGoing: true }, () => {});
  const result = await job.run();
  assert.strictEqual(result.exported, 1);
  assert.strictEqual(result.failed, 1);
  assert.match(result.results.find((r) => r.id === 'ghost').message, /missing|unreadable/i);
});

test('export progress is reported with clip, scene and percentage', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'export-progress');
  const clips = [
    clipFor(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 1 }),
    clipFor(path.join(dir, 'b.mp4'), { sceneOn: true, scene: 2 }),
  ];
  const plan = await planExport(clips, { mode: 'folder', layout: 'scenes', destination: dest });
  const seen = [];
  const job = new ExportJob(plan, { mode: 'folder', destination: dest, keepGoing: true }, (p) => seen.push(p));
  await job.run();
  assert.ok(seen.length >= 2);
  const last = seen[seen.length - 1];
  assert.strictEqual(last.completed, 2);
  assert.strictEqual(last.total, 2);
  assert.ok(last.percent >= 99);
  assert.ok(seen.some((p) => p.currentScene === 'Scene_01'));
});

// ---------------------------------------------------------------------------
// ZIP export was removed in 1.2.0
// ---------------------------------------------------------------------------
test('ZIP export is gone — planExport always plans a folder copy', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const dest = path.join(tmpRoot, 'export-nozip');
  const clips = [clipFor(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 })];
  const plan = await planExport(clips, { mode: 'zip', layout: 'scenes', destination: dest });
  assert.strictEqual(plan.summary.mode, 'folder', 'asking for a zip still produces a folder plan');
  assert.strictEqual(plan.summary.layout, 'scenes', 'layout survives an unknown mode value');
  assert.strictEqual(plan.summary.zipPath, undefined, 'no zip path anywhere in the plan');

  const job = new ExportJob(plan, { mode: 'zip', destination: dest, keepGoing: true }, () => {});
  const result = await job.run();
  assert.strictEqual(result.mode, 'folder');
  assert.strictEqual(result.zipPath, undefined);
  assert.ok(!fs.readdirSync(dest).some((f) => /\.zip$/i.test(f)), 'nothing zip-shaped is written');
});

// ---------------------------------------------------------------------------
// Real-time progress
// ---------------------------------------------------------------------------
test('export reports progress in real time (first paint, per-file, and 100 %)', async () => {
  const dir = path.join(tmpRoot, 'progress-footage');
  const dest = path.join(tmpRoot, 'export-progress');
  await fsp.mkdir(dir, { recursive: true });
  const sources = [];
  for (const n of [1, 2, 3]) sources.push(await writeFakeClip(dir, `${n}.mp4`, 3 * 1024 * 1024));
  const clips = sources.map((src, i) =>
    clipFor(src, { sceneOn: true, scene: 1, shotOn: true, shot: i + 1, takeOn: true, take: 1 })
  );
  const plan = await planExport(clips, { destination: dest });
  const seen = [];
  const job = new ExportJob(plan, { destination: dest, keepGoing: true }, (p) => seen.push(p));
  const result = await job.run();

  assert.strictEqual(result.exported, 3);
  assert.ok(seen.length >= 4, `expected several progress events, got ${seen.length}`);
  assert.strictEqual(seen[0].percent, 0, 'the panel is painted with 0 % straight away');
  assert.ok(seen[0].currentName, 'and it already names the first clip');
  const percents = seen.map((p) => p.percent);
  assert.ok(Math.max(...percents) === 100, 'progress reaches 100 %');
  assert.ok(percents.some((p) => p > 0 && p < 100), `intermediate percentages exist: ${JSON.stringify(percents.slice(0, 8))}`);
  assert.ok(seen.every((p) => typeof p.bytesTotal === 'number'), 'byte totals travel with every event');
});

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------
test('project save/load round-trips metadata without duplicating footage', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const file = path.join(tmpRoot, 'project-test.ffclip');
  const proj = project.createEmptyProject('Test Project');
  proj.clips = [
    clipFor(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 4, shotOn: true, shot: 2, takeOn: true, take: 9, extra: true, customOn: true, custom: 'Nice Shot' }),
  ];
  const saved = await project.save(proj, file);
  assert.strictEqual(saved.clipCount, 1);

  const sizeOnDisk = fs.statSync(file).size;
  assert.ok(sizeOnDisk < 50 * 1024, 'the project file stores metadata only');

  const loaded = await project.load(file);
  assert.strictEqual(loaded.name, 'Test Project');
  assert.strictEqual(loaded.clips.length, 1);
  const clip = loaded.clips[0];
  assert.strictEqual(clip.scene, 4);
  assert.strictEqual(clip.shot, 2);
  assert.strictEqual(clip.take, 9);
  assert.strictEqual(clip.extra, true);
  assert.strictEqual(clip.custom, 'Nice Shot');
  assert.strictEqual(clip.sourcePath, path.join(dir, 'a.mp4'));
});

test('project files reject obviously foreign JSON', () => {
  assert.throws(() => project.deserialize({ hello: 'world' }));
  assert.throws(() => project.deserialize(null));
});

test('missing media detection reports clips that vanished', async () => {
  const dir = path.join(tmpRoot, 'footage');
  const proj = project.createEmptyProject('Missing');
  proj.clips = [
    clipFor(path.join(dir, 'a.mp4')),
    Object.assign(clipFor(path.join(dir, 'a.mp4')), { id: 'ghost', sourcePath: path.join(dir, 'ghost.mp4') }),
  ];
  const missing = await project.findMissingClips(proj);
  assert.deepStrictEqual(missing, ['ghost']);
});

test('autosave snapshots can be listed, read and discarded', async () => {
  const userData = await makeTemp();
  const proj = project.createEmptyProject('Autosave');
  proj.clips = [clipFor(path.join(tmpRoot, 'footage', 'a.mp4'))];

  await project.writeAutosave(userData, proj, '', { clean: false });
  const list = await project.listRecoverable(userData);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].clipCount, 1);

  const read = await project.readRecoverable(userData, list[0].key);
  assert.strictEqual(read.project.name, 'Autosave');

  await project.writeAutosave(userData, proj, '', { clean: true });
  const afterClean = await project.listRecoverable(userData);
  assert.strictEqual(afterClean.length, 0, 'a clean save is not offered for recovery');
  await fsp.rm(userData, { recursive: true, force: true });
});
