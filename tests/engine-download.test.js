'use strict';
/**
 * Fusion Flix — media-engine downloader tests.
 *
 * No internet is used: a tiny zip (containing a fake ffmpeg.exe / ffprobe.exe)
 * is served from a local HTTP server, and the downloader is pointed at it. The
 * real sources are only ever used by the app itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const downloader = require('../lib/engine-download');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-engine-'));

/** Builds a minimal (stored, no compression) ZIP archive in memory. */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'binary');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    chunks.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Serves one prepared response. */
function serveOnce(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('the allow-list only accepts https links from the known hosts', () => {
  assert.ok(downloader.hostAllowed('https://www.gyan.dev/ffmpeg/builds/x.zip'));
  assert.ok(downloader.hostAllowed('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/y.zip'));
  assert.ok(downloader.hostAllowed('https://objects.githubusercontent.com/whatever'));
  assert.strictEqual(downloader.hostAllowed('http://www.gyan.dev/x.zip'), false, 'plain http is refused');
  assert.strictEqual(downloader.hostAllowed('https://evil.example.com/ffmpeg.zip'), false, 'unknown hosts are refused');
  assert.strictEqual(downloader.hostAllowed('file:///etc/passwd'), false);
});

test('it refuses a host that is not on the list before opening a connection', async () => {
  await assert.rejects(() => downloader.downloadFile('https://not-allowed.example/x.zip', path.join(tmpRoot, 'x.zip')), /Refusing to download/);
});

test('a zip is detected by its magic bytes (not by the file name)', async () => {
  const zipPath = path.join(tmpRoot, 'real.zip');
  fs.writeFileSync(zipPath, makeZip([['bin/ffmpeg.exe', 'MZ fake engine']]));
  assert.strictEqual(await downloader.looksLikeZip(zipPath), true);

  const htmlPath = path.join(tmpRoot, 'error.html');
  fs.writeFileSync(htmlPath, '<html>404 not found</html>');
  assert.strictEqual(await downloader.looksLikeZip(htmlPath), false);
});

test('it finds ffmpeg.exe and ffprobe.exe anywhere in the unpacked tree', async () => {
  const root = path.join(tmpRoot, 'tree');
  fs.mkdirSync(path.join(root, 'ffmpeg-7.0-essentials_build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ffmpeg-7.0-essentials_build', 'bin', 'ffmpeg.exe'), 'MZ');
  fs.writeFileSync(path.join(root, 'ffmpeg-7.0-essentials_build', 'bin', 'ffprobe.exe'), 'MZ');
  fs.writeFileSync(path.join(root, 'README.txt'), 'hello');
  const found = await downloader.findBinaries(root);
  assert.ok(/ffmpeg\.exe$/.test(found.ffmpeg));
  assert.ok(/ffprobe\.exe$/.test(found.ffprobe));
});

test('the live download path reports progress and writes the bytes', async () => {
  // The downloader only talks https in production; for this test we exercise the
  // streaming/progress half of it through the same code with a fake response.
  const body = Buffer.alloc(3 * 1024 * 1024, 7);
  const server = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(body.length) });
    // Three chunks, so progress must move in between.
    res.write(body.subarray(0, body.length / 3));
    setTimeout(() => res.write(body.subarray(body.length / 3, (body.length * 2) / 3)), 10);
    setTimeout(() => res.end(body.subarray((body.length * 2) / 3)), 20);
  });
  const port = server.address().port;
  const dest = path.join(tmpRoot, 'downloaded.zip');

  // The shipping allow-list only accepts https from the official mirrors (asserted
  // above), so this test opts into a local server explicitly.
  const seen = [];
  try {
    const result = await downloader.downloadFile(`http://127.0.0.1:${port}/ffmpeg.zip`, dest, {
      allowedHosts: ['127.0.0.1'],
      allowHttp: true,
      onProgress: (p) => seen.push(p),
    });
    assert.strictEqual(fs.statSync(dest).size, body.length);
    assert.strictEqual(result.bytes, body.length);
    assert.ok(seen.length >= 3, `progress events: ${seen.length}`);
    const percents = seen.map((p) => p.percent);
    assert.ok(percents.some((p) => p > 0 && p < 100), `intermediate progress: ${JSON.stringify(percents)}`);
    assert.strictEqual(percents[percents.length - 1], 100);
  } finally {
    server.close();
  }
});

test('installEngine refuses to run without a target folder', async () => {
  await assert.rejects(() => downloader.installEngine({ url: 'https://www.gyan.dev/ffmpeg/builds/x.zip' }), /No target folder/);
});

test('cancelling a download stops it and leaves no installed engine', async () => {
  const body = zlib.gzipSync(Buffer.alloc(1024 * 1024));
  const server = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(body.length) });
    res.write(body.subarray(0, 16));
    // never finishes — the client cancels
  });
  const port = server.address().port;
  const target = path.join(tmpRoot, 'engine-target');
  const controller = new AbortController();
  try {
    const promise = downloader.downloadFile(`http://127.0.0.1:${port}/slow.zip`, path.join(tmpRoot, 'slow.zip'), {
      allowedHosts: ['127.0.0.1'],
      allowHttp: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 120);
    await assert.rejects(() => promise, /Cancelled/);
    assert.ok(!fs.existsSync(target) || fs.readdirSync(target).length === 0, 'nothing was installed');
  } finally {
    server.close();
  }
});

test('installEngine downloads, unpacks and installs both binaries (happy path)', async () => {
  // A stand-in for the real ~35 MB archive: the same layout (a build folder with
  // a bin/ inside), so the unpacking + discovery code is genuinely exercised.
  const zipBody = makeZip([
    ['ffmpeg-7.1-essentials_build/bin/ffmpeg.exe', 'MZ this is ffmpeg'],
    ['ffmpeg-7.1-essentials_build/bin/ffprobe.exe', 'MZ this is ffprobe'],
    ['ffmpeg-7.1-essentials_build/README.txt', 'docs'],
  ]);
  const server = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBody.length) });
    res.end(zipBody);
  });
  const port = server.address().port;
  const targetDir = path.join(tmpRoot, 'installed');
  const stages = [];
  try {
    const result = await downloader.installEngine({
      url: `http://127.0.0.1:${port}/ffmpeg-release-essentials.zip`,
      allowedHosts: ['127.0.0.1'],
      allowHttp: true,
      targetDir,
      onProgress: (p) => stages.push(p.stage),
    });
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(targetDir, 'ffmpeg.exe')), 'ffmpeg.exe installed');
    assert.ok(fs.existsSync(path.join(targetDir, 'ffprobe.exe')), 'ffprobe.exe installed');
    assert.strictEqual(fs.readFileSync(path.join(targetDir, 'ffmpeg.exe'), 'utf8'), 'MZ this is ffmpeg');
    assert.deepStrictEqual([...new Set(stages)], ['downloading', 'extracting', 'installing', 'done']);
    assert.ok(!fs.readdirSync(targetDir).some((f) => /README|\.zip$/i.test(f)), 'only the binaries are kept');
  } finally {
    server.close();
  }
});

test('installEngine falls back to the second mirror when the first one fails', async () => {
  const zipBody = makeZip([['bin/ffmpeg.exe', 'MZ ffmpeg'], ['bin/ffprobe.exe', 'MZ ffprobe']]);
  let attempts = 0;
  const server = await serveOnce((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      res.writeHead(404, { 'content-type': 'text/html', 'content-length': '17' });
      res.end('<html>nope</html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBody.length) });
    res.end(zipBody);
  });
  const port = server.address().port;
  const targetDir = path.join(tmpRoot, 'fallback');
  try {
    const result = await downloader.installEngine({
      // The mirror list is overridable for exactly this kind of drill.
      sources: [
        { name: 'mirror-one', url: `http://127.0.0.1:${port}/one.zip` },
        { name: 'mirror-two', url: `http://127.0.0.1:${port}/two.zip` },
      ],
      allowedHosts: ['127.0.0.1'],
      allowHttp: true,
      targetDir,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.source, 'mirror-two', 'the second mirror supplied the archive');
    assert.ok(fs.existsSync(path.join(targetDir, 'ffmpeg.exe')));
    assert.ok(attempts >= 2, `both mirrors were tried (${attempts})`);
  } finally {
    server.close();
  }
});

test('a dead mirror that returns an HTML error page is rejected, not installed', async () => {
  const server = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Service unavailable</body></html>');
  });
  const port = server.address().port;
  const targetDir = path.join(tmpRoot, 'not-a-zip');
  try {
    await assert.rejects(
      () => downloader.installEngine({ url: `http://127.0.0.1:${port}/x.zip`, allowedHosts: ['127.0.0.1'], allowHttp: true, targetDir }),
      /not a zip archive/i
    );
    assert.ok(!fs.existsSync(path.join(targetDir, 'ffmpeg.exe')), 'nothing was installed');
  } finally {
    server.close();
  }
});
