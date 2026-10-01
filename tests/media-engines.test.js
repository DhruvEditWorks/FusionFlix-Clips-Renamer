'use strict';
/**
 * Fusion Flix — media-engine discovery.
 *
 * FFmpeg can arrive in several ways (bundled, installed by the installer, or
 * downloaded later from Settings). These tests cover the lookup order that makes
 * all of those work — including the per-user folder a portable build needs.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const media = require('../lib/media');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-engines-'));

test('a per-user engine folder is searched (portable builds unpack to a temp dir)', () => {
  const extra = path.join(tmpRoot, 'userdata', 'ffmpeg');
  fs.mkdirSync(extra, { recursive: true });
  // The resolver looks for the platform's own binary name — cover both so the
  // test means the same thing on Windows and everywhere else.
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe'];
  for (const name of names) fs.writeFileSync(path.join(extra, name), 'MZ');

  media.setExtraEngineDirs([extra]);
  media.resetEngineCache();
  assert.strictEqual(path.dirname(media.resolveFfmpeg(null)), extra);
  assert.strictEqual(path.dirname(media.resolveFfprobe(null)), extra);
  assert.strictEqual(path.basename(media.resolveFfmpeg(null)), names[0]);
});

test('an explicit Settings path always wins', () => {
  const chosen = path.join(tmpRoot, 'chosen-ffmpeg.exe');
  fs.writeFileSync(chosen, 'MZ');
  media.setExtraEngineDirs([path.join(tmpRoot, 'nope')]);
  media.resetEngineCache();
  assert.strictEqual(media.resolveFfmpeg(null, chosen), chosen);
});

test('an empty extra folder changes nothing and does not break the lookup', () => {
  media.setExtraEngineDirs([]);
  media.resetEngineCache();
  const resolved = media.resolveFfmpeg(null);
  assert.ok(typeof resolved === 'string' && resolved.length > 0, resolved);
});

test('checkEngines returns a usable report shape', async () => {
  const empty = path.join(tmpRoot, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  media.setExtraEngineDirs([]);
  media.resetEngineCache();
  const report = await media.checkEngines(empty, {});
  for (const key of ['ffmpeg', 'ffprobe']) {
    assert.ok(report[key], `${key} is reported`);
    assert.strictEqual(typeof report[key].ok, 'boolean', `${key}.ok is a boolean`);
    assert.ok(String(report[key].path).length > 0, `${key}.path always says where it looked`);
    assert.strictEqual(typeof report[key].version, 'string');
  }
  // A Settings path that does not exist must never be treated as the engine:
  // the lookup falls through to the other candidates (that is the whole point
  // of the ordered search), so what matters is that it keeps looking instead of
  // handing back a path that cannot run.
  const bogus = await media.checkEngines(empty, {
    ffmpegPath: path.join(empty, 'definitely-not-here', 'ffmpeg.exe'),
    ffprobePath: path.join(empty, 'definitely-not-here', 'ffprobe.exe'),
  });
  assert.ok(!String(bogus.ffmpeg.path).includes('definitely-not-here'), `it did not stop at a dead path (${bogus.ffmpeg.path})`);
});
