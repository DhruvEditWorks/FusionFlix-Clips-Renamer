'use strict';
/**
 * Preview proxies.
 *
 * Windows/Chromium cannot decode HEVC, ProRes, DNxHD and friends, which is why
 * such clips used to show nothing at all in the player. When FFmpeg is around
 * the app now builds a small H.264 stand-in for that one clip. These tests
 * cover the cache keys/paths, the ffmpeg arguments, and — when a real FFmpeg is
 * available — an end-to-end proxy of an actual video file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const media = require('../lib/media');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proxy-'));
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (_) {}
});

/** ffmpeg prints its input info to stderr and exits non-zero without an output file. */
function probeText(bin, file) {
  try {
    return execFileSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

function systemFfmpeg() {
  for (const candidate of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch (_) {
      /* try the next one */
    }
  }
  return null;
}

test('proxy cache keys follow the file, and a changed file gets a new key', () => {
  const p = path.join(tmpRoot, 'clip.mp4');
  const a = media.proxyKey(p, { size: 100, mtimeMs: 1000 });
  const b = media.proxyKey(p, { size: 100, mtimeMs: 1000 });
  const c = media.proxyKey(p, { size: 101, mtimeMs: 1000 });
  const d = media.proxyKey(p, { size: 100, mtimeMs: 2000 });
  assert.strictEqual(a, b, 'same file, same key');
  assert.notStrictEqual(a, c, 'growing the file invalidates the proxy');
  assert.notStrictEqual(a, d, 'touching the file invalidates the proxy');
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('proxies live in their own folder inside the cache', () => {
  const target = media.proxyPathFor(path.join(tmpRoot, 'cache'), 'abcdef0123456789');
  assert.ok(target.startsWith(path.join(tmpRoot, 'cache', 'proxies')), target);
  assert.ok(target.endsWith('.mp4'));
});

test('a proxy of a missing file is refused before ffmpeg is ever started', async () => {
  await assert.rejects(
    () => media.ensureProxy({ filePath: path.join(tmpRoot, 'nope.mp4'), cacheDir: tmpRoot }),
    /could not be found/i
  );
});

test('the proxy command line is safe: no shell, H.264, streamable, no upscaling', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media.js'), 'utf8');
  assert.match(src, /shell: false/, 'ffmpeg is never run through a shell');
  assert.ok(!/exec\(|execSync\(/.test(src), 'no shell string execution');
  assert.match(src, /'-c:v', 'libx264'/, 'H.264 is used for compatibility');
  assert.match(src, /scale='min\(\$\{w\},iw\)':-2/, 'never upscales, keeps the aspect ratio');
  assert.match(src, /'-movflags', '\+faststart'/, 'the proxy is streamable');
  assert.match(src, /fallbackArgs\[vi\] = 'mpeg4'/, 'a build without libx264 still gets a proxy');
});

test('an existing proxy is reused instead of re-encoded', async (t) => {
  const ffmpeg = systemFfmpeg();
  if (!ffmpeg) return t.skip('no FFmpeg on this machine');

  const dir = path.join(tmpRoot, 'reuse');
  await fsp.mkdir(dir, { recursive: true });
  const src = path.join(dir, 'short.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);

  const cache = path.join(dir, 'cache');
  const first = await media.ensureProxy({ filePath: src, cacheDir: cache, ffmpegPath: ffmpeg, duration: 1 });
  assert.strictEqual(first.cached, false, 'the first call builds it');
  const again = await media.ensureProxy({ filePath: src, cacheDir: cache, ffmpegPath: ffmpeg, duration: 1 });
  assert.strictEqual(again.cached, true, 'the second call reuses the file');
  assert.strictEqual(again.path, first.path);
  const size = fs.statSync(first.path).size;
  assert.ok(size > 1000, `proxy has real content (${size} bytes)`);
  assert.notStrictEqual(fs.statSync(first.path).ino, fs.statSync(src).ino, 'the proxy is its own file');
});

test('an HEVC clip gets a playable H.264 proxy (the real-world case)', async (t) => {
  const ffmpeg = systemFfmpeg();
  if (!ffmpeg) return t.skip('no FFmpeg on this machine');

  const dir = path.join(tmpRoot, 'hevc');
  await fsp.mkdir(dir, { recursive: true });
  const src = path.join(dir, 'camera_hevc.mp4');
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', src]);
  } catch (_) {
    return t.skip('this FFmpeg cannot produce HEVC');
  }
  // Sanity: the source really is HEVC.
  assert.match(probeText(ffmpeg, src), /hevc/i, 'the test file is HEVC');

  const progress = [];
  const res = await media.ensureProxy({
    filePath: src,
    cacheDir: path.join(dir, 'cache'),
    ffmpegPath: ffmpeg,
    duration: 1,
    onProgress: (ratio) => progress.push(ratio),
  });
  assert.ok(fs.existsSync(res.path), 'a proxy exists');

  // ...and the proxy is H.264, i.e. something Chromium can actually decode.
  assert.match(probeText(ffmpeg, res.path), /h264/i, 'the proxy is H.264');
});
