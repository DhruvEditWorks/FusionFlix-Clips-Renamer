'use strict';
/**
 * Fusion Flix — wiring audit.
 *
 * These are static checks over the renderer sources. They exist because the
 * things they guard are exactly the things that silently rot: a shortcut whose
 * action was never written, a button nobody listens to, a removed feature that
 * left a stub behind. Nothing here needs a browser.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const appJs = read('renderer/app.js');
const indexHtml = read('renderer/index.html');
const panelsJs = read('renderer/panels.js');
const styleCss = read('renderer/style.css');
const shortcuts = require('../lib/shortcuts');

/** Pulls the top-level keys out of the renderer's ACTIONS object literal. */
function actionNames() {
  const start = appJs.indexOf('const ACTIONS = {');
  assert.ok(start > -1, 'ACTIONS object found in renderer/app.js');
  const body = appJs.slice(start);
  const end = body.indexOf('\n  };');
  const literal = body.slice(0, end);
  const names = new Set();
  // matches both `name: () => …` and object shorthand `name,`
  for (const m of literal.matchAll(/^ {4}([A-Za-z][A-Za-z0-9_]*)\s*[:,]/gm)) names.add(m[1]);
  return names;
}

test('every shortcut action exists in the renderer', () => {
  const actions = actionNames();
  const missing = shortcuts.DEFINITIONS.map((d) => d.action || d.id).filter((name) => !actions.has(name));
  assert.deepStrictEqual(missing, [], `shortcuts with no implementation: ${missing.join(', ')}`);
});

test('every action is reachable from a shortcut (nothing implemented is orphaned)', () => {
  const actions = actionNames();
  const bound = new Set(shortcuts.DEFINITIONS.map((d) => d.action || d.id));
  const orphans = [...actions].filter((name) => !bound.has(name));
  // These are click-driven only on purpose.
  const allowed = new Set(['toggleExtra']);
  assert.deepStrictEqual(orphans.filter((n) => !allowed.has(n)), [], `unbound actions: ${orphans.join(', ')}`);
});

test('the primary Rename button is wired to the rename dialog', () => {
  assert.match(indexHtml, /id="btnRename"/, 'the toolbar has a Rename button');
  assert.match(indexHtml, /id="btnExport"/, 'and it sits next to Export');
  assert.ok(
    indexHtml.indexOf('id="btnRename"') < indexHtml.indexOf('id="btnExport"'),
    'Rename comes first — it is the everyday action'
  );
  assert.match(appJs, /\$\('btnRename'\)\.addEventListener\('click', \(\) => window\.FFPanels\.openRename\(\)\)/);
  assert.match(panelsJs, /openRename\s*[,:]/);
  assert.match(panelsJs, /async function openRename/);
});

test('the ZIP export path is gone for good', () => {
  assert.ok(!/\barchiver\b/.test(read('package.json')), 'archiver is not a dependency any more');
  for (const rel of ['lib/exporter.js', 'renderer/panels.js', 'lib/settings.js', 'renderer/app.js']) {
    assert.ok(!/require\(['"]archiver/.test(read(rel)), `${rel} does not import archiver`);
  }
  const settings = read('lib/settings.js');
  assert.ok(!/zipExport|exportMode|mode:\s*'zip'/.test(settings), 'no ZIP setting survives in settings.js');
});

test('the floating hover preview is gone; the main player hover is not', () => {
  assert.ok(!/hover-preview|hover-chip/.test(styleCss), 'no CSS left over from the pop-up preview');
  assert.ok(!/hover-preview|hover-chip|hoverPreview/.test(indexHtml), 'no markup left over either');
  assert.match(appJs, /shuttleEnabled/, 'hover-shuttle is still a settings-driven feature');
});

test('hover shuttle is off by default and switchable', () => {
  const settings = read('lib/settings.js');
  assert.match(settings, /hoverShuttle:\s*false/, 'default OFF');
  assert.match(indexHtml, /id="btnScrubHint"/, 'switchable from the transport bar');
  assert.match(panelsJs, /setHoverShuttle|hoverShuttle/, 'and from Settings');
});

test('the YouTube button points at the channel and is in all three places', () => {
  assert.match(panelsJs, /https:\/\/www\.youtube\.com\/@fusiononyoutube/);
  for (const id of ['btnYouTube', 'welcomeYouTube', 'aboutYouTube']) {
    assert.ok(indexHtml.includes(`id="${id}"`) || panelsJs.includes(`id="${id}"`), `${id} exists`);
  }
  assert.match(appJs + panelsJs, /closest\('\.yt-btn'\)|class="yt-btn/, 'the delegated yt-btn click handler covers them');
});

test('the footer line reads exactly as specified', () => {
  const line = 'A free to use tool by Fusion Flix (Dhruv Sharma) \u{1F493}';
  assert.ok(indexHtml.includes(line), 'footer');
  assert.ok(panelsJs.includes(line), 'welcome panel / about');
});

test('every element the renderer listens on exists in the markup', () => {
  // Markup lives in the HTML, in panels.js, and in a few renderer-built strings.
  const markup = indexHtml + panelsJs + appJs;
  const ids = new Set([...appJs.matchAll(/\$\('([A-Za-z][A-Za-z0-9_]*)'\)/g)].map((m) => m[1]));
  for (const m of appJs.matchAll(/dom\.[A-Za-z0-9_]*/g)) void m; // dom.* is built from ids above
  const declared = new Set([
    ...[...markup.matchAll(/id="([A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1]),
    ...[...markup.matchAll(/id=\\?"([A-Za-z][A-Za-z0-9_]*)\\?"/g)].map((m) => m[1]),
  ]);
  const missing = [...ids].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], `listeners on ids that do not exist: ${missing.join(', ')}`);
});

test('settings toggles introduced in 1.2.0 are all present', () => {
  for (const id of ['setHoverShuttle', 'setAutoFill', 'setCustomClears', 'setDownloadEngine', 'setCheckEngines', 'setLocateFfmpeg']) {
    assert.match(panelsJs, new RegExp(`['"]${id}['"]|id="${id}"`), `${id} exists`);
  }
});

test('the version in package.json is the one shown in the About panel', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.match(panelsJs, /pkg\.version|packageJson\.version|\.version\b/, 'the About panel reads the real version');
});

test('export is a plain copy: flat by default, Scene folders optional, no report file', () => {
  const exporter = read('lib/exporter.js');
  const panels = read('renderer/panels.js');
  const settings = read('lib/settings.js');
  const main = read('main.js');

  assert.match(settings, /exportLayout: 'flat'/, 'flat is the default layout');
  assert.match(exporter, /options\.layout === 'scenes' \? 'scenes' : 'flat'/, 'an unknown layout falls back to flat');
  assert.match(exporter, /const folder = entry\.folder \? safeJoin\(this\.destination, entry\.folder\) : this\.destination;/);
  assert.ok(!/fsp\.link\(/.test(exporter), 'hard links are gone — an export is always a real copy');
  assert.ok(!/export_report|manifest/i.test(exporter), 'no report/manifest file is written');
  assert.match(panels, /data-layout="flat"/, 'the Export window offers the flat layout');
  assert.match(panels, /data-layout="scenes"/, 'the Export window offers the Scene layout');
  assert.match(panels, /setExportLayout/, 'Settings offers the export folder structure');
  assert.match(main, /layout: settings\.exportLayout/, 'the layout setting reaches the export plan');
});

test('the v1.3.0 layout is wired: floating pop-ups, draggable panes, console progress', () => {
  const appJs = read('renderer/app.js');
  const css = read('renderer/style.css');
  // three-pane grid driven by CSS variables
  for (const token of ['--split-left', '--split-right', '--console-h']) {
    assert.ok(css.includes(token), `${token} drives the workspace grid`);
    assert.ok(appJs.includes(token), `${token} is written by the splitter`);
  }
  // the workspace really is a grid (an orphaned CSS block once broke every
  // pop-up by swallowing the modal rules — see the e2e geometry test)
  assert.match(css, /\.workspace\s*\{[^}]*display:\s*grid/s, 'the workspace is a grid');
  assert.match(css, /#previewPane\s*\{[^}]*grid-column:\s*1/s, 'the preview occupies the first column');
  assert.match(css, /#browserPane\s*\{[^}]*grid-column:\s*3/s, 'the clip list sits on the right');
  assert.match(css, /#consolePane\s*\{[^}]*grid-row:\s*3/s, 'the console spans the bottom');
  // floating modal layer
  assert.match(css, /\.modal-root\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.overlay-layer\.scrim\s*\{[^}]*display:\s*flex/s, 'scrim dialogs are centred');
  assert.match(css, /\.overlay-layer\.floating\s*\{[^}]*display:\s*block/s, 'window dialogs are free-floating');
  assert.ok(css.includes('.modal-window'), 'floating window styling exists');
  const uiJs = read('renderer/ui.js');
  assert.ok(uiJs.includes('blockingOpen'), 'the UI kit can tell blocking dialogs apart');
  assert.ok(appJs.includes('UI.blockingOpen()'), 'shortcuts stay alive behind floating windows');
  assert.ok(uiJs.includes("addEventListener('mousedown', (e) => onDown(e, 'drag'))"), 'title bars are draggable');
  // the still-frame fallback for codecs the player cannot decode
  assert.ok(appJs.includes('showStillFor'), 'a still frame is shown when the codec is unsupported');
  assert.ok(read('main.js').includes("job.variant || 'thumb'"), 'still frames are requested with their own cache variant');
});

test('preload never unhooks other listeners when an unknown callback is passed to off()', () => {
  const preload = read('preload.js');
  const body = preload.slice(preload.indexOf('function off(channel, listener)'), preload.indexOf('const call = (channel)'));
  assert.ok(body, 'off() is present');
  // The "not found → clear the whole channel" behaviour made the app drop its own
  // rename/export handlers (a rename finished and nothing was reported).
  assert.ok(
    /if \(!listener\)/.test(body),
    'clearing a channel must require an explicit off(channel) with no listener'
  );
  assert.ok(/Unknown listener/.test(body), 'an unmatched listener must be a no-op');
  assert.ok(!/String\(listener\)/.test(body), 'source-text matching is out — bridged functions can all claim "[native code]"');
  assert.ok(/map\.has\(listener\)/.test(body), 'identity is the only match');
});

test('everything the app subscribes to lives on a published event channel', () => {
  const preload = read('preload.js');
  const eventBlock = preload.slice(preload.indexOf('const EVENT_CHANNELS'), preload.indexOf('const registered'));
  for (const name of ['RENAME_PROGRESS', 'RENAME_DONE', 'EXPORT_PROGRESS', 'EXPORT_DONE', 'ENGINE_DOWNLOAD_PROGRESS', 'ENGINE_DOWNLOAD_DONE']) {
    assert.ok(eventBlock.includes(`CHANNELS.${name}`), `${name} is subscribable`);
  }
});

// ---------------------------------------------------------------------------
// v1.3.2 — preview proxies + the S/SH/T bracket
// ---------------------------------------------------------------------------

test('v1.3.2: the bracket in a filename carries Scene, Shot and Take — nothing else', () => {
  const F = require(path.join(root, 'lib', 'filenames.js'));
  const clip = {
    id: '1',
    fileName: 'clip.mp4',
    timeText: '01-05-15',
    sceneOn: true,
    scene: 1,
    shotOn: true,
    shot: 5,
    takeOn: true,
    take: 15,
  };
  assert.strictEqual(F.finalFileName(clip), 'S-1_SH-5_T-15_(1-5-15).mp4');
  assert.strictEqual(F.finalFileName(Object.assign({}, clip, { extra: true })), 'S-1_SH-5_T-15_EXTRA_(1-5-15).mp4');
  // A switched-off tag contributes 0 — never the source timecode.
  const noTake = Object.assign({}, clip, { takeOn: false });
  assert.strictEqual(F.finalFileName(noTake), 'S-1_SH-5_(1-5-0).mp4');
  const nothing = { id: '2', fileName: 'clip_01.mov', timeText: '12-30-01', extra: false };
  assert.strictEqual(F.finalFileName(nothing), 'clip_01_(0-0-0).mov');
  const doc = read('lib/filenames.js');
  assert.ok(/\(\[Scene\]-\[Shot\]-\[Take\]\)/.test(doc), 'the header documents the bracket');
  assert.ok(!/\(HH-MM-SS\)/.test(doc), 'the old time code element is gone from the docs');
});

test('v1.3.2: the preview proxy is wired end to end', () => {
  const ipc = read('lib/ipc.js');
  const preload = read('preload.js');
  const main = read('main.js');
  const app = read('renderer/app.js');
  const panels = read('renderer/panels.js');

  for (const name of ['MEDIA_PROXY', 'MEDIA_PROXY_CANCEL', 'MEDIA_PROXY_PROGRESS']) {
    assert.ok(ipc.includes(`${name}:`), `${name} is declared in lib/ipc.js`);
    assert.ok(preload.includes(`CHANNELS.${name} :`) || preload.includes(`${name}:`), `${name} is mirrored in preload.js`);
  }
  assert.ok(ipc.includes("MEDIA_PROXY: 'media:proxy'"), 'the channel names are the documented ones');
  assert.ok(main.includes('handle(IPC.MEDIA_PROXY,'), 'the main process answers MEDIA_PROXY');
  assert.ok(main.includes('media.ensureProxy('), 'the main process builds proxies with lib/media.js');
  assert.ok(main.includes('activeProxy'), 'only one proxy is built at a time');
  assert.ok(main.includes('paths.isInside(cacheDir, v.path)'), 'the ffmedia protocol also serves app-generated preview files');
  assert.ok(preload.includes('proxy: call(CHANNELS.MEDIA_PROXY)'), 'the renderer can request a proxy');
  assert.ok(preload.includes('cancelProxy: call(CHANNELS.MEDIA_PROXY_CANCEL)'), 'the renderer can cancel one');

  assert.ok(app.includes('requestProxyPreview(clip)'), 'a failed decode starts a proxy');
  assert.ok(app.includes('FF.media.proxy('), 'the proxy is requested over IPC');
  assert.ok(/state\.proxies\.get\(clip\.id\)/.test(app), 'a proxy built once is reused');
  assert.ok(app.includes('playProxy('), 'the proxy is played in the main player');
  assert.ok(app.includes('showUnplayableFor('), 'with no engine the player explains itself instead of going black');
  assert.ok(app.includes('installEngine'), 'the player can start the engine install');
  const eventBlock = preload.slice(preload.indexOf('const EVENT_CHANNELS'), preload.indexOf('const registered'));
  assert.ok(eventBlock.includes('CHANNELS.MEDIA_PROXY_PROGRESS'), 'proxy progress is a published event channel');
  assert.ok(panels.includes('MEDIA_PROXY_PROGRESS'), 'the panels listen for proxy progress');
  assert.ok(panels.includes('installEngine: () =>'), 'the one-click engine install is exposed to the renderer');
});

test('v1.3.2: the welcome screen offers the media engine when it is missing', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const css = read('renderer/style.css');
  assert.ok(html.includes('id="welcomeEngine"') && html.includes('id="welcomeEngineInstall"'), 'the card exists in the markup');
  assert.ok(html.includes('hidden'), 'and stays hidden until it is needed');
  assert.ok(app.includes('showEngineCard()'), 'the renderer reveals it when FFmpeg is missing');
  assert.ok(app.includes('hideEngineCard()'), 'and hides it once the engine is installed');
  assert.ok(app.includes("getElementById('previewVideo')") || app.includes("$('welcomeEngineInstall')"), 'the card button is wired');
  assert.ok(app.includes('PlatformHEVCDecoderSupport') === false, 'the renderer does not set switches');
  assert.ok(read('main.js').includes("appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')"), 'Windows hardware HEVC decoding is requested');
  assert.ok(css.includes('.welcome-engine'), 'the card is styled');
});

test('v1.3.2: cache maintenance covers the proxy folder too', () => {
  const media = read('lib/media.js');
  assert.ok(media.includes('collectCacheFiles'), 'the pruner walks the cache tree');
  assert.ok(/proxyRoot = proxyDirFor\(cacheDir\)/.test(media), 'proxies are budgeted separately from thumbnails');
  assert.ok(/fsp\.rm\(proxyDirFor\(cacheDir\)/.test(media), 'clearing caches removes the proxies as well');
});

test('v1.3.3: every App.<helper> the other renderer modules call actually exists', () => {
  // The import flow called App.updateProjectMeta(), which was never exported:
  // the TypeError was swallowed by the import try/catch, so the clips landed in
  // the list while the welcome overlay stayed on top of the player — "preview
  // still not working". This audit makes that class of bug impossible to ship.
  const app = read('renderer/app.js');
  const exportStart = app.indexOf('window.FFApp = {');
  assert.ok(exportStart > 0, 'the renderer exports its API');
  let depth = 0;
  let exportEnd = exportStart;
  for (let i = exportStart; i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        exportEnd = i;
        break;
      }
    }
  }
  const block = app.slice(exportStart, exportEnd);
  const exported = new Set();
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[:(,]/);
    if (m) exported.add(m[1]);
  }
  assert.ok(exported.has('updateWelcome') && exported.has('updateProjectMeta'), 'the core helpers are exported');

  for (const file of ['renderer/panels.js', 'renderer/ui.js']) {
    const source = read(file);
    const used = new Set();
    const re = /\bApp\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(source))) used.add(m[1]);
    const missing = [...used].filter((name) => !exported.has(name));
    assert.deepStrictEqual(missing, [], `${file} calls helpers the app does not export: ${missing.join(', ')}`);
  }
});

test('v1.3.3: the player can never be left covered by the first-run panel', () => {
  const app = read('renderer/app.js');
  const panels = read('renderer/panels.js');
  assert.ok(/function deferWelcome\(\)/.test(app), 'the overlay is re-checked after every paint');
  assert.ok(/function renderBrowser\(keepScroll\) \{\s*\n\s*deferWelcome\(\)/.test(app), 'the clip list renderer keeps it honest');
  assert.ok(/renderFooter\(\);\s*\n\s*\/\/ A selected clip must always be visible[\s\S]{0,220}deferWelcome\(\);/.test(app), 'selecting a clip hides it too');
  const importBlock = panels.slice(panels.indexOf('async function importPaths'), panels.indexOf('function showList'));
  const selectAt = importBlock.indexOf('App.selectClip(');
  const welcomeAt = importBlock.indexOf('App.updateWelcome();');
  const metaAt = importBlock.indexOf('App.updateProjectMeta();');
  assert.ok(selectAt > 0 && welcomeAt > selectAt, 'import selects the first clip before anything cosmetic runs');
  assert.ok(metaAt > welcomeAt, 'the cosmetic summary is the last step, never in the way');
  assert.ok(!/App\.updateProjectMeta\(\);\s*\n\s*if \(!state\.currentClipId\)/.test(importBlock), 'the old (buggy) order is gone');
});
