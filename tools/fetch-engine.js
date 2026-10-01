#!/usr/bin/env node
'use strict';
/**
 * FUSION FLIX — install-time media-engine download.
 *
 * Called by the Windows installer (see packaging/installer.nsh) when the user
 * ticks "download the media engine now". It installs FFmpeg into the freshly
 * copied application folder so the app has the full engine from the first run.
 *
 * Usage:
 *   node tools/fetch-engine.js "<install dir>" [--silent]
 *
 * It never lets a failed download fail the installation: the app runs fine
 * without FFmpeg (FFprobe is bundled, thumbnails fall back to in-app capture).
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const target = args[0] || process.cwd();
const resourcesDir = /resources$/i.test(target) ? target : path.join(target, 'resources');
const ffmpegDir = path.join(resourcesDir, 'ffmpeg');

async function main() {
  let downloader;
  try {
    downloader = require('../lib/engine-download');
  } catch (err) {
    process.stdout.write(`[fusion-flix] downloader unavailable: ${err.message}\n`);
    return 0;
  }

  if (process.platform !== 'win32') {
    process.stdout.write('[fusion-flix] media-engine download is only offered on Windows.\n');
    return 0;
  }

  process.stdout.write('[fusion-flix] downloading FFmpeg (this can take a minute)…\n');
  let lastPercent = -5;
  try {
    const res = await downloader.installEngine({
      targetDir: ffmpegDir,
      onProgress: (p) => {
        const percent = Math.round(Number(p.percent) || 0);
        if (percent >= lastPercent + 5) {
          lastPercent = percent;
          process.stdout.write(`[fusion-flix] ${percent}% — ${p.message || ''}\n`);
        }
      },
    });
    process.stdout.write(`[fusion-flix] FFmpeg installed into ${ffmpegDir}\n`);
    for (const [key, value] of Object.entries(res.installed || {})) {
      process.stdout.write(`[fusion-flix]   ${key}: ${value}\n`);
    }
    return 0;
  } catch (err) {
    process.stdout.write(`[fusion-flix] FFmpeg was not installed: ${(err && err.message) || err}\n`);
    process.stdout.write('[fusion-flix] The app still works — you can download it later from Settings → Media engine.\n');
    // Never fail the installation over an optional component.
    return 0;
  }
}

main().then((code) => {
  process.exit(code);
});
