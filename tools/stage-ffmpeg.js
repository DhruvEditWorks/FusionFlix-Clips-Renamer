#!/usr/bin/env node
/**
 * Staging script for the Windows build (run automatically by `npm run sync`,
 * which every build/test script depends on).
 *
 * It copies the *Windows* FFmpeg binaries into ./ffmpeg so that
 * electron-builder ships them inside the installer:
 *
 *   ffmpeg/ffmpeg.exe    full FFmpeg  — real thumbnails, the generated sample
 *                         project, and the “install dependencies” upgrade path
 *   ffmpeg/ffprobe.exe   FFprobe     — durations, resolution, fps, timecode
 *
 * Sources, in order:
 *   1. ffmpeg/ already contains the binaries (a manual drop-in wins)
 *   2. node_modules/ffmpeg-static  + node_modules/ffprobe-static (win32-x64)
 *
 * Nothing here is ever copied on a non-Windows dev machine: those builds keep
 * using the platform binaries from the npm packages, exactly as before.
 *
 *        node tools/stage-ffmpeg.js [--check|--clean]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'ffmpeg');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const CLEAN = args.includes('--clean');
// The 80 MB FFmpeg binary is opt-in: it keeps the installer near 90 MB instead
// of 180 MB, and users get it from the installer's dependency step (or
// Settings → Media engine) when they want it. Enable with either flag:
//     npm run build:win -- --with-ffmpeg
//     FF_SHIP_FULL_ENGINE=1 npm run build:win
const SHIP_FULL_ENGINE =
  args.includes('--with-ffmpeg') || process.env.FF_SHIP_FULL_ENGINE === '1' || process.env.npm_config_with_ffmpeg === 'true';

/** Binary names we stage (and the labels used in the log). */
const BINARIES = [
  {
    name: 'ffmpeg.exe',
    label: 'FFmpeg',
    optional: true,
    sources: [
      path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
      path.join(ROOT, 'node_modules', 'ffmpeg-static', 'bin', 'win32', 'x64', 'ffmpeg.exe'),
    ],
  },
  {
    name: 'ffprobe.exe',
    label: 'FFprobe',
    sources: [
      path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
      path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'ia32', 'ffprobe.exe'),
    ],
  },
];

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function human(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

function firstSource(list) {
  for (const candidate of list) {
    const st = statSafe(candidate);
    if (st && st.isFile() && st.size > 1024 * 512) return candidate;
  }
  return null;
}

function main() {
  fs.mkdirSync(DEST, { recursive: true });

  if (CLEAN) {
    for (const bin of BINARIES) {
      const target = path.join(DEST, bin.name);
      if (statSafe(target)) {
        fs.unlinkSync(target);
        process.stdout.write(`stage-ffmpeg: removed ffmpeg/${bin.name}\n`);
      }
    }
    return;
  }

  const staged = [];
  const missing = [];

  for (const bin of BINARIES) {
    const target = path.join(DEST, bin.name);
    const existing = statSafe(target);
    // A manually dropped-in binary always wins, even for the optional one.
    const wanted = !bin.optional || SHIP_FULL_ENGINE || Boolean(existing);
    if (!wanted) {
      process.stdout.write(
        `stage-ffmpeg: not staging ffmpeg/${bin.name} (optional — use --with-ffmpeg or FF_SHIP_FULL_ENGINE=1 ` +
          'to bundle the full engine in the installer)\n'
      );
      continue;
    }
    if (!existing) {
      const source = firstSource(bin.sources);
      if (!source) {
        missing.push(bin);
        continue;
      }
      if (CHECK_ONLY) {
        process.stdout.write(`stage-ffmpeg: [would copy] ${bin.name} ← ${path.relative(ROOT, source)}\n`);
        staged.push(bin.name);
        continue;
      }
      fs.copyFileSync(source, target);
      try {
        fs.chmodSync(target, 0o755);
      } catch (_) {}
      process.stdout.write(
        `stage-ffmpeg: staged ffmpeg/${bin.name} (${human(fs.statSync(target).size)}) ← ${path.relative(ROOT, source)}\n`
      );
    } else {
      process.stdout.write(`stage-ffmpeg: ffmpeg/${bin.name} already present (${human(existing.size)})\n`);
    }
    staged.push(bin.name);
  }

  if (missing.length) {
    process.stdout.write(
      `stage-ffmpeg: warning — no Windows ${missing.map((m) => m.name).join(' / ')} available ` +
        '(the installer will still work: users can download the engine from Settings, and the ' +
        'installer offers the FFmpeg dependency download).\n'
    );
  }
}

main();
