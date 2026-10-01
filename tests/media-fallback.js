#!/usr/bin/env node
/**
 * Verifies the built-in fallback used when FFmpeg is not installed:
 *   • clips still import (metadata degrades gracefully)
 *   • thumbnails are then produced by the renderer's own canvas capture
 * Run: xvfb-run -a npx electron tests/media-fallback.js
 */
process.env.FF_E2E = '1';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-nofm-'));
app.setPath('userData', path.join(tmp, 'userData'));
app.commandLine.appendSwitch('disable-gpu');
require('../main.js');

const checks = []; const log = (...a) => process.stdout.write(a.join(' ') + '\n');
/** The ffmpeg used to *make* the test clip — the bundled static build, never PATH. */
const ffmpegBin = (() => {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return 'ffmpeg';
})();
// A suite that cannot finish must fail loudly instead of hanging forever.
let restore = () => {};
const watchdog = setTimeout(() => {
  log('\n  TIMEOUT — the fallback suite did not finish within 5 minutes');
  restore();
  app.exit(1);
}, 300000);
process.on('unhandledRejection', (err) => {
  log('\n  UNHANDLED: ' + String((err && err.message) || err));
  restore();
  app.exit(1);
});
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); };
const waitFor = async (fn, t = 45000) => { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > t) return null; await new Promise((r) => setTimeout(r, 300)); } };

(async () => {
  await app.whenReady();
  const win = await waitFor(() => { const w = BrowserWindow.getAllWindows()[0]; return w && !w.webContents.isLoading() ? w : null; });
  const wc = win.webContents;
  wc.on('console-message', (e, l, m) => { if (l >= 3) log('  [renderer error] ' + String(m).slice(0, 200)); });
  const js = (code) => wc.executeJavaScript(code, true);

  // a real clip, made before the engine disappears
  const footage = path.join(tmp, 'footage');
  fs.mkdirSync(footage, { recursive: true });
  const clipPath = path.join(footage, 'handheld_take_01.mp4');
  execFileSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clipPath]);

  // hide every ffmpeg/ffprobe the app could auto-detect
  const hidden = [];
  const candidates = ['node_modules/ffmpeg-static/ffmpeg', 'node_modules/ffprobe-static/bin/linux/x64/ffprobe', 'node_modules/ffmpeg-static/ffmpeg.exe'];
  for (const rel of candidates) {
    const full = path.join(__dirname, '..', rel);
    if (fs.existsSync(full)) { fs.renameSync(full, full + '.hidden'); hidden.push(full); }
  }
  restore = () => hidden.forEach((f) => { if (fs.existsSync(f + '.hidden')) fs.renameSync(f + '.hidden', f); });
  process.on('exit', restore);
  log(`  (hid ${hidden.length} bundled binaries; PATH ffmpeg is also ignored by the resolver)`);

  await waitFor(() => js('window.FFApp && window.FFApp.ready === true'));
  const engines = await js('window.FF.settings.checkEngines()');
  check('the app reports FFmpeg as unavailable', engines.ffmpeg.ok === false, JSON.stringify(engines.ffmpeg));

  const result = await js(`window.FF.importClips.run({ paths: [${JSON.stringify(clipPath)}] })`);
  check('a clip still imports without FFmpeg', !!(result && result.ok && result.clips && result.clips.length === 1), JSON.stringify(result && result.error));
  const clipId = result.clips[0].id;
  check('the fallback timecode is used (never random)', /^\d{2}-\d{2}-\d{2}$/.test(result.clips[0].timeText), result.clips[0].timeText);

  // place it in a project through the renderer, then ask for a thumbnail
  await js(`(() => {
    const project = window.FFApp.emptyProject('No FFmpeg');
    project.clips = ${JSON.stringify(result.clips)};
    window.FFApp.setProject(project, '', { markClean: true });
    window.FFApp.state.thumbRequested.clear();
    window.FFApp.state.thumbs.clear();
    return true;
  })()`);

  const thumbResponse = await js(`window.FF.media.thumbnail({ id: ${JSON.stringify(clipId)}, sourcePath: ${JSON.stringify(clipPath)}, duration: 0 })`);
  check('the main process asks the renderer to take over', thumbResponse && thumbResponse.fallback === 'renderer', JSON.stringify(thumbResponse));

  const captured = await waitFor(() => js(`window.FFApp.state.thumbs.get(${JSON.stringify(clipId)}) || null`), 40000);
  check('the renderer produced a thumbnail itself', typeof captured === 'string' && captured.startsWith('data:image/jpeg'), String(captured).slice(0, 40));

  const visible = await waitFor(() => js("Boolean(document.querySelector('#clipListInner .clip-row img[src^=\"data:image/jpeg\"]'))"), 20000);
  check('the thumbnail appears in the clip browser', Boolean(visible));

  const tagging = await js(`(() => { window.FFApp.selectClip(${JSON.stringify(clipId)}); return FFLib.finalFileName(window.FFApp.state.project.clips[0]); })()`);
  check('an imported clip is tagged by default even with no engine', /^S-1_SH-1_T-1_\(1-1-1\)\.mp4$/.test(tagging), tagging);
  const untagged = await js(`(() => {
    const c = window.FFApp.state.project.clips[0];
    c.sceneOn = false; c.shotOn = false; c.takeOn = false;
    c.scene = null; c.shot = null; c.take = null;
    return FFLib.finalFileName(c);
  })()`);
  check('with the tags switched off the original name is kept (plus the tags)', /^handheld_take_01_\(0-0-0\)\.mp4$/.test(untagged), untagged);

  const passed = checks.filter((c) => c.ok).length;
  log(`\n  ${passed}/${checks.length} fallback checks passed`);
  restore();
  clearTimeout(watchdog);
  await new Promise((r) => setTimeout(r, 200));
  app.exit(passed === checks.length ? 0 : 1);
})();
