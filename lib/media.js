'use strict';
/**
 * FUSION FLIX — media engine (FFmpeg / FFprobe).
 *
 * Locates the binaries, probes metadata, detects source timecode and renders
 * thumbnails into a cache folder. Only ever spawns the binary directly with an
 * argument array — never through a shell, never with user text.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { formatFps, formatResolution, formatDuration } = require('./filenames');
const { uniquePath, isInside: paths_isInside } = require('./paths');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const CREATE_NO_WINDOW = 0x08000000; // keep ffmpeg from flashing a console window

let cachedFfmpeg = null;
let cachedFfprobe = null;

/**
 * Forgets the resolved binary paths (called after the user locates a new
 * ffmpeg/ffprobe in Settings).
 */
function resetEngineCache() {
  cachedFfmpeg = null;
  cachedFfprobe = null;
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

/** Extra folders to search, e.g. the per-user engine folder of a portable build. */
const extraEngineDirs = [];

/** The app tells us where else to look (portable builds unpack to a temp dir). */
function setExtraEngineDirs(dirs) {
  extraEngineDirs.length = 0;
  for (const dir of dirs || []) if (dir) extraEngineDirs.push(dir);
  resetEngineCache();
}

/** Optional bundled copies, e.g. <app>/resources/ffmpeg/ffmpeg.exe */
function bundledCandidates(name, resourcesDir) {
  const dirs = [];
  if (resourcesDir) dirs.push(path.join(resourcesDir, 'ffmpeg'));
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'ffmpeg'));
  for (const dir of extraEngineDirs) dirs.push(dir);
  dirs.push(path.join(__dirname, '..', 'ffmpeg'));
  dirs.push(path.join(__dirname, '..', '..', 'ffmpeg'));
  return dirs.map((d) => path.join(d, `${name}${EXE}`));
}

/**
 * Resolves the ffmpeg binary path.
 * Order: explicit setting (Settings → Locate) → env var → bundled folder →
 * npm package → PATH.
 */
function resolveFfmpeg(resourcesDir, explicitPath) {
  if (explicitPath) {
    const found = firstExisting([explicitPath]);
    if (found) {
      cachedFfmpeg = found;
      return cachedFfmpeg;
    }
  }
  if (cachedFfmpeg) return cachedFfmpeg;
  const env = process.env.FFMPEG_PATH;
  cachedFfmpeg =
    firstExisting([env, ...bundledCandidates('ffmpeg', resourcesDir)]) ||
    (function fromNpm() {
      try {
        // eslint-disable-next-line global-require
        const p = require('ffmpeg-static');
        if (typeof p === 'string' && fs.existsSync(p)) return p;
      } catch (_) {}
      return null;
    })() ||
    firstExisting(bundledCandidates('ffmpeg', resourcesDir)) ||
    `ffmpeg${EXE}`;
  return cachedFfmpeg;
}

/** Resolves the ffprobe binary path (same order as ffmpeg). */
function resolveFfprobe(resourcesDir, explicitPath) {
  if (explicitPath) {
    const found = firstExisting([explicitPath]);
    if (found) {
      cachedFfprobe = found;
      return cachedFfprobe;
    }
  }
  if (cachedFfprobe) return cachedFfprobe;
  const env = process.env.FFPROBE_PATH;
  cachedFfprobe =
    firstExisting([env, ...bundledCandidates('ffprobe', resourcesDir)]) ||
    (function fromNpm() {
      try {
        // eslint-disable-next-line global-require
        const mod = require('ffprobe-static');
        const p = mod && (mod.path || mod);
        if (typeof p === 'string' && fs.existsSync(p)) return p;
      } catch (_) {}
      return null;
    })() ||
    `ffprobe${EXE}`;
  return cachedFfprobe;
}

/** Runs a binary and resolves with stdout (rejects with a short, safe error). */
function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        // On Windows, no shell is used at all, so paths are passed verbatim.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`Could not start ${path.basename(bin)}.`));
      return;
    }

    const out = [];
    const errOut = [];
    let settled = false;
    const timer = options.timeout
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              child.kill('SIGKILL');
            } catch (_) {}
            reject(new Error('The media engine took too long to respond.'));
          }
        }, options.timeout)
      : null;

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      if (errOut.length < 40) errOut.push(d);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const err = new Error(`${path.basename(bin)} was not found or could not be started.`);
      err.code = 'ENGINE_MISSING';
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(errOut).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error('The media engine could not read this file.'), { code, stderr: stderr.slice(0, 500) }));
    });
  });
}

/** Converts "30000/1001" → 29.97 */
function parseRate(str) {
  if (!str || typeof str !== 'string') return 0;
  const [a, b] = str.split('/');
  const num = Number(a);
  const den = b === undefined ? 1 : Number(b);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return Math.round((num / den) * 1000) / 1000;
}

/** Pulls a QuickTime/MP4 timecode value out of ffprobe's tag soup. */
function extractTimecode(probe) {
  const sources = [];
  const format = probe && probe.format;
  const streams = (probe && probe.streams) || [];

  if (format && format.tags) {
    for (const key of ['timecode', 'TIMECODE', 'com.apple.quicktime.timecode']) {
      if (format.tags[key]) sources.push(format.tags[key]);
    }
  }
  for (const s of streams) {
    if (s.codec_type === 'data' && s.codec_tag_string && /tmcd/i.test(s.codec_tag_string) && s.tags && s.tags.timecode) {
      sources.push(s.tags.timecode);
    }
    if (s.tags) {
      for (const key of ['timecode', 'TIMECODE']) {
        if (s.tags[key]) sources.push(s.tags[key]);
      }
    }
  }
  // Validate the shape: HH:MM:SS:FF / HH:MM:SS;FF / HH:MM:SS
  for (const raw of sources) {
    const m = String(raw).match(/^(\d{1,2}):(\d{2}):(\d{2})([:;.]\d{1,3})?$/);
    if (m) return String(raw).trim();
  }
  return '';
}

/**
 * Probes a single video file.
 * Resolves (never rejects) with a metadata object; failures are reported in
 * `probeError` so a single bad file can never break a bulk import.
 */
async function probeFile(filePath, options = {}) {
  const bin = resolveFfprobe(options.resourcesDir, options.ffprobePath);
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];

  const meta = {
    duration: 0,
    size: 0,
    width: 0,
    height: 0,
    fps: 0,
    videoCodec: '',
    audioCodec: '',
    audioChannels: 0,
    hasAudio: false,
    bitrate: 0,
    formatName: '',
    timecode: '',
    timecodeFromSource: false,
    probeError: '',
  };

  try {
    const { stdout } = await run(bin, args, { timeout: options.timeout || 30000 });
    const probe = JSON.parse(stdout || '{}');
    const streams = probe.streams || [];
    const video = streams.find((s) => s.codec_type === 'video') || null;
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const format = probe.format || {};

    meta.duration = Number(format.duration) || (video && Number(video.duration)) || 0;
    meta.size = Number(format.size) || 0;
    meta.bitrate = Number(format.bit_rate) || 0;
    meta.formatName = format.format_name || '';
    if (video) {
      meta.width = Number(video.width) || 0;
      meta.height = Number(video.height) || 0;
      meta.fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 0;
      meta.videoCodec = video.codec_name || '';
    }
    if (audio) {
      meta.hasAudio = true;
      meta.audioCodec = audio.codec_name || '';
      meta.audioChannels = Number(audio.channels) || 0;
    }
    const tc = extractTimecode(probe);
    if (tc) {
      meta.timecode = tc;
      meta.timecodeFromSource = true;
    }
    if (!isFinite(meta.duration)) meta.duration = 0;
  } catch (err) {
    meta.probeError = err && err.message ? err.message : 'The media engine could not read this file.';
  }

  meta.resolutionText = formatResolution(meta.width, meta.height);
  meta.fpsText = formatFps(meta.fps);
  meta.durationText = formatDuration(meta.duration);
  return meta;
}

/** Small helper: stat() with graceful failure. */
async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch (_) {
    return null;
  }
}

/** Cache key for a thumbnail: path + size + mtime (+ variant, e.g. a big still). */
function thumbKey(filePath, stat, variant) {
  return crypto
    .createHash('sha1')
    .update(`${path.normalize(filePath)}|${stat.size}|${Math.floor(stat.mtimeMs)}|${variant || 'thumb'}`)
    .digest('hex');
}

/** Thumbnail file path inside the cache (two-level fan-out). */
function thumbPathFor(cacheDir, key) {
  return path.join(cacheDir, key.slice(0, 2), `${key}.jpg`);
}

/**
 * Extracts a JPEG thumbnail with ffmpeg.
 * @param {object} opts { filePath, cacheDir, atSeconds, width, resourcesDir }
 * @returns {Promise<{path:string, cached:boolean}>}
 */
async function ensureThumbnail(opts) {
  const { filePath, cacheDir } = opts;
  const stat = await statSafe(filePath);
  if (!stat) throw new Error('The source file could not be found.');

  const key = thumbKey(filePath, stat, opts.variant);
  const target = thumbPathFor(cacheDir, key);

  const existing = await statSafe(target);
  if (existing && existing.size > 0) return { path: target, cached: true };

  await fsp.mkdir(path.dirname(target), { recursive: true });

  const bin = resolveFfmpeg(opts.resourcesDir, opts.ffmpegPath);
  const width = Math.max(96, Math.min(1920, Number(opts.width) || 320));
  const duration = Number(opts.duration) || 0;
  // Grab ~15% into the clip so we rarely land on a black first frame.
  let at = Number(opts.atSeconds);
  if (!Number.isFinite(at) || at <= 0) at = duration > 1 ? Math.min(duration * 0.15, 30) : 0;

  let lastError = null;
  // Temp file keeps a .jpg ending so ffmpeg can pick the muxer safely.
  const tmp = uniquePath(`${target}.part.jpg`);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', at.toFixed(3),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2:flags=bicubic`,
    '-q:v', '4',
    '-f', 'image2',
    '-y',
    tmp,
  ];

  try {
    await run(bin, args, { timeout: opts.timeout || 45000 });
    await fsp.rename(tmp, target);
    return { path: target, cached: false };
  } catch (err) {
    lastError = err;
    try {
      await fsp.unlink(tmp);
    } catch (_) {}
    // Some containers refuse mid-file seeks — retry from the very start.
    if (at > 0.05 && err.code !== 'ENGINE_MISSING') {
      try {
        await run(
          bin,
          ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=bicubic`, '-q:v', '4', '-f', 'image2', '-y', tmp],
          { timeout: opts.timeout || 45000 }
        );
        await fsp.rename(tmp, target);
        return { path: target, cached: false };
      } catch (_) {
        try {
          await fsp.unlink(tmp);
        } catch (_) {}
      }
    }
    const failure = new Error(
      lastError && lastError.code === 'ENGINE_MISSING'
        ? 'FFmpeg was not found, so thumbnails cannot be generated on the desktop side.'
        : 'A thumbnail could not be created for this clip.'
    );
    failure.code = (lastError && lastError.code) || '';
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Preview proxies
// ---------------------------------------------------------------------------
/**
 * Windows/Chromium can only decode a handful of codecs (H.264, VP8/VP9, AV1 in
 * some builds, plus whatever hardware decoding the machine offers). Camera
 * footage is frequently HEVC/H.265, Apple ProRes, DNxHD or 10-bit — for those
 * the built-in player fails with "no supported streams" and the user sees
 * nothing. A *still frame* is a poor comfort when you are sorting rushes.
 *
 * So when FFmpeg is available we build a small H.264 "preview proxy" of that
 * one clip (max 1280 px wide, ~2 Mbps, faststart) into the cache and play that
 * instead. The original file is only ever read. The proxy is cached, so the
 * second look is instant, and it is thrown away like any other cache file.
 */

/** Cache key for a proxy: changes whenever the source file changes. */
function proxyKey(filePath, stat) {
  const h = crypto.createHash('sha1');
  h.update('proxy');
  h.update(String(path.resolve(String(filePath))));
  h.update('|');
  h.update(String(stat ? stat.size : 0));
  h.update('|');
  h.update(String(stat ? Math.round(stat.mtimeMs) : 0));
  return h.digest('hex').slice(0, 40);
}

function proxyDirFor(cacheDir) {
  return path.join(cacheDir, 'proxies');
}

/** Where the proxy of a clip lives (two-level fan-out, like thumbnails). */
function proxyPathFor(cacheDir, key) {
  return path.join(proxyDirFor(cacheDir), key.slice(0, 2), `${key}.mp4`);
}

/** ffmpeg arguments for a proxy. Kept small, fast and broadly playable. */
function proxyArgs(input, output, width) {
  const w = Math.max(320, Math.min(1920, Number(width) || 1280));
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-progress', 'pipe:1',
    '-i', input,
    // Never upscale; keep the aspect ratio; even dimensions for yuv420p.
    '-vf', `scale='min(${w},iw)':-2:flags=fast_bilinear`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    // A proxy is for looking, not for mixing — keep any audio, drop nothing else.
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y',
    output,
  ];
}

/** Progress from ffmpeg's `-progress pipe:1` output (out_time_us=…). */
function parseProgressChunk(text, duration) {
  const lines = String(text || '').split(/\r?\n/);
  let ratio = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].trim().match(/^(out_time_us|out_time_ms)=(\d+)$/);
    if (!m) continue;
    const seconds = Number(m[2]) / 1_000_000;
    if (Number.isFinite(seconds) && duration > 0) ratio = Math.max(0, Math.min(1, seconds / duration));
    break;
  }
  return ratio;
}

/**
 * Builds (or reuses) the preview proxy for one clip.
 *
 * @param {object} opts
 *   filePath, cacheDir, resourcesDir, ffmpegPath,
 *   duration   — seconds, used for the progress percentage
 *   width      — max proxy width (default 1280)
 *   onProgress — (ratio0to1) => void
 *   token      — { cancelled:boolean }
 * @returns {Promise<{path:string, cached:boolean, width:number}>}
 */
async function ensureProxy(opts) {
  const filePath = opts && opts.filePath;
  const cacheDir = opts && opts.cacheDir;
  if (!filePath) throw new Error('No clip was given.');
  if (!cacheDir) throw new Error('The cache folder is not available.');

  const stat = await statSafe(filePath);
  if (!stat) throw new Error('The source file could not be found.');

  const key = proxyKey(filePath, stat);
  const target = proxyPathFor(cacheDir, key);
  const existing = await statSafe(target);
  if (existing && existing.size > 0) return { path: target, cached: true, width: opts.width || 1280 };

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const bin = resolveFfmpeg(opts.resourcesDir, opts.ffmpegPath);
  const tmp = `${target}.${process.pid}.part.mp4`;
  const duration = Number(opts.duration) || 0;
  const width = Math.max(320, Math.min(1920, Number(opts.width) || 1280));

  const attempt = (args) =>
    new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {
        const err = new Error(`${path.basename(bin)} could not be started.`);
        err.code = 'ENGINE_MISSING';
        reject(err);
        return;
      }
      const errTail = [];
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (opts.token) opts.token.child = null;
        fn(value);
      };
      if (opts.token) {
        opts.token.child = child;
        opts.token.kill = () => {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        };
      }
      child.stdout.on('data', (chunk) => {
        if (!opts.onProgress) return;
        const ratio = parseProgressChunk(chunk.toString('utf8'), duration);
        if (ratio !== null) opts.onProgress(ratio);
      });
      child.stderr.on('data', (chunk) => {
        if (errTail.length < 30) errTail.push(chunk.toString('utf8'));
      });
      child.on('error', (err) => {
        const e = new Error(`${path.basename(bin)} was not found or could not be started.`);
        e.code = 'ENGINE_MISSING';
        finish(reject, e);
      });
      child.on('close', (code) => {
        if (opts.token && opts.token.cancelled) {
          const e = new Error('Preview cancelled.');
          e.code = 'ABORT_ERR';
          finish(reject, e);
          return;
        }
        if (code === 0) finish(resolve, true);
        else {
          const detail = errTail.join(' ').trim().split(/\r?\n/).filter(Boolean).pop() || `ffmpeg exited with code ${code}.`;
          finish(reject, Object.assign(new Error(detail), { code: 'PROXY_FAILED' }));
        }
      });
    });

  try {
    try {
      await attempt(proxyArgs(filePath, tmp, width));
    } catch (err) {
      // A build without libx264 (LGPL-only ffmpeg) still gets a proxy: MPEG-4
      // part 2 plays in Chromium as well, it is just a little bigger.
      if (err && err.code === 'PROXY_FAILED') {
        const fallbackArgs = proxyArgs(filePath, tmp, width).map((a) => a);
        const vi = fallbackArgs.indexOf('libx264');
        if (vi > 0) {
          fallbackArgs[vi] = 'mpeg4';
          const ci = fallbackArgs.indexOf('-crf');
          if (ci > 0) {
            fallbackArgs[ci] = '-q:v';
            fallbackArgs[ci + 1] = '5';
          }
          await attempt(fallbackArgs);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const built = await statSafe(tmp);
    if (!built || built.size === 0) throw new Error('The preview could not be prepared.');
    await fsp.rename(tmp, target);
    return { path: target, cached: false, width };
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch (_) {}
    if (!err.code) err.code = 'PROXY_FAILED';
    throw err;
  }
}

/** Deletes every cached proxy (Settings → Clear caches). */
async function clearProxies(cacheDir) {
  try {
    await fsp.rm(proxyDirFor(cacheDir), { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

/** Collects cache files (thumbnails live one level deep, proxies two). */
async function collectCacheFiles(dir, depth = 2) {
  const files = [];
  const walk = async (current, level) => {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (level > 0) await walk(full, level - 1);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await statSafe(full);
      if (st) files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  await walk(dir, depth);
  return files;
}

/**
 * Keeps the cache under control by deleting the oldest files first.
 *
 * Thumbnails are tiny, preview proxies are not (a 1280 px proxy of a long clip
 * is tens of megabytes), so they get their own, larger budget.
 */
async function pruneThumbnailCache(cacheDir, maxBytes = 600 * 1024 * 1024, proxyBytes = 2 * 1024 * 1024 * 1024) {
  const all = await collectCacheFiles(cacheDir, 2);
  if (!all.length) return { removed: 0, freed: 0 };

  const proxyRoot = proxyDirFor(cacheDir);
  const thumbs = all.filter((f) => !paths_isInside(proxyRoot, f.full));
  const proxies = all.filter((f) => paths_isInside(proxyRoot, f.full));

  let removed = 0;
  let freed = 0;
  for (const bucket of [
    { files: proxies, budget: proxyBytes },
    { files: thumbs, budget: maxBytes },
  ]) {
    let total = bucket.files.reduce((a, f) => a + f.size, 0);
    if (total <= bucket.budget) continue;
    bucket.files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of bucket.files) {
      if (total <= bucket.budget * 0.85) break;
      try {
        await fsp.unlink(f.full);
        total -= f.size;
        freed += f.size;
        removed += 1;
      } catch (_) {}
    }
  }
  return { removed, freed };
}

/** Clears the whole thumbnail cache (Settings → Maintenance). */
async function clearThumbnailCache(cacheDir) {
  try {
    await fsp.rm(proxyDirFor(cacheDir), { recursive: true, force: true });
    await fsp.rm(cacheDir, { recursive: true, force: true });
    await fsp.mkdir(cacheDir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Quick health check used by Settings → "Check FFmpeg". */
async function checkEngines(resourcesDir, options = {}) {
  const result = { ffmpeg: { ok: false, path: '', version: '' }, ffprobe: { ok: false, path: '', version: '' } };
  try {
    const bin = resolveFfmpeg(resourcesDir, options.ffmpegPath);
    const { stdout } = await run(bin, ['-version'], { timeout: 15000 });
    result.ffmpeg = { ok: true, path: bin, version: (stdout.split('\n')[0] || '').trim() };
  } catch (err) {
    result.ffmpeg = { ok: false, path: resolveFfmpeg(resourcesDir, options.ffmpegPath), version: '', error: err.message };
  }
  try {
    const bin = resolveFfprobe(resourcesDir, options.ffprobePath);
    const { stdout } = await run(bin, ['-version'], { timeout: 15000 });
    result.ffprobe = { ok: true, path: bin, version: (stdout.split('\n')[0] || '').trim() };
  } catch (err) {
    result.ffprobe = { ok: false, path: resolveFfprobe(resourcesDir, options.ffprobePath), version: '', error: err.message };
  }
  return result;
}

module.exports = {
  setExtraEngineDirs,
  ensureProxy,
  proxyKey,
  proxyPathFor,
  clearProxies,
  resolveFfmpeg,
  resolveFfprobe,
  resetEngineCache,
  probeFile,
  ensureThumbnail,
  pruneThumbnailCache,
  clearThumbnailCache,
  checkEngines,
  parseRate,
  extractTimecode,
  formatDuration,
  thumbKey,
  thumbPathFor,
};
