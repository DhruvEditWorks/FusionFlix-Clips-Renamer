'use strict';
/**
 * FUSION FLIX — sample (demo) mode.
 *
 * Generates a handful of tiny synthetic clips with FFmpeg so the interface can
 * be explored without importing real footage. Nothing is downloaded and no
 * third-party media is embedded — the clips are pattern generators produced
 * locally on the user's own machine.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { resolveFfmpeg, ensureThumbnail } = require('./media');

/**
 * Tiny pre-rendered sample clips that ship with the application. They are
 * generated from FFmpeg's own pattern sources (no third-party footage) and are
 * only used when FFmpeg is not available to build the samples on the fly.
 */
const BUNDLED_SAMPLE_DIR = path.join(__dirname, '..', 'assets', 'sample-clips');
const BUNDLED_SAMPLES = [
  { file: '01_city_broll.mp4', label: 'City B-Roll', seconds: 4 },
  { file: '02_drone_pass.mp4', label: 'Drone Pass', seconds: 4 },
  { file: '03_interview_a.mp4', label: 'Interview A', seconds: 4 },
  { file: '04_practical_lights.mp4', label: 'Practical Lights', seconds: 4 },
];

/** True when the bundled placeholder clips are present in the build. */
function hasBundledSamples() {
  try {
    return BUNDLED_SAMPLES.every((clip) => fs.existsSync(path.join(BUNDLED_SAMPLE_DIR, clip.file)));
  } catch (_) {
    return false;
  }
}

/**
 * Copies the bundled placeholder clips into the sample project folder.
 * Used as a fallback so "Load Sample Project" always works, even on a machine
 * with no FFmpeg installed.
 */
async function copyBundledSamples(userDataDir) {
  const dir = sampleDir(userDataDir);
  await fsp.mkdir(dir, { recursive: true });
  const files = [];
  for (const clip of BUNDLED_SAMPLES) {
    const source = path.join(BUNDLED_SAMPLE_DIR, clip.file);
    const target = path.join(dir, clip.file);
    files.push(target);
    let stat = null;
    try {
      stat = await fsp.stat(target);
    } catch (_) {
      stat = null;
    }
    if (!stat || stat.size === 0) {
      await fsp.copyFile(source, target);
    }
  }
  return { files, dir, bundled: true };
}

/** name, source filter, size, fps, seconds */
const SAMPLE_CLIPS = [
  { name: '01_city_broll', filter: 'testsrc2=size=1280x720:rate=30', label: 'City B-Roll', seconds: 6 },
  { name: '02_drone_pass', filter: 'testsrc=size=1920x1080:rate=25', label: 'Drone Pass', seconds: 5 },
  { name: '03_interview_a', filter: 'smptebars=size=1280x720:rate=30', label: 'Interview A', seconds: 8 },
  { name: '04_interview_b', filter: 'rgbtestsrc=size=1280x720:rate=30', label: 'Interview B', seconds: 5 },
  { name: '05_cu_hands', filter: 'yuvtestsrc=size=854x480:rate=24', label: 'CU Hands', seconds: 4 },
  { name: '06_wide_establish', filter: 'testsrc2=size=1920x1080:rate=24', label: 'Wide Establishing', seconds: 7 },
  { name: '07_detail_macro', filter: 'cellauto=size=640x360:rate=30', label: 'Detail Macro', seconds: 3 },
  { name: '08_closing_shot', filter: 'testsrc2=size=1280x720:rate=30', label: 'Closing Shot', seconds: 6 },
];

function sampleDir(userDataDir) {
  return path.join(userDataDir, 'Sample Project', 'footage');
}

/** True when the sample clips already exist (they are generated once). */
function sampleExists(userDataDir) {
  const dir = sampleDir(userDataDir);
  if (!hasBundledSamples()) {
    return SAMPLE_CLIPS.every((c) => {
      try {
        return fs.existsSync(path.join(dir, `${c.name}.mp4`));
      } catch (_) {
        return false;
      }
    });
  }
  return BUNDLED_SAMPLES.every((c) => {
    try {
      return fs.existsSync(path.join(dir, `${c.name}.mp4`));
    } catch (_) {
      return false;
    }
  });
}

function drawTextFilter(label) {
  const safe = String(label).replace(/[:'\\]/g, '');
  return `drawtext=text='${safe}':fontcolor=white:fontsize=h/9:x=(w-text_w)/2:y=h-text_h-24:box=1:boxcolor=black@0.45:boxborderw=12`;
}

function spawnFfmpeg(bin, args, timeoutMs) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      reject(new Error('Generating the sample clip took too long.'));
    }, timeoutMs || 90000);
    child.stderr.on('data', (d) => {
      if (err.length < 2000) err += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      const err = new Error('FFmpeg was not found, so the sample clips could not be created.');
      err.code = 'ENGINE_MISSING';
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else reject(new Error(`FFmpeg could not create a sample clip (exit ${code}).`));
    });
  });
}

/**
 * Builds the sample footage. Returns { files: string[], dir }.
 * `onProgress(done, total, label)` is called as clips finish.
 */
async function generateSampleClips(userDataDir, onProgress, resourcesDir, engineOptions) {
  const dir = sampleDir(userDataDir);
  await fsp.mkdir(dir, { recursive: true });
  const opts = engineOptions || {};
  const bin = resolveFfmpeg(resourcesDir, opts.ffmpegPath);

  const files = [];

  try {
  for (let i = 0; i < SAMPLE_CLIPS.length; i++) {
    const clip = SAMPLE_CLIPS[i];
    const target = path.join(dir, `${clip.name}.mp4`);
    files.push(target);
    if (onProgress) onProgress(i, SAMPLE_CLIPS.length, clip.name);
    let st = null;
    try {
      st = await fsp.stat(target);
    } catch (_) {
      st = null;
    }
    if (st && st.size > 1024) continue; // reuse what is already there

    const base = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', clip.filter,
      '-t', String(clip.seconds),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '30',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
    ];

    // Try with a title burned in; if this FFmpeg has no drawtext support,
    // fall back to the plain pattern so the demo still works.
    try {
      await spawnFfmpeg(bin, [...base, '-vf', drawTextFilter(clip.label), '-y', target]);
    } catch (_) {
      try {
        await fsp.unlink(target);
      } catch (_) {}
      await spawnFfmpeg(bin, [...base, '-y', target]);
    }
  }

  } catch (err) {
    if (err && (err.code === 'ENGINE_MISSING' || /was not found/i.test(err.message || ''))) {
      // No working FFmpeg anywhere — use the placeholder clips that ship with
      // the application so the sample project still opens.
      await fsp.rm(dir, { recursive: true, force: true });
      const fallback = await copyBundledSamples(userDataDir);
      if (onProgress) onProgress(BUNDLED_SAMPLES.length, BUNDLED_SAMPLES.length, 'bundled placeholders');
      return fallback;
    }
    throw err;
  }

  if (onProgress) onProgress(SAMPLE_CLIPS.length, SAMPLE_CLIPS.length, 'done');
  return { files, dir };
}

/** Whether the sample project has been created before (used to tidy the UI). */
function demoDefaults() {
  return SAMPLE_CLIPS.map((c) => ({ name: c.name, label: c.label, seconds: c.seconds }));
}

module.exports = {
  SAMPLE_CLIPS,
  SAMPLE_CLIPS_FALLBACK: BUNDLED_SAMPLES,
  sampleDir,
  sampleExists,
  generateSampleClips,
  copyBundledSamples,
  hasBundledSamples,
  demoDefaults,
  ensureThumbnail,
};
