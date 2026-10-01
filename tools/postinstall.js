/**
 * Post-install helper.
 *
 * It only reports what it found — it never fails the install. If the FFmpeg
 * npm packages could not be downloaded (offline machine), simply drop
 * ffmpeg.exe and ffprobe.exe into the ./ffmpeg folder of this project and the
 * app will use those instead.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

const root = path.join(__dirname, '..');
const lines = [];
lines.push('');
lines.push('  Fusion Flix Clip Renamer & Sorter — dependency check');
lines.push('  ---------------------------------------------------');

let ffmpegOk = exists(path.join(root, 'ffmpeg', 'ffmpeg.exe')) || exists(path.join(root, 'ffmpeg', 'ffmpeg'));
let ffprobeOk = exists(path.join(root, 'ffmpeg', 'ffprobe.exe')) || exists(path.join(root, 'ffmpeg', 'ffprobe'));

if (ffmpegOk && ffprobeOk) {
  lines.push('  [ok]   FFmpeg found in ./ffmpeg (bundled, fully offline)');
} else {
  const staticPath = path.join(root, 'node_modules', 'ffmpeg-static');
  const probePath = path.join(root, 'node_modules', 'ffprobe-static');
  if (exists(staticPath)) lines.push('  [ok]   ffmpeg-static package installed');
  else lines.push('  [warn] ffmpeg-static not installed — put ffmpeg.exe in ./ffmpeg');

  if (exists(probePath)) lines.push('  [ok]   ffprobe-static package installed');
  else lines.push('  [warn] ffprobe-static not installed — put ffprobe.exe in ./ffmpeg');
}

const electronOk = exists(path.join(root, 'node_modules', 'electron'));
lines.push(electronOk ? '  [ok]   Electron installed' : '  [warn] Electron missing — run: npm install');

lines.push('');
lines.push('  Next steps:');
lines.push('    npm start        run the app in development');
lines.push('    npm run dev      run with DevTools');
lines.push('    npm run build:win  create the Windows Setup.exe in ./dist');
lines.push('');
lines.push('  A free to use tool by Fusion Flix (Dhruv Sharma)');
lines.push('');

process.stdout.write(lines.join('\n'));
process.exit(0);
