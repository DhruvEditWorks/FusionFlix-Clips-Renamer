#!/usr/bin/env node
/**
 * Verifies the contents of the packaged app.asar (or any asar given as argv[2]).
 * Usage: node tools/check-asar.js [path/to/app.asar]
 *
 * Confirms that every file the app needs at runtime made it into the package —
 * a missing renderer file is the classic cause of a white window in production.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let asar;
try {
  // eslint-disable-next-line global-require
  asar = require('@electron/asar');
} catch (_) {
  try {
    // eslint-disable-next-line global-require
    asar = require('asar');
  } catch (_) {
    process.stdout.write('check-asar: @electron/asar is not installed — skipping (run npm install).\n');
    process.exit(0);
  }
}

const target = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(target)) {
  process.stdout.write(`check-asar: ${target} not found — nothing to check.\n`);
  process.exit(0);
}

const REQUIRED = [
  '/main.js',
  '/preload.js',
  '/package.json',
  '/lib/ipc.js',
  '/lib/settings.js',
  '/lib/media.js',
  '/lib/exporter.js',
  '/lib/renamer.js',
  '/lib/engine-download.js',
  '/lib/project.js',
  '/lib/demo.js',
  '/lib/filenames.js',
  '/lib/validate.js',
  '/lib/sanitize.js',
  '/lib/paths.js',
  '/renderer/index.html',
  '/renderer/style.css',
  '/renderer/app.js',
  '/renderer/ui.js',
  '/renderer/panels.js',
  '/renderer/lib/filenames.js',
  '/renderer/lib/shortcuts.js',
  '/renderer/lib/validate.js',
  '/renderer/lib/sanitize.js',
  '/assets/icon-data.js',
  '/icons/icon.ico',
];

const entries = asar.listPackage(target).map((p) => p.replace(/\\/g, '/'));
const set = new Set(entries.map((p) => (p.startsWith('/') ? p : `/${p}`)));

const missing = REQUIRED.filter((file) => !set.has(file));
const unpacked = path.join(path.dirname(target), 'app.asar.unpacked');

process.stdout.write(`check-asar: ${entries.length} entries in ${path.basename(target)}\n`);
if (missing.length) {
  process.stdout.write(`  MISSING: ${missing.join(', ')}\n`);
} else {
  process.stdout.write(`  ok  ${REQUIRED.length} required runtime files present\n`);
}

// FFmpeg: either unpacked next to the asar, or in resources/ffmpeg
const resourcesDir = path.dirname(target);
const ffmpegLocations = [
  path.join(unpacked, 'node_modules', 'ffmpeg-static'),
  path.join(unpacked, 'node_modules', 'ffprobe-static'),
  path.join(resourcesDir, 'ffmpeg'),
];
let found = false;
for (const dir of ffmpegLocations) {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /ff(mpeg|probe)(\.exe)?$/i.test(String(f)));
    if (files.length) {
      found = true;
      process.stdout.write(`  ok  media engine binaries found in ${path.relative(process.cwd(), dir)} (${files.length})\n`);
    }
  }
}
if (!found) {
  process.stdout.write('  warn  no ffmpeg/ffprobe binaries found in the package — the app will look for them on PATH\n');
}

process.exit(missing.length ? 1 : 0);
