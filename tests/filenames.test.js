'use strict';
/**
 * Fusion Flix — naming / sanitising engine tests.
 * Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const F = require('../lib/filenames');
const S = require('../lib/sanitize');
const V = require('../lib/validate');

function clip(over) {
  return Object.assign(
    {
      id: 'c1',
      order: 0,
      sourcePath: '/footage/IMG_4821.mp4',
      fileName: 'IMG_4821.mp4',
      sceneOn: false,
      scene: null,
      shotOn: false,
      shot: null,
      takeOn: false,
      take: null,
      extra: false,
      customOn: false,
      custom: '',
      timeText: '01-05-15',
      status: 'new',
      meta: { duration: 6 },
    },
    over || {}
  );
}

test('standard filename format matches the specification', () => {
  const c = clip({ sceneOn: true, scene: 1, shotOn: true, shot: 5, takeOn: true, take: 15 });
  assert.strictEqual(F.finalFileName(c), 'S-1_SH-5_T-15_(1-5-15).mp4');
});

test('extra clips get the _EXTRA_ marker', () => {
  const c = clip({ sceneOn: true, scene: 1, shotOn: true, shot: 5, takeOn: true, take: 15, extra: true });
  assert.strictEqual(F.finalFileName(c), 'S-1_SH-5_T-15_EXTRA_(1-5-15).mp4');
});

test('spec examples all resolve correctly', () => {
  assert.strictEqual(
    F.finalFileName(clip({ fileName: 'a.mp4', timeText: '00-00-01', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 })),
    'S-1_SH-1_T-1_(1-1-1).mp4'
  );
  assert.strictEqual(
    F.finalFileName(clip({ fileName: 'a.mov', timeText: '00-02-14', sceneOn: true, scene: 1, shotOn: true, shot: 2, takeOn: true, take: 3 })),
    'S-1_SH-2_T-3_(1-2-3).mov'
  );
  assert.strictEqual(
    F.finalFileName(clip({ fileName: 'a.mp4', timeText: '01-05-15', sceneOn: true, scene: 2, shotOn: true, shot: 5, takeOn: true, take: 15 })),
    'S-2_SH-5_T-15_(2-5-15).mp4'
  );
});

test('original extension is always preserved', () => {
  for (const ext of ['mp4', 'MOV', 'mkv', 'M4V', 'mts']) {
    const c = clip({ fileName: `clip.${ext}`, sceneOn: true, scene: 3 });
    assert.ok(F.finalFileName(c).endsWith(`.${ext.toLowerCase()}`), `extension ${ext} preserved`);
  }
});

test('custom name overrides the standard name but metadata survives', () => {
  const c = clip({ customOn: true, custom: 'Opening Drone Shot', sceneOn: true, scene: 7, shotOn: true, shot: 2 });
  assert.strictEqual(F.finalFileName(c), 'Opening Drone Shot.mp4');
  const restored = JSON.parse(JSON.stringify(c));
  assert.strictEqual(restored.scene, 7);
  assert.strictEqual(restored.shot, 2);
});

test('scene/shot/take can be disabled independently', () => {
  assert.strictEqual(F.finalFileName(clip({ shotOn: true, shot: 6, timeText: '00-00-02' })), 'SH-6_(0-6-0).mp4');
  assert.strictEqual(F.finalFileName(clip({ takeOn: true, take: 4, timeText: '00-00-03' })), 'T-4_(0-0-4).mp4');
});

test('a clip with nothing set is flagged as needing a name', () => {
  const c = clip();
  assert.strictEqual(F.needsNaming(c), true);
  assert.strictEqual(F.finalFileName(c), 'IMG_4821_(0-0-0).mp4');
  assert.strictEqual(F.needsNaming(clip({ sceneOn: true, scene: 1 })), false);
});

test('time helpers format and parse correctly', () => {
  assert.strictEqual(F.formatTimePart('01:05:15:12'), '01-05-15');
  assert.strictEqual(F.formatTimePart('00:00:01;20'), '00-00-01');
  assert.strictEqual(F.formatTimePart(3915), '01-05-15');
  assert.strictEqual(F.secondsToTimePart(1), '00-00-01');
  assert.strictEqual(F.timePartToSeconds('01-05-15'), 3915);
  assert.strictEqual(F.formatDuration(64), '1:04');
  assert.strictEqual(F.formatDuration(3723), '1:02:03');
});

test('computeTimeText prefers real timecode, then the configured fallback', () => {
  const meta = { timecode: '01:05:15:00', timecodeFromSource: true };
  assert.strictEqual(F.computeTimeText(meta, { timecodeFallback: 'zero' }), '01-05-15');

  assert.strictEqual(F.computeTimeText({}, { timecodeFallback: 'zero' }), '00-00-00');
  assert.strictEqual(F.computeTimeText({}, { timecodeFallback: 'index', index: 42 }), '00-00-42');
  const stamped = Date.parse('2026-02-03T07:08:09Z');
  const value = F.computeTimeText({ mtimeMs: stamped }, { timecodeFallback: 'file-time' });
  assert.match(value, /^\d{2}-\d{2}-\d{2}$/);
  assert.notStrictEqual(value, '00-00-00');
});

test('export folders are created for Scene only', () => {
  const c = clip({ sceneOn: true, scene: 2, shotOn: true, shot: 5, takeOn: true, take: 15 });
  assert.strictEqual(F.finalRelativePath(c), 'Scene_02/S-2_SH-5_T-15_(2-5-15).mp4');
  assert.strictEqual(F.sceneFolderName(1), 'Scene_01');
  assert.strictEqual(F.sceneFolderName(12), 'Scene_12');
  assert.strictEqual(F.sceneFolderName(120), 'Scene_120');
  const unassigned = F.finalRelativePath(clip({ sceneOn: false }));
  assert.ok(unassigned.startsWith('Unassigned/'), 'clips without a scene go to Unassigned');
});

test('filenames are sanitised for Windows', () => {
  assert.strictEqual(S.sanitizeFileName('a<b>c:d'), 'a b c d');
  assert.strictEqual(S.sanitizeFileName('trailing dots...'), 'trailing dots');
  assert.strictEqual(S.sanitizeFileName('CON'), '_CON');
  assert.strictEqual(S.sanitizeFileName('  spaced   out  '), 'spaced out');
  assert.strictEqual(S.sanitizeFileName('slash/back\\slash'), 'slash back slash');
  assert.strictEqual(S.sanitizeFileName(''), 'clip');
  assert.strictEqual(S.sanitizeFileName('', { fallback: '' }), '');
  const long = S.sanitizeFileName('x'.repeat(400));
  assert.ok(long.length <= S.MAX_NAME_LENGTH);
});

test('custom names are sanitised in the final filename', () => {
  const c = clip({ customOn: true, custom: 'Scene: 4 / Drone*Pass?' });
  const name = F.finalFileName(c);
  assert.ok(!/[<>:"/\\|?*]/.test(name), `no illegal characters in "${name}"`);
});

test('unicode filenames survive', () => {
  const c = clip({ fileName: 'टेस्ट_クリップ_🎬.mp4', customOn: true, custom: 'नमस्ते 🎬 shot' });
  const name = F.finalFileName(c);
  assert.ok(name.includes('नमस्ते'), 'Devanagari preserved');
  assert.ok(name.includes('🎬'), 'emoji preserved');
  assert.ok(name.endsWith('.mp4'));
});

test('sorting works for every supported key', () => {
  const clips = [
    clip({ id: 'a', order: 0, sceneOn: true, scene: 3, shotOn: true, shot: 1, takeOn: true, take: 2, fileName: 'c.mp4' }),
    clip({ id: 'b', order: 1, sceneOn: true, scene: 1, shotOn: true, shot: 9, takeOn: true, take: 1, fileName: 'a.mp4' }),
    clip({ id: 'c', order: 2, sceneOn: false, shotOn: false, takeOn: false, fileName: 'b.mp4' }),
  ];
  assert.deepStrictEqual(F.sortClips(clips, 'import').map((c) => c.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(F.sortClips(clips, 'scene').map((c) => c.id), ['b', 'a', 'c']);
  assert.deepStrictEqual(F.sortClips(clips, 'shot').map((c) => c.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(F.sortClips(clips, 'take').map((c) => c.id), ['b', 'a', 'c']);
  assert.deepStrictEqual(F.sortClips(clips, 'filename').map((c) => c.id), ['b', 'c', 'a']);
  assert.deepStrictEqual(F.sortClips(clips, 'scene', -1).map((c) => c.id), ['a', 'b', 'c']);
});

test('duplicate detection finds identical scene/shot/take tuples', () => {
  const clips = [
    clip({ id: '1', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 }),
    clip({ id: '2', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1 }),
    clip({ id: '3', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 2 }),
  ];
  const result = V.validateProject(clips);
  assert.ok(result.duplicateSST['1|1|1'], 'duplicate tuple detected');
  assert.ok(result.warningCount >= 1);
});

test('duplicate output names are resolved with _01/_02 suffixes', () => {
  const clips = [
    clip({ id: '1', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1, timeText: '00-00-01' }),
    clip({ id: '2', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1, timeText: '00-00-01' }),
    clip({ id: '3', sceneOn: true, scene: 1, shotOn: true, shot: 1, takeOn: true, take: 1, timeText: '00-00-01' }),
  ];
  const { byId, renamed } = V.resolveOutputNames(clips);
  assert.strictEqual(byId['1'].fileName, 'S-1_SH-1_T-1_(1-1-1).mp4');
  assert.strictEqual(byId['2'].fileName, 'S-1_SH-1_T-1_(1-1-1)_01.mp4');
  assert.strictEqual(byId['3'].fileName, 'S-1_SH-1_T-1_(1-1-1)_02.mp4');
  assert.strictEqual(renamed.length, 2);
  assert.ok(byId['2'].relPath.startsWith('Scene_01/'));
});

test('validation reports hard errors for missing metadata and files', () => {
  const broken = V.validateClip(clip({ sceneOn: true, scene: null }));
  assert.ok(broken.some((i) => i.code === 'scene-empty'));
  const customEmpty = V.validateClip(clip({ customOn: true, custom: '   ' }));
  assert.ok(customEmpty.some((i) => i.code === 'custom-empty'));
  const missingFile = V.validateClip(clip({ status: 'missing' }));
  assert.ok(missingFile.some((i) => i.code === 'missing-media'));
});
