'use strict';
/**
 * FUSION FLIX — optional media-engine downloader.
 *
 * The installed app already works without FFmpeg (FFprobe is bundled and the
 * renderer can grab its own thumbnails), but a few users want the full engine.
 * This module downloads the official Windows build of FFmpeg and drops
 * ffmpeg.exe / ffprobe.exe into the application's own `ffmpeg` folder.
 *
 * It is used twice:
 *   • by the installer (packaging/installer.nsh asks "download FFmpeg now?"),
 *     which calls it through `node tools/fetch-engine.js`
 *   • by the running app (Settings → Media engine → Download FFmpeg), which
 *     goes through IPC and reports real progress
 *
 * Safety:
 *   • only https, only the hosts on the allow-list, redirects are followed but
 *     re-checked against that list
 *   • the download goes to a temp file first and is verified to be a zip (PK)
 *   • extraction happens into a temp folder; only ffmpeg.exe / ffprobe.exe are
 *     moved into place, nothing else is written into the install directory
 *   • the whole thing can be cancelled; a cancelled or failed download never
 *     leaves a half-installed engine behind
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

/** Windows builds. Both are plain zips containing bin/ffmpeg.exe + ffprobe.exe. */
const ENGINE_SOURCES = Object.freeze([
  {
    name: 'gyan.dev (essentials build)',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    approxBytes: 35 * 1024 * 1024,
  },
  {
    name: 'GitHub — BtbN FFmpeg-Builds',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    approxBytes: 90 * 1024 * 1024,
  },
]);

const ALLOWED_HOSTS = new Set([
  'www.gyan.dev',
  'gyan.dev',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

const MAX_REDIRECTS = 6;

/**
 * @param {string} url
 * @param {object} [options] { allowedHosts?: string[], allowHttp?: boolean }
 *   The defaults are the shipping ones (https only, official mirrors only).
 *   The overrides exist so the downloader can be pointed at a local server in
 *   tests, or at an internal mirror by a future build.
 */
function hostAllowed(url, options = {}) {
  const hosts = Array.isArray(options.allowedHosts) && options.allowedHosts.length ? options.allowedHosts : ALLOWED_HOSTS;
  const allowHttp = Boolean(options.allowHttp);
  try {
    const parsed = new URL(url);
    const schemeOk = parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:');
    if (!schemeOk) return false;
    return hosts === ALLOWED_HOSTS ? ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) : hosts.includes(parsed.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/**
 * Streams a URL to a file, reporting progress.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} options { onProgress({received,total,percent}), signal, redirects }
 */
function downloadFile(url, destPath, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const signal = options.signal;
  const redirects = options.redirects || 0;

  return new Promise((resolve, reject) => {
    if (!hostAllowed(url, options)) {
      reject(Object.assign(new Error(`Refusing to download from ${url}`), { code: 'URL_NOT_ALLOWED' }));
      return;
    }
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      return;
    }
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(
      url,
      { headers: { 'User-Agent': 'FusionFlixClipRenamer/1.3 (offline desktop tool)', Accept: 'application/zip,*/*' } },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(Object.assign(new Error('Too many redirects'), { code: 'TOO_MANY_REDIRECTS' }));
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          downloadFile(next, destPath, { ...options, redirects: redirects + 1 }).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(Object.assign(new Error(`The download server answered ${status}.`), { code: 'HTTP_ERROR', status }));
          return;
        }

        const total = Number(response.headers['content-length']) || 0;
        let received = 0;
        const out = fs.createWriteStream(destPath);
        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          try { out.destroy(); } catch (_) {}
          reject(err);
        };
        const abort = () => {
          try { request.destroy(); } catch (_) {}
          fail(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
        };
        if (signal) signal.addEventListener('abort', abort, { once: true });

        response.on('data', (chunk) => {
          received += chunk.length;
          onProgress({
            received,
            total,
            percent: total ? Math.min(99.9, Math.round((received / total) * 1000) / 10) : 0,
          });
        });
        response.on('error', fail);
        out.on('error', fail);
        out.on('close', () => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', abort);
          onProgress({ received, total: total || received, percent: 100 });
          resolve({ path: destPath, bytes: received });
        });
        response.pipe(out);
      }
    );
    request.on('error', (err) => {
      reject(Object.assign(new Error(`Could not reach the download server (${err.code || err.message}).`), { code: 'NETWORK', cause: err }));
    });
  });
}

/** Looks for ffmpeg.exe / ffprobe.exe anywhere inside an extracted tree. */
async function findBinaries(root) {
  const found = { ffmpeg: '', ffprobe: '' };
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    let items = [];
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        queue.push(full);
        continue;
      }
      const lower = item.name.toLowerCase();
      if (lower === 'ffmpeg.exe' && !found.ffmpeg) found.ffmpeg = full;
      else if (lower === 'ffprobe.exe' && !found.ffprobe) found.ffprobe = full;
    }
    if (found.ffmpeg && found.ffprobe) break;
  }
  return found;
}

/** A tiny sanity check that we really downloaded a zip and not an error page. */
async function looksLikeZip(filePath) {
  try {
    const handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(2);
    await handle.read(buffer, 0, 2, 0);
    await handle.close();
    return buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  } catch (_) {
    return false;
  }
}

async function extractZip(zipPath, destination) {
  // extract-zip is a small, well-tested package (no native code).
  let extract;
  try {
    extract = require('extract-zip');
  } catch (_) {
    throw Object.assign(new Error('The zip extractor is missing from this installation.'), { code: 'NO_EXTRACTOR' });
  }
  await extract(zipPath, { dir: path.resolve(destination) });
}

/**
 * Downloads a zip from `url` and installs ffmpeg.exe / ffprobe.exe into
 * `targetDir`.
 *
 * @param {object} options
 *   url?, targetDir, onProgress({stage,percent,message,received,total}), signal
 */
async function installEngine(options = {}) {
  const targetDir = options.targetDir;
  if (!targetDir) throw Object.assign(new Error('No target folder for the media engine.'), { code: 'NO_TARGET' });
  const onProgress = options.onProgress || (() => {});
  const signal = options.signal;
  // `sources` is the mirror-override hook (tests, or an internal mirror); the
  // shipping list is only ever replaced deliberately, never by accident.
  const sources = Array.isArray(options.sources) && options.sources.length
    ? options.sources
    : options.url
      ? [{ name: 'custom', url: options.url }]
      : ENGINE_SOURCES;
  // Test/mirror overrides travel with the request (never enabled by default).
  const hostOptions = { allowedHosts: options.allowedHosts, allowHttp: options.allowHttp };

  await fsp.mkdir(targetDir, { recursive: true });
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-engine-'));
  const zipPath = path.join(workDir, 'ffmpeg.zip');
  const extractDir = path.join(workDir, 'unpacked');

  let lastError = null;
  for (const source of sources) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    try {
      onProgress({ stage: 'downloading', percent: 0, message: `Downloading FFmpeg — ${source.name}…`, source: source.name, url: source.url });
      await downloadFile(source.url, zipPath, {
        ...hostOptions,
        signal,
        onProgress: (p) =>
          onProgress({
            stage: 'downloading',
            percent: p.percent * 0.9, // the last 10% is extraction + install
            message: `Downloading FFmpeg — ${source.name}…`,
            received: p.received,
            total: p.total,
            source: source.name,
            url: source.url,
          }),
      });
      if (!(await looksLikeZip(zipPath))) {
        throw Object.assign(new Error('The downloaded file is not a zip archive.'), { code: 'NOT_A_ZIP' });
      }
      onProgress({ stage: 'extracting', percent: 91, message: 'Unpacking the engine…' });
      await fsp.mkdir(extractDir, { recursive: true });
      await extractZip(zipPath, extractDir);

      const bins = await findBinaries(extractDir);
      if (!bins.ffmpeg) {
        throw Object.assign(new Error('The archive did not contain ffmpeg.exe.'), { code: 'NO_BINARY' });
      }
      onProgress({ stage: 'installing', percent: 96, message: 'Installing the engine…' });
      const installed = {};
      for (const [key, from] of Object.entries(bins)) {
        if (!from) continue;
        const to = path.join(targetDir, path.basename(from));
        await fsp.rm(to, { force: true });
        await fsp.copyFile(from, to);
        await fsp.chmod(to, 0o755).catch(() => {});
        installed[key] = to;
      }
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      onProgress({ stage: 'done', percent: 100, message: 'FFmpeg installed.', installed });
      return { ok: true, installed, source: source.name };
    } catch (err) {
      lastError = err;
      if (err && err.code === 'CANCELLED') break;
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  if (lastError && lastError.code === 'CANCELLED') throw Object.assign(new Error('Download cancelled.'), { code: 'CANCELLED' });
  throw lastError || Object.assign(new Error('The engine could not be downloaded.'), { code: 'FAILED' });
}

module.exports = { ENGINE_SOURCES, ALLOWED_HOSTS, hostAllowed, downloadFile, installEngine, findBinaries, looksLikeZip };
