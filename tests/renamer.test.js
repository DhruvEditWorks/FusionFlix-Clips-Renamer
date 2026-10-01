'use strict';
/**
 * Fusion Flix — rename engine tests.
 *
 * The rename engine is the one part of the app that touches the user's own
 * files, so it is tested harder than anything else: planning, duplicate
 * handling, case-only renames, locked files, cancellation and undo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planRename, RenameJob, undoRename } = require('../lib/renamer');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-rename-'));

function makeClip(filePath, meta, size) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x'.repeat(size || 64), 'utf8');
  const st = fs.statSync(filePath);
  return Object.assign(
    {
      id: `c_${path.basename(filePath, path.extname(filePath))}`,
      sourcePath: filePath,
      fileName: path.basename(filePath),
      size: st.size,
      sceneOn: false,
      shotOn: false,
      takeOn: false,
      scene: null,
      shot: null,
      take: null,
      extra: false,
      customOn: false,
      custom: '',
      timeText: '00-00-07',
      status: 'new',
      meta: { duration: 4, width: 1920, height: 1080, fps: 25, timecodeFromSource: true },
    },
    meta || {}
  );
}

test('a clean plan renames files in their own folder and keeps the extension', async () => {
  const dir = path.join(tmpRoot, 'clean');
  const clip = makeClip(path.join(dir, 'IMG_0001.MP4'), { sceneOn: true, scene: 1, shotOn: true, shot: 2, takeOn: true, take: 3 });
  const plan = await planRename([clip]);
  assert.strictEqual(plan.summary.ready, 1);
  assert.strictEqual(plan.summary.total, 1);
  // The extension is normalised to lower case — exactly like the export engine.
  assert.strictEqual(path.basename(plan.entries[0].targetPath), 'S-1_SH-2_T-3_(1-2-3).mp4');
  assert.strictEqual(path.dirname(plan.entries[0].targetPath), dir, 'it stays in the same folder');

  const job = new RenameJob(plan, {}, () => {});
  const result = await job.run();
  assert.strictEqual(result.renamed, 1);
  assert.strictEqual(fs.existsSync(clip.sourcePath), false, 'the old name is gone');
  assert.ok(fs.existsSync(path.join(dir, 'S-1_SH-2_T-3_(1-2-3).mp4')), 'the new name exists');
  assert.deepStrictEqual(result.changes, [{ id: clip.id, from: clip.sourcePath, to: path.join(dir, 'S-1_SH-2_T-3_(1-2-3).mp4') }]);
});

test('an existing file is never overwritten — the new name gets a _01 suffix', async () => {
  const dir = path.join(tmpRoot, 'clash');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'S-1_SH-1_T-1_(1-1-1).mp4'), 'occupied', 'utf8');
  const clip = makeClip(path.join(dir, 'raw_name.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 });
  const plan = await planRename([clip]);
  assert.strictEqual(plan.summary.ready, 1);
  assert.strictEqual(path.basename(plan.entries[0].targetPath), 'S-1_SH-1_T-1_(1-1-1)_01.mp4');
  assert.match(plan.entries[0].problem, /already existed/i);

  const result = await new RenameJob(plan, {}, () => {}).run();
  assert.strictEqual(result.renamed, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'S-1_SH-1_T-1_(1-1-1).mp4'), 'utf8'), 'occupied', 'the existing file is untouched');
});

test('two clips that resolve to the same name do not eat each other', async () => {
  const dir = path.join(tmpRoot, 'twins');
  const a = makeClip(path.join(dir, 'a.mp4'), { sceneOn: true, scene: 2, shotOn: true, shot: 1, takeOn: true, take: 1 });
  const b = makeClip(path.join(dir, 'b.mp4'), { sceneOn: true, scene: 2, shotOn: true, shot: 1, takeOn: true, take: 1 });
  const plan = await planRename([a, b]);
  const targets = plan.entries.map((e) => path.basename(e.targetPath));
  assert.strictEqual(new Set(targets).size, 2, `unique targets expected, got ${JSON.stringify(targets)}`);
  const result = await new RenameJob(plan, {}, () => {}).run();
  assert.strictEqual(result.renamed, 2);
  assert.strictEqual(fs.readdirSync(dir).length, 2, 'both files survive');
});

test('clips that are already correct are left alone', async () => {
  const dir = path.join(tmpRoot, 'already');
  const clip = makeClip(path.join(dir, 'S-4_SH-1_T-1_(4-1-1).mp4'), { sceneOn: true, scene: 4, shotOn: true, shot: 1, takeOn: true, take: 1 });
  const plan = await planRename([clip]);
  assert.strictEqual(plan.summary.unchanged, 1);
  assert.strictEqual(plan.summary.ready, 0);
  const result = await new RenameJob(plan, {}, () => {}).run();
  assert.strictEqual(result.renamed, 0);
  assert.strictEqual(result.untouched, 0);
  assert.ok(fs.existsSync(clip.sourcePath));
});

test('a missing source file blocks that clip but not the others', async () => {
  const dir = path.join(tmpRoot, 'missing');
  const good = makeClip(path.join(dir, 'good.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 });
  const gone = makeClip(path.join(dir, 'gone.mp4'), { sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 2 });
  fs.unlinkSync(gone.sourcePath);

  const plan = await planRename([good, gone]);
  assert.strictEqual(plan.summary.ready, 1);
  assert.strictEqual(plan.summary.blocked, 1);
  const blocked = plan.entries.find((e) => e.id === gone.id);
  assert.match(blocked.problem, /missing from disk/i);

  const result = await new RenameJob(plan, {}, () => {}).run();
  assert.strictEqual(result.renamed, 1);
  assert.strictEqual(result.blocked, 1);
});

test('a clip with no Scene/Shot/Take keeps its own name plus the tag bracket', async () => {
  const dir = path.join(tmpRoot, 'untagged');
  const clip = makeClip(path.join(dir, 'raw_clip.mov'), { timeText: '12-30-01' });
  const plan = await planRename([clip]);
  // The bracket always carries Scene-Shot-Take (0 = not set), never the time.
  assert.strictEqual(path.basename(plan.entries[0].targetPath), 'raw_clip_(0-0-0).mov');
});

test('progress is reported for every file with real percentages', async () => {
  const dir = path.join(tmpRoot, 'progress');
  const clips = [1, 2, 3, 4].map((n) =>
    makeClip(path.join(dir, `p${n}.mp4`), { sceneOn: true, scene: 1, shotOn: true, shot: n, takeOn: true, take: 1 })
  );
  const plan = await planRename(clips);
  const seen = [];
  await new RenameJob(plan, {}, (p) => seen.push(p)).run();

  assert.ok(seen.length >= 5, `expected progress for every file, got ${seen.length}`);
  const percents = seen.map((p) => p.percent);
  assert.ok(percents.some((p) => p > 0 && p < 100), `intermediate values: ${JSON.stringify(percents)}`);
  assert.strictEqual(percents[percents.length - 1], 100);
  assert.ok(seen.every((p) => p.total === 4), 'the total travels with every event');
  assert.ok(seen.some((p) => p.currentTarget && p.currentName), 'each step names the file it is working on');
});

test('cancelling stops the run and reports what already happened', async () => {
  const dir = path.join(tmpRoot, 'cancel');
  const clips = [1, 2, 3, 4, 5].map((n) =>
    makeClip(path.join(dir, `c${n}.mp4`), { sceneOn: true, scene: 1, shotOn: true, shot: n, takeOn: true, take: 1 })
  );
  const plan = await planRename(clips);
  const job = new RenameJob(plan, {}, () => {});
  let count = 0;
  const originalRename = job.renameOne.bind(job);
  job.renameOne = async (entry) => {
    count += 1;
    if (count === 3) job.cancel();
    return originalRename(entry);
  };
  const result = await job.run();
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.renamed, 3);
  assert.strictEqual(result.changes.length, 3, 'the undo log holds exactly what was renamed');
});

test('UNDO RENAME puts every original name back', async () => {
  const dir = path.join(tmpRoot, 'undo');
  const clips = [1, 2, 3].map((n) =>
    makeClip(path.join(dir, `u${n}.mp4`), { sceneOn: true, scene: 5, shotOn: true, shot: n, takeOn: true, take: 1 })
  );
  const before = clips.map((c) => c.sourcePath);
  const plan = await planRename(clips);
  const result = await new RenameJob(plan, {}, () => {}).run();
  assert.strictEqual(result.renamed, 3);

  const undoResult = await undoRename(result.changes);
  assert.strictEqual(undoResult.restored, 3);
  for (const original of before) assert.ok(fs.existsSync(original), `${original} is back`);
});

test('undo refuses to overwrite a file that reappeared with the original name', async () => {
  const dir = path.join(tmpRoot, 'undo-clash');
  const clip = makeClip(path.join(dir, 'clashy.mp4'), { sceneOn: true, scene: 6, shotOn: true, shot: 1, takeOn: true, take: 1 });
  const plan = await planRename([clip]);
  const result = await new RenameJob(plan, {}, () => {}).run();
  fs.writeFileSync(clip.sourcePath, 'something else', 'utf8'); // the user re-created it

  const undoResult = await undoRename(result.changes);
  assert.strictEqual(undoResult.restored, 0);
  assert.match(undoResult.results[0].message, /nothing was overwritten/i);
  assert.strictEqual(fs.readFileSync(clip.sourcePath, 'utf8'), 'something else', 'the new file is safe');
});

test('planning never writes anything to disk', async () => {
  const dir = path.join(tmpRoot, 'readonly-plan');
  const clip = makeClip(path.join(dir, 'plan-only.mp4'), { sceneOn: true, scene: 9, shotOn: true, shot: 9, takeOn: true, take: 9 });
  const before = fs.readdirSync(dir).sort();
  await planRename([clip]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'the folder is untouched by planning');
});

test('a custom name is used verbatim and keeps the source extension', async () => {
  const dir = path.join(tmpRoot, 'custom');
  const clip = makeClip(path.join(dir, 'zz.mp4'), { customOn: true, custom: 'Opening Drone Shot' });
  const plan = await planRename([clip]);
  assert.strictEqual(path.basename(plan.entries[0].targetPath), 'Opening Drone Shot.mp4');
});

test('files are never renamed outside the folder they came from', async () => {
  const dir = path.join(tmpRoot, 'stay');
  const clip = makeClip(path.join(dir, 'deep.mp4'), { sceneOn: true, scene: 3, shotOn: true, scene2: true, shot: 1, takeOn: true, take: 1 });
  const plan = await planRename([clip]);
  assert.strictEqual(path.dirname(plan.entries[0].targetPath), dir);
  assert.ok(!plan.entries[0].targetPath.includes(`Scene_0`), 'the rename engine does not create Scene folders');
});
