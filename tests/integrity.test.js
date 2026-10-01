'use strict';
/**
 * Fusion Flix — integrity tests that protect against silent drift:
 *   1. lib/ipc.js  ⇄  preload.js channel names
 *   2. /lib/*.js   ⇄  renderer/lib/*.js copies (npm run sync)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IPC = require('../lib/ipc');

test('preload channel names match lib/ipc.js exactly', () => {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const start = source.indexOf('// --- BEGIN CHANNELS');
  const end = source.indexOf('// --- END CHANNELS');
  assert.ok(start > 0 && end > start, 'channel block markers are present in preload.js');

  const block = source.slice(start, end);
  const objectStart = block.indexOf('{');
  const objectEnd = block.lastIndexOf('}');
  const literal = block.slice(objectStart, objectEnd + 1);
  // The block is a plain object literal of string constants — safe to evaluate.
  const parsed = new Function(`return (${literal});`)();

  const mainKeys = Object.keys(IPC).sort();
  const preloadKeys = Object.keys(parsed).sort();
  assert.deepStrictEqual(preloadKeys, mainKeys, 'the two channel maps list the same operations');

  for (const key of mainKeys) {
    assert.strictEqual(parsed[key], IPC[key], `channel "${key}" must be identical in both files`);
  }
  assert.ok(mainKeys.length >= 40, `expected a full channel map, found ${mainKeys.length}`);
});

test('every IPC channel used by main.js is declared and has a handler', () => {
  const ipcValues = new Set(Object.values(IPC));
  const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

  // Every constant referenced in main.js must exist in the map.
  const refs = mainSource.match(/IPC\.[A-Z_]+/g) || [];
  for (const ref of refs) {
    const key = ref.replace('IPC.', '');
    assert.ok(IPC[key], `IPC.${key} used in main.js is not defined in lib/ipc.js`);
  }

  // Channels the renderer invokes must be handled in main.js.
  const invokeChannels = [...preloadSource.matchAll(/call\(CHANNELS\.([A-Z_]+)\)/g)].map((m) => m[1]);
  const eventChannels = new Set(['MENU_ACTION', 'IMPORT_PROGRESS', 'EXPORT_PROGRESS', 'EXPORT_DONE', 'AUTOSAVE_TICK', 'BEFORE_CLOSE', 'ENGINE_NOTICE']);
  for (const key of invokeChannels) {
    if (eventChannels.has(key)) continue;
    assert.ok(mainSource.includes(`handle(IPC.${key}`), `main.js must handle the "${key}" channel (${IPC[key]})`);
  }
  assert.ok(invokeChannels.length > 25, 'a healthy number of invoke channels');
});

test('renderer/lib copies are byte-identical to lib (run npm run sync)', () => {
  for (const file of ['sanitize.js', 'filenames.js', 'validate.js', 'shortcuts.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'lib', file));
    const copy = fs.readFileSync(path.join(ROOT, 'renderer', 'lib', file));
    assert.ok(source.equals(copy), `renderer/lib/${file} is out of date — run "npm run sync"`);
  }
});

test('shared libraries load in a browser-like context (no require needed)', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.module = undefined;
  const vm = require('vm');
  const context = vm.createContext(sandbox);
  for (const file of ['sanitize.js', 'filenames.js', 'validate.js', 'shortcuts.js']) {
    const code = fs.readFileSync(path.join(ROOT, 'renderer', 'lib', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  assert.ok(sandbox.FFSanitize && typeof sandbox.FFSanitize.sanitizeFileName === 'function');
  assert.ok(sandbox.FFLib && typeof sandbox.FFLib.finalFileName === 'function');
  assert.ok(sandbox.FFValidate && typeof sandbox.FFValidate.validateProject === 'function');
  assert.ok(sandbox.FFKeys && typeof sandbox.FFKeys.resolve === 'function', 'the shortcut engine loads as a browser global');

  const vmResult = vm.runInContext(
    `FFLib.finalFileName({fileName:'a.mp4',sceneOn:true,scene:1,shotOn:true,shot:5,takeOn:true,take:15,extra:true,timeText:'01-05-15'})`,
    context
  );
  assert.strictEqual(vmResult, 'S-1_SH-5_T-15_EXTRA_(1-5-15).mp4');
});

test('the renderer never references a DOM id that does not exist in index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  for (const file of ['app.js', 'panels.js', 'ui.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8');
    const used = [...source.matchAll(/\$\('([a-zA-Z][\w-]*)'\)/g)].map((m) => m[1]);
    for (const id of used) {
      // ids created at runtime by the panels (export/settings dialogs)
      const runtimeIds = new Set(['btnRelink']);
      if (runtimeIds.has(id)) continue;
      if (id.startsWith('set') || id.startsWith('exp') || id.startsWith('ex') || id.startsWith('engine') || id.startsWith('res')) continue;
      assert.ok(ids.has(id), `${file} uses $('${id}') but index.html has no such id`);
    }
  }
});

test('no obvious placeholder text or TODO markers remain in the app code', () => {
  const files = ['main.js', 'preload.js', 'renderer/app.js', 'renderer/panels.js', 'renderer/ui.js', 'lib/exporter.js', 'lib/media.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/coming soon/i.test(source), `${file} must not contain "coming soon"`);
    assert.ok(!/lorem ipsum/i.test(source), `${file} must not contain placeholder copy`);
    assert.ok(!/TODO:|FIXME:/.test(source), `${file} must not contain TODO/FIXME markers`);
  }
});

test('security posture: sandbox + context isolation + no node integration', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.ok(!/require\(['"]fs['"]\)/.test(preload), 'preload must not expose fs');
  assert.ok(!/require\(['"]child_process['"]\)/.test(preload), 'preload must not expose child_process');
  assert.ok(!/shell:\s*true/.test(source), 'shell must not be raw-exposed');
});

test('ffmpeg is always spawned without a shell', () => {
  const media = fs.readFileSync(path.join(ROOT, 'lib/media.js'), 'utf8');
  assert.ok(!/exec\(|execSync\(/.test(media), 'no shell string execution in the media engine');
  assert.ok(!/shell:\s*true/.test(media), 'ffmpeg is never run through a shell');
  assert.match(media, /shell: false/);
});
