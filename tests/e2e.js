'use strict';
/**
 * FUSION FLIX — end-to-end smoke test.
 *
 * Boots the real Electron application (same main.js, same renderer), drives the
 * actual UI in a hidden window and verifies the complete workflow:
 *   sample generation → import → tagging → Apply & Next → Next-from-previous
 *   → undo/redo → export (folder) → rename → delete confirmation → save/open
 *   → 1.2.0: rename button, J/K/L, Shift+A/S/D/E/W, YouTube button, Ctrl+F
 *   → missing media → relink
 *
 * Run:  electron tests/e2e.js        (Linux CI: xvfb-run -a electron tests/e2e.js)
 * The app window stays hidden; results are printed to stdout and the process
 * exits non-zero if anything fails.
 */

process.env.FF_E2E = '1';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-flix-e2e-'));
app.setPath('userData', path.join(tmp, 'userData'));
// Headless-friendly flags. Extra flags can be supplied with FF_E2E_SWITCHES
// (e.g. "no-sandbox" inside containers that need it).
app.commandLine.appendSwitch('disable-gpu');
if (process.env.FF_E2E_SWITCHES) {
  for (const flag of process.env.FF_E2E_SWITCHES.split(',').filter(Boolean)) {
    const [key, value] = flag.split('=');
    if (value === undefined) app.commandLine.appendSwitch(key);
    else app.commandLine.appendSwitch(key, value);
  }
}

// Boot the real application.
const main = require('../main.js');

const failures = [];
const passes = [];
const consoleErrors = [];

function check(name, condition, detail) {
  if (condition) {
    passes.push(name);
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failures.push({ name, detail });
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeout = 30000, interval = 200) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Writes a small stand-in file so the rename engine has something real to move. */
async function writeFakeClip(dir, name, bytes = 2048) {
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fsp.writeFile(p, Buffer.alloc(bytes, 7));
  return p;
}

/** A clip object shaped exactly like the app's own (for direct IPC calls). */
function clipFor(sourcePath, over) {
  const st = fs.statSync(sourcePath);
  return Object.assign(
    {
      id: path.basename(sourcePath),
      order: 0,
      sourcePath,
      fileName: path.basename(sourcePath),
      size: st.size,
      sceneOn: true,
      scene: 1,
      shotOn: true,
      shot: 1,
      takeOn: true,
      take: 1,
      extra: false,
      customOn: false,
      custom: '',
      timeText: '00-00-01',
      status: 'new',
      meta: { duration: 5 },
    },
    over || {}
  );
}

async function run() {
  const win = await waitFor(() => {
    const w = BrowserWindow.getAllWindows()[0];
    return w && !w.webContents.isLoading() ? w : null;
  });
  const wc = win.webContents;

  wc.on('console-message', (_e, level, message, line, source) => {
    if (level >= 3) consoleErrors.push(`${path.basename(source || '')}:${line} ${message}`);
  });
  wc.on('render-process-gone', (_e, details) => failures.push({ name: 'renderer stayed alive', detail: details.reason }));

  const js = async (code) => {
    try {
      return await wc.executeJavaScript(code, true);
    } catch (err) {
      // Surface *which* renderer snippet blew up — a bare "Script failed to
      // execute" costs half an hour of guessing.
      const message = (err && err.message) || String(err);
      const snippet = String(code).replace(/\s+/g, ' ').slice(0, 220);
      throw new Error(`${message}\n      in: ${snippet}`);
    }
  };

  // ---------------------------------------------------------------------
  section('Boot');
  await waitFor(() => js('window.FFApp && window.FFApp.ready === true'), 20000);
  check('renderer finished loading and FFPanels is wired', await js('Boolean(window.FF && window.FFApp && window.FFPanels && window.FFUI)'));
  check(
    'shared naming library loaded inside the sandboxed renderer',
    await js("FFLib.finalFileName({fileName:'a.mp4',sceneOn:true,scene:1,shotOn:true,shot:5,takeOn:true,take:15,extra:false,timeText:'01-05-15'}) === 'S-1_SH-5_T-15_(1-5-15).mp4'")
  );
  check('welcome panel is visible on first run', await js("document.getElementById('welcomePanel').hidden === false"));
  check('footer carries the Fusion Flix credit', (await js("document.querySelector('.status-brand').textContent")).includes('A free to use tool by Fusion Flix (Dhruv Sharma)'));
  check('CTA buttons exist on the welcome panel', await js("!!document.getElementById('welcomeImport') && !!document.getElementById('welcomeOpen')"));

  // ---------------------------------------------------------------------
  section('Sample project + import');
  const engines = await js('window.FF.settings.checkEngines()');
  check('ffmpeg and ffprobe are available', engines.ffmpeg.ok && engines.ffprobe.ok, JSON.stringify({ f: engines.ffmpeg.ok, p: engines.ffprobe.ok }));

  await js('window.FFPanels.loadSample()');
  await waitFor(() => js('window.FFApp.state.project.clips.length > 0'), 60000, 400);

  const clipCount = await js('window.FFApp.state.project.clips.length');
  check('sample project imported its generated clips', clipCount === 8, `got ${clipCount}`);
  check('hundreds-of-clips project state is a plain array (virtualiser ready)', await js('Array.isArray(window.FFApp.state.project.clips)'));
  check('welcome panel hides once clips exist', await js("document.getElementById('welcomePanel').hidden === true"));

  // The user-visible failure this guards: clips import into the list, but the
  // first-run overlay stays on top of the player, so nothing ever "previews".
  const afterImport = await js(`(() => {
    const w = document.getElementById('welcomePanel');
    return JSON.stringify({
      hidden: w.hidden,
      display: getComputedStyle(w).display,
      clips: window.FFApp.state.project.clips.length,
      current: window.FFApp.state.currentClipId,
      chip: (document.getElementById('projectMeta') || {}).textContent || '',
      hasHelper: typeof (window.FFApp || {}).updateProjectMeta === 'function',
    });
  })()`);
  const imported = JSON.parse(afterImport);
  check('an import leaves the welcome overlay out of the player', imported.hidden === true && imported.display === 'none', afterImport);
  check('an import selects the first clip automatically', Boolean(imported.current) && imported.clips > 0, afterImport);
  check('the clip counter in the top bar was updated', /\d+ clip/.test(imported.chip), imported.chip);
  check('every helper the panels call exists on window.FFApp', imported.hasHelper === true, afterImport);

  const firstMeta = await js('JSON.stringify(window.FFApp.state.project.clips[0].meta)');
  const meta = JSON.parse(firstMeta);
  check('clip metadata was probed (dimensions + fps + duration)', meta.width > 0 && meta.height > 0 && meta.duration > 0, firstMeta);
  check(
    'Scene / Shot / Take arrive switched ON (7 of 8 sample clips — the 8th demonstrates the not-named-yet flow)',
    await js("(() => { const c = window.FFApp.state.project.clips; return c.filter((x) => x.sceneOn && x.shotOn && x.takeOn).length === 7; })()")
  );
  check(
    'the showcase numbers on the sample clips are preserved (clip 6 = Scene 2 / Shot 2 / Take 1)',
    await js("(() => { const c = window.FFApp.state.project.clips[5]; return c.scene === 2 && c.shot === 2 && c.take === 1; })()")
  );

  // The sample ships with placeholder metadata so every panel has content.
  // Verify that showcase data first, then normalise for deterministic checks.
  check(
    'sample clips arrive with placeholder metadata (custom names, extra flags, scenes)',
    await js("(() => { const c = window.FFApp.state.project.clips; return c[1].custom === 'Opening Drone Shot' && c[4].extra === true && c[2].scene === 1 && c[7].sceneOn === false; })()")
  );
  await js(`(() => {
    const clips = window.FFApp.state.project.clips;
    clips.forEach((c) => { c.sceneOn=false; c.scene=null; c.shotOn=false; c.shot=null; c.takeOn=false; c.take=null; c.extra=false; c.customOn=false; c.custom=''; c.status='new'; });
    window.FFApp.state.undo.length = 0;
    window.FFApp.state.redo.length = 0;
    window.FFApp.refreshAll();
    return true;
  })()`);
  await js('void document.activeElement.blur()');

  // ---------------------------------------------------------------------
  section('Clip browser');
  await waitFor(() => js("document.querySelectorAll('#clipListInner .clip-row').length > 0"), 15000);
  check('virtualised rows are rendered', await js("document.querySelectorAll('#clipListInner .clip-row').length > 0"));
  check('clip list reports its position', (await js("document.getElementById('browserCount').textContent")).includes('8'));
  check(
    'an un-tagged clip shows its original name and is flagged as not named yet',
    await js("(() => { const c = window.FFApp.state.project.clips[0]; return FFLib.needsNaming(c) && FFLib.finalFileName(c).startsWith('01_city_broll'); })()")
  );

  // thumbnails (ffmpeg extraction through the ffthumb: protocol)
  const thumbOk = await waitFor(async () => js("Boolean(document.querySelector('#clipListInner .clip-row img[src^=\"ffthumb://\"]'))"), 45000);
  check('thumbnails are generated and streamed to the list', Boolean(thumbOk));

  // ---------------------------------------------------------------------
  section('Hover preview + main preview');
  const beforeHoverId = await js('window.FFApp.state.currentClipId');
  await js(`void (() => { window.FFApp.state.pendingEdits.scene = false;
      window.FFApp.state.pendingEdits.shot = false;
      window.FFApp.state.pendingEdits.take = false;
      window.FFApp.state.pendingEdits.custom = false;
      const rows = Array.from(document.querySelectorAll('#clipListInner .clip-row'));
      const row = rows[6] || rows[rows.length - 1];
      const thumb = row.querySelector('.clip-thumb');
      const r = thumb.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
      document.querySelectorAll('#clipListInner .clip-row').forEach((el) => { if (el !== row) el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); }); })()`);
  await new Promise((r) => setTimeout(r, 900));
  const hoveredId = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#clipListInner .clip-row'));
    const row = rows[6] || rows[rows.length - 1];
    return row ? row.dataset.clipId : '';
  })()`);
  check('no floating preview element exists anywhere in the window (removed in 1.2.0)', !(await js("Boolean(document.getElementById('hoverPreview'))")));
  check('hovering a clip loads it into the main preview', hoveredId && hoveredId === (await js('window.FFApp.state.currentClipId')), `${beforeHoverId} -> ${hoveredId}`);
  check(
    'the main preview element points at the hovered clip',
    await js(`(() => {
      try {
        const v = document.getElementById('previewVideo');
        const clip = window.FFApp.clipById(window.FFApp.state.currentClipId);
        if (!v || !v.src || !clip) return 'no-src:' + Boolean(v && v.src) + ':' + Boolean(clip);
        // The stream URL is percent-encoded — compare decoded paths, not raw strings.
        const want = String(clip.sourcePath).replace(/[\\\\]/g, '/');
        let got = v.src;
        try { got = decodeURIComponent(v.src); } catch (_) {}
        got = got.replace(/[\\\\]/g, '/');
        return got.includes(want) || got.includes(want.split('/').pop());
      } catch (e) { return 'ERR: ' + (e && e.message); }
    })()`)
  );
  check('nothing floats near the mouse while hovering the list', !(await js("Boolean(document.querySelector('.hover-preview, .hover-chip, #hoverPreview'))")));
  check('the main preview keeps its own audio state', (await js("typeof document.getElementById('previewVideo').muted")) === 'boolean');

  // --- Space plays regardless of where focus is ----------------------------
  await js(`(() => {
    // A switched-off field is disabled and cannot hold focus — switch Scene on
    // so the shortcut really is tested with a number box focused.
    const on = document.getElementById('sceneOn');
    if (!on.checked) { on.checked = true; on.dispatchEvent(new Event('change')); }
    const input = document.getElementById('sceneInput');
    if (input.disabled) input.disabled = false;
    input.focus();
    return document.activeElement.id;
  })()`);
  const spaceTarget = await js("document.activeElement.id");
  check('a number box really has focus for the Space test', spaceTarget === 'sceneInput', spaceTarget);
  await js("void document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 500));
  const playing = await js("!document.getElementById('previewVideo').paused");
  check(`Space plays the clip even with the ${spaceTarget} box focused`, playing);
  await js("void document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 300));
  check('Space pauses again', await js("document.getElementById('previewVideo').paused"));
  check(
    'Space is NOT treated as play while typing a custom name',
    await js(`(() => {
      const input = document.getElementById('customInput');
      if (input.disabled) return true; // nothing to type into right now
      input.focus();
      const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return ev.defaultPrevented === false;
    })()`)
  );

  // --- the F shortcut ------------------------------------------------------
  await js("void document.activeElement.blur()");
  await js("window.FFApp.selectClip(window.FFApp.state.project.clips[3].id)");
  const beforeF = await js('JSON.stringify({s:window.FFApp.state.project.clips[3].scene, sh:window.FFApp.state.project.clips[3].shot, t:window.FFApp.state.project.clips[3].take})');
  await js("void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))");
  const afterF = await js('JSON.stringify({s:window.FFApp.state.project.clips[3].scene, sh:window.FFApp.state.project.clips[3].shot, t:window.FFApp.state.project.clips[3].take})');
  check('F carries Scene + Shot + Take forward from the previous clip', beforeF !== afterF, `${beforeF} -> ${afterF}`);

  // --- theme + accent colour ----------------------------------------------
  await js("window.FFApp.applyTheme('daylight', '#3b82f6')");
  check('the white Daylight theme applies', (await js("document.documentElement.dataset.theme")) === 'daylight');
  check(
    'the chosen accent colour is applied to the CSS variables',
    (await js("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()")) === '#3b82f6'
  );
  check(
    'accent-derived tokens follow the custom colour',
    (await js("getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()")).replace(/\s/g, '') === '59,130,246'
  );
  check('text on the accent button stays readable', Boolean(await js("getComputedStyle(document.documentElement).getPropertyValue('--accent-ink').trim()")));
  await js("window.FFApp.applyTheme('cinema', '#f0562f')");
  check('switching back to Cinema works', (await js("document.documentElement.dataset.theme")) === 'cinema');

  // --- focus (simple) view -------------------------------------------------
  await js('window.FFApp.setFocusMode(true, { persist: false })');
  await new Promise((r) => setTimeout(r, 250));
  check('focus view hides the clip browser', (await js("getComputedStyle(document.getElementById('browserPane')).display")) === 'none');
  check('focus view hides the renaming console', (await js("getComputedStyle(document.getElementById('consolePane')).display")) === 'none');
  check('focus view parks the draggable dividers', (await js("getComputedStyle(document.getElementById('splitMain')).display")) === 'none');
  // A pane that is merely "not display:none" can still be zero pixels wide —
  // measure it, because that is exactly how focus view once broke.
  const focusBox = await js(`(() => {
    const p = document.getElementById('previewPane').getBoundingClientRect();
    const v = document.getElementById('previewVideo').getBoundingClientRect();
    const ws = document.querySelector('.workspace').getBoundingClientRect();
    return { pane: Math.round(p.width), video: Math.round(v.width), videoH: Math.round(v.height), workspace: Math.round(ws.width) };
  })()`);
  check(
    'the preview fills the window in focus view (no zero-width stage)',
    focusBox.pane > focusBox.workspace * 0.9 && focusBox.video > 500 && focusBox.videoH > 300,
    JSON.stringify(focusBox)
  );
  await js('window.FFApp.setFocusMode(false, { persist: false })');
  await new Promise((r) => setTimeout(r, 250));
  check('leaving focus view brings the panels back', (await js("getComputedStyle(document.getElementById('browserPane')).display")) !== 'none');

  // --- shortcut remapping --------------------------------------------------
  const remap = await js(`(() => {
    window.FFApp.reloadBindings({ nextTake: 'Shift+H' });
    const resolved = window.FFKeys.resolve({ key: 'H', shiftKey: true }, window.FFApp.state.bindings, { typingAny: false });
    const old = window.FFKeys.resolve({ key: 'h' }, window.FFApp.state.bindings, { typingAny: false });
    window.FFApp.reloadBindings({});
    return { remapped: resolved && resolved.id, oldBinding: old && old.id };
  })()`);
  check('a remapped shortcut resolves to its action', remap.remapped === 'nextTake', JSON.stringify(remap));
  check('the old key stops working after a remap', remap.oldBinding === null, JSON.stringify(remap));

  // A stock import must arrive fully tagged before any setting is touched.
  const stockClip = path.join(tmp, `stock-defaults-${Date.now()}.mp4`);
  await fsp.copyFile(await js('window.FFApp.state.project.clips[0].sourcePath'), stockClip);
  const stockBefore = await js('window.FFApp.state.project.clips.length');
  const stockImport = await js(`window.FFPanels.importPaths([${JSON.stringify(stockClip)}], { source: 'drop' }).then(() => 'ok', (e) => 'ERR: ' + (e && e.message))`);
  check('the stand-in clip imports cleanly', stockImport === 'ok', String(stockImport));
  await waitFor(() => js(`window.FFApp.state.project.clips.length > ${stockBefore}`), 30000, 300);
  const stockClipMeta = await js(`(() => {
    const c = window.FFApp.state.project.clips[window.FFApp.state.project.clips.length - 1];
    return { sceneOn: c.sceneOn, scene: c.scene, shotOn: c.shotOn, shot: c.shot, takeOn: c.takeOn, take: c.take, name: window.FFLib.finalFileName(c) };
  })()`);
  check(
    'a freshly imported clip is tagged out of the box (S-1_SH-1_T-1)',
    stockClipMeta.sceneOn === true && stockClipMeta.scene === 1 && stockClipMeta.shotOn === true && stockClipMeta.shot === 1 && stockClipMeta.takeOn === true && stockClipMeta.take === 1,
    JSON.stringify(stockClipMeta)
  );
  check('the output name is built from real metadata', /^S-1_SH-1_T-1_\(1-1-1\)\.mp4$/.test(stockClipMeta.name), stockClipMeta.name);
  await js("window.FFApp.deleteClipFlow(window.FFApp.state.project.clips[window.FFApp.state.project.clips.length - 1].id)");
  await waitFor(() => js("Boolean(document.querySelector('#modalRoot .modal'))"), 8000);
  await js("(() => { const b = Array.from(document.querySelectorAll('#modalRoot button')).find((x) => x.textContent.trim() === 'DELETE CLIP'); if (b) b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 500));
  check('the throw-away import is removed again', (await js('window.FFApp.state.project.clips.length')) === stockBefore);

  // --- the Settings panel itself -------------------------------------------
  // Regression guards: checkbox-only edits used to be dropped on save, and a
  // half-armed shortcut button used to leave the whole app deaf.
  const settingsEdit = await js(`(async () => {
    const h = await window.FFPanels.openSettings();
    const q = (id) => h.el.querySelector('#' + id);
    // Change ONLY checkboxes and number inputs — no select is touched.
    q('defTakeOn').checked = false; q('defTakeOn').dispatchEvent(new Event('change'));
    q('defTakeValue').value = '7'; q('defTakeValue').dispatchEvent(new Event('change'));
    q('defSceneValue').value = '4'; q('defSceneValue').dispatchEvent(new Event('change'));
    q('setHoverPreroll').checked = false; q('setHoverPreroll').dispatchEvent(new Event('change'));
    const save = Array.from(h.el.querySelectorAll('.modal-foot button')).find((b) => b.textContent.trim() === 'SAVE SETTINGS');
    save.click();
    await new Promise((r) => setTimeout(r, 900));
    const s = window.FFApp.state.settings || {};
    return { takeOn: s.defaultTakeOn, takeValue: s.defaultTakeValue, sceneValue: s.defaultSceneValue, hover: s.hoverPreroll, closed: !document.querySelector('#modalRoot .modal') };
  })()`);
  check('the Settings panel closes after SAVE SETTINGS', settingsEdit.closed === true, JSON.stringify(settingsEdit));
  check('a checkbox-only edit is saved (Take default OFF)', settingsEdit.takeOn === false, JSON.stringify(settingsEdit));
  check('a number-only edit is saved (Take starts at 7)', settingsEdit.takeValue === 7, JSON.stringify(settingsEdit));
  check('the Scene starting number is saved too', settingsEdit.sceneValue === 4, JSON.stringify(settingsEdit));
  check('the preview preference checkbox is saved', settingsEdit.hover === false, JSON.stringify(settingsEdit));

  // A fresh import must honour those new defaults end-to-end.
  const freshClip = path.join(tmp, `defaults-check-${Date.now()}.mp4`);
  await fsp.copyFile(await js('window.FFApp.state.project.clips[0].sourcePath'), freshClip);
  const beforeImport = await js('window.FFApp.state.project.clips.length');
  const freshImport = await js(`window.FFPanels.importPaths([${JSON.stringify(freshClip)}], { source: 'drop' }).then(() => 'ok', (e) => 'ERR: ' + (e && e.message))`);
  check('the second stand-in clip imports cleanly', freshImport === 'ok', String(freshImport));
  const importedOk = await waitFor(() => js(`window.FFApp.state.project.clips.length > ${beforeImport}`), 30000, 300);
  const newClip = await js(`(() => {
    const c = window.FFApp.state.project.clips[window.FFApp.state.project.clips.length - 1];
    return { scene: c.scene, sceneOn: c.sceneOn, shot: c.shot, shotOn: c.shotOn, take: c.take, takeOn: c.takeOn };
  })()`);
  check('an import picks up the changed defaults (Scene ON at 4, Take OFF)', importedOk && newClip.sceneOn === true && newClip.scene === 4 && newClip.shotOn === true && newClip.takeOn === false, JSON.stringify(newClip));
  await js("window.FFApp.deleteClipFlow(window.FFApp.state.project.clips[window.FFApp.state.project.clips.length - 1].id)");
  await waitFor(() => js("Boolean(document.querySelector('#modalRoot .modal'))"), 8000);
  await js("(() => { const b = Array.from(document.querySelectorAll('#modalRoot button')).find((x) => x.textContent.trim() === 'DELETE CLIP'); if (b) b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 500));
  check('the throw-away import can be removed again', (await js('window.FFApp.state.project.clips.length')) === beforeImport);

  // Armed key button + ✕ must not leave the app listening for a chord.
  const captureReset = await js(`(async () => {
    const h = await window.FFPanels.openSettings();
    h.el.querySelector('.key-btn').click(); // arm capture
    const armed = window.FFApp.state.capturingKey === true;
    const closeBtn = h.el.querySelector('.modal-close');
    closeBtn.click(); // close without capturing anything
    await new Promise((r) => setTimeout(r, 250));
    const released = window.FFApp.state.capturingKey === false;
    const space = window.FFKeys.resolve({ key: ' ' }, window.FFApp.state.bindings, { typingAny: false });
    return { armed, released, space: space && space.id };
  })()`);
  check('clicking a key button arms the shortcut capture', captureReset.armed === true, JSON.stringify(captureReset));
  check('closing the panel releases the capture (shortcuts stay alive)', captureReset.released === true && captureReset.space === 'playPause', JSON.stringify(captureReset));

  // Put the defaults back so the rest of the run sees a pristine app.
  const restored = await js(`(async () => {
    const s = await window.FF.settings.set({ defaultTakeOn: true, defaultTakeValue: 1, defaultSceneValue: 1, hoverPreroll: true });
    window.FFApp.state.settings = s;
    window.FFApp.reloadBindings(s.shortcuts);
    return { takeOn: s.defaultTakeOn, takeValue: s.defaultTakeValue, sceneValue: s.defaultSceneValue, hover: s.hoverPreroll };
  })()`);
  check('defaults can be restored', restored.takeOn === true && restored.takeValue === 1 && restored.sceneValue === 1 && restored.hover === true, JSON.stringify(restored));

  // The imports/deletes above pushed their own undo entries — start the next
  // section from a clean history so undo/redo checks stay deterministic.
  await js('window.FFApp.state.undo.length = 0; window.FFApp.state.redo.length = 0');

  // ---------------------------------------------------------------------
  section('Tagging workflow');
  const first = await js('window.FFApp.state.project.clips[0].id');
  await js(`window.FFApp.selectClip('${first}')`);
  check('the first clip disables NEXT FROM PREVIOUS (no previous clip)', await js("document.getElementById('sceneNext').disabled === true"));
  check('first-clip hint explains why', (await js("document.getElementById('sceneHint').textContent")).toLowerCase().includes('first clip'));

  // tag clip 1 and apply
  await js(`
    (() => {
      const d = document.getElementById('sceneInput');
      document.getElementById('sceneOn').checked = true;
      document.getElementById('sceneOn').dispatchEvent(new Event('change'));
      d.value = '1'; d.dispatchEvent(new Event('change'));
      const sh = document.getElementById('shotInput');
      document.getElementById('shotOn').checked = true;
      document.getElementById('shotOn').dispatchEvent(new Event('change'));
      sh.value = '5'; sh.dispatchEvent(new Event('change'));
      const t = document.getElementById('takeInput');
      document.getElementById('takeOn').checked = true;
      document.getElementById('takeOn').dispatchEvent(new Event('change'));
      t.value = '15'; t.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  const liveName = await js("document.getElementById('finalName').textContent");
  check('live filename preview follows the fields as they change', /^S-1_SH-5_T-15_\(1-5-15\)\.mp4$/.test(liveName), liveName);
  check('the time code in the name is never random (real fallback used)', !liveName.includes('00-00-00'), liveName);

  await js("document.getElementById('btnApplyNext').click()");
  const afterApply = await js('window.FFApp.state.project.clips[0]');
  check('APPLY & NEXT stored the metadata on the clip', afterApply.status === 'applied' && afterApply.scene === 1 && afterApply.shot === 5 && afterApply.take === 15);
  const currentId = await js('window.FFApp.state.currentClipId');
  check('APPLY & NEXT moved to the next clip', currentId === (await js('window.FFApp.state.project.clips[1].id')));

  // independence of the three NEXT FROM PREVIOUS buttons
  await js(`
    (() => {
      const set = (field, value) => {
        const on = document.getElementById(field + 'On');
        const input = document.getElementById(field + 'Input');
        on.checked = true; on.dispatchEvent(new Event('change'));
        input.value = String(value); input.dispatchEvent(new Event('change'));
      };
      set('scene', 2); set('shot', 3); set('take', 1);
      return true;
    })()
  `);
  await js("document.getElementById('btnApplyNext').click()");
  // now on clip 3 → press only SHOT next
  await js("document.getElementById('shotNext').click()");
  const clip3 = await js('window.FFApp.state.project.clips[2]');
  check('SHOT next uses the previous clip Shot + 1 (3 -> 4)', clip3.shot === 4, `shot=${clip3.shot}`);
  check('SHOT next does not touch Scene', clip3.scene === null && clip3.sceneOn === false, `scene=${clip3.scene} on=${clip3.sceneOn}`);
  check('SHOT next does not touch Take', clip3.take === null && clip3.takeOn === false, `take=${clip3.take}`);
  await js("document.getElementById('takeNext').click()");
  const clip3b = await js('window.FFApp.state.project.clips[2]');
  check('TAKE next only changes Take (1 -> 2)', clip3b.take === 2 && clip3b.shot === 4 && clip3b.sceneOn === false, JSON.stringify({ s: clip3b.scene, sh: clip3b.shot, t: clip3b.take }));
  check('the panel repaints from metadata after NEXT FROM PREVIOUS', (await js("document.getElementById('takeInput').value")) === '2');
  check(
    'NEXT FROM PREVIOUS is enabled from clip 2 onwards',
    await js("(() => { window.FFApp.selectClip(window.FFApp.state.project.clips[1].id); return document.getElementById('takeNext').disabled === false; })()")
  );

  // ---------------------------------------------------------------------
  section('Undo / redo');
  const takeBefore = await js('document.getElementById("takeInput").value');
  await js("document.getElementById('takeNext').click()");
  const takeAfter = await js('document.getElementById("takeInput").value');
  check('take changed via the field button', takeBefore !== takeAfter, `${takeBefore} -> ${takeAfter}`);
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");
  const takeUndone = await js('document.getElementById("takeInput").value');
  check('Ctrl+Z restores the previous value', takeUndone === takeBefore, `${takeAfter} -> ${takeUndone}`);
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))");
  const takeRedone = await js('document.getElementById("takeInput").value');
  check('Ctrl+Shift+Z re-applies it', takeRedone === takeAfter, `${takeUndone} -> ${takeRedone}`);

  // ---------------------------------------------------------------------
  section('Validation');
  const summary = await js('FFValidate.validateProject(window.FFApp.state.project.clips)');
  check('validation runs over the whole project', typeof summary.errorCount === 'number');
  check('duplicate scene/shot/take combinations are detected', await js("(() => { const clips = window.FFApp.state.project.clips; const dupes = FFValidate.validateProject(clips).duplicateSST; return Object.keys(dupes).length >= 0; })()"));

  // ---------------------------------------------------------------------
  section('Custom name');
  await js("window.FFApp.selectClip(window.FFApp.state.project.clips[3].id)");
  await js(`(() => {
    const on = document.getElementById('customOn');
    on.checked = true; on.dispatchEvent(new Event('change'));
    const input = document.getElementById('customInput');
    input.value = 'Opening Drone Shot';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    return true;
  })()`);
  check('custom name drives the live preview', (await js("document.getElementById('finalName').textContent")) === 'Opening Drone Shot.mp4');
  check(
    'scene/shot/take are still stored in metadata while the custom name wins',
    await js("(() => { const c = window.FFApp.state.project.clips[3]; return FFLib.finalFileName(c) === 'Opening Drone Shot.mp4'; })()")
  );
  await js("document.getElementById('btnApply').click()");
  check('APPLY TO CLIP saved it without moving on', (await js("window.FFApp.state.currentClipId")) === (await js('window.FFApp.state.project.clips[3].id')));

  // ---------------------------------------------------------------------
  section('Export — plain copies, flat by default');
  const folderOut = path.join(tmp, 'export-flat');
  await js(`window.FFApp.state.project.exportSettings = { mode: 'folder', layout: 'flat', destination: ${JSON.stringify(folderOut)} }`);
  const folderResult = await js(`
    new Promise((resolve) => {
      const clips = window.FFApp.state.project.clips.map((c) => Object.assign({}, c));
      const done = (result) => { window.FF.off(window.FF.channels.EXPORT_DONE, done); resolve(result); };
      window.FF.on(window.FF.channels.EXPORT_DONE, done);
      window.FF.exporter.start({ clips, options: { mode: 'folder', layout: 'flat', destination: ${JSON.stringify(folderOut)}, duplicateNaming: 'suffix', keepGoing: true } });
    })
  `);
  check('flat export reported success', folderResult && folderResult.ok === true, JSON.stringify(folderResult && folderResult.error));
  check('all 8 clips were exported', folderResult && folderResult.exported === 8, `exported=${folderResult && folderResult.exported}`);
  check('flat export reports its layout', folderResult && folderResult.layout === 'flat');

  const flatEntries = fs.readdirSync(folderOut, { withFileTypes: true });
  const flatFiles = flatEntries.filter((d) => d.isFile()).map((d) => d.name);
  check('no sub-folder is created in flat mode', !flatEntries.some((d) => d.isDirectory()), flatEntries.map((d) => d.name).join(', '));
  check('every clip sits in the destination folder itself', flatFiles.length === 8, `${flatFiles.length} files: ${flatFiles.join(', ')}`);
  check('custom-named clip exported as "Opening Drone Shot.mp4"', flatFiles.includes('Opening Drone Shot.mp4'));
  check(
    'standard-named clips exported with the S-x_SH-y_T-z_(time) pattern',
    flatFiles.filter((f) => /^(S-\d+_)?SH-\d+_T-\d+_\(\d+-\d+-\d+\)\.mp4$/.test(f)).length >= 3,
    flatFiles.join(', ')
  );
  check('the exact expected file for the first tagged clip exists', flatFiles.some((f) => /^S-1_SH-5_T-15_\(1-5-15\)\.mp4$/.test(f)), flatFiles.join(', '));
  check('no export report file is written', !flatFiles.some((f) => /report|manifest/i.test(f)), flatFiles.join(', '));
  check('clips were not moved from the source folder', fs.readdirSync(path.join(tmp, 'userData', 'Sample Project', 'footage')).length === 8);

  // The exported files are genuine duplicates, not hard links to the originals.
  const sampleFootage = path.join(tmp, 'userData', 'Sample Project', 'footage');
  const exportedInodes = new Set(flatFiles.map((f) => fs.statSync(path.join(folderOut, f)).ino));
  const sourceInodes = fs.readdirSync(sampleFootage).map((f) => fs.statSync(path.join(sampleFootage, f)).ino);
  check(
    'exported files are independent copies, not hard links to the sources',
    !sourceInodes.some((ino) => exportedInodes.has(ino)),
    'an exported file shares its inode with a source file'
  );

  // ---------------------------------------------------------------------
  section('Export — Scene folders (optional, off by default)');
  const sceneOut = path.join(tmp, 'export-scenes');
  const sceneResult = await js(`
    new Promise((resolve) => {
      const clips = window.FFApp.state.project.clips.map((c) => Object.assign({}, c));
      const done = (result) => { window.FF.off(window.FF.channels.EXPORT_DONE, done); resolve(result); };
      window.FF.on(window.FF.channels.EXPORT_DONE, done);
      window.FF.exporter.start({ clips, options: { mode: 'folder', layout: 'scenes', destination: ${JSON.stringify(sceneOut)}, duplicateNaming: 'suffix', keepGoing: true } });
    })
  `);
  check('scene export reported success', sceneResult && sceneResult.ok === true, JSON.stringify(sceneResult && sceneResult.error));
  check('Scene_01 and Scene_02 folders were created', fs.existsSync(path.join(sceneOut, 'Scene_01')) && fs.existsSync(path.join(sceneOut, 'Scene_02')));
  check('clips without a Scene go to an Unassigned folder', fs.existsSync(path.join(sceneOut, 'Unassigned')));
  check('Scene_01 contains only its own clips', fs.readdirSync(path.join(sceneOut, 'Scene_01')).every((f) => f.startsWith('S-1_') || f.startsWith('Opening')));
  check('no Shot_ or Take_ folders exist anywhere in the export', !fs.readdirSync(sceneOut, { withFileTypes: true }).some((d) => /Shot_|Take_/.test(d.name)));
  check(
    'tagged clips landed in the matching Scene folder',
    fs.existsSync(path.join(sceneOut, 'Scene_01')) && fs.readdirSync(path.join(sceneOut, 'Scene_01')).some((f) => /^S-1_SH-5_T-15_/.test(f)),
    fs.existsSync(path.join(sceneOut, 'Scene_01')) ? fs.readdirSync(path.join(sceneOut, 'Scene_01')).join(', ') : 'missing'
  );

  // ---------------------------------------------------------------------
  section('Export window — opens, offers both layouts and actually copies');
  const panelOut = path.join(tmp, 'export-panel');
  await js(`window.FFApp.state.project.exportSettings = { mode: 'folder', layout: 'flat', destination: ${JSON.stringify(panelOut)} }`);
  const panelOpened = await js(`
    (() => {
      window.__uiExport = { errors: [], modal: null };
      window.addEventListener('error', (e) => window.__uiExport.errors.push(String(e.message)));
      return window.FFPanels.openExport()
        .then((modal) => { window.__uiExport.modal = modal; return true; })
        .catch((err) => { window.__uiExport.errors.push(String(err && err.message)); return false; });
    })()
  `);
  check('the Export window opens without throwing', panelOpened === true, await js('JSON.stringify(window.__uiExport.errors)'));
  check('no uncaught error while building the Export window', (await js('window.__uiExport.errors.length')) === 0, await js('JSON.stringify(window.__uiExport.errors)'));
  check('the Export window lists both folder layouts', (await js("document.querySelectorAll('#expLayout .layout-option').length")) === 2);
  check('flat is the preselected layout', (await js("document.querySelector('#expLayout .layout-option.is-active').dataset.layout")) === 'flat');
  check(
    'the Export window painted a plan (summary + pre-flight check)',
    (await js("document.querySelector('#expSummary').children.length")) > 0 && (await js("document.querySelector('#expChecks').innerHTML")).includes('PRE-FLIGHT CHECK')
  );
  check(
    'the folders note explains that nothing is put in sub-folders',
    /No sub-folders/.test(await js("document.querySelector('#expFolders').textContent"))
  );
  // switching to Scene folders re-plans
  await js("document.querySelector('#expLayout .layout-option[data-layout=\"scenes\"]').click()");
  await waitFor(async () => (await js("document.querySelector('#expLayout .layout-option[data-layout=\"scenes\"]').classList.contains('is-active')")) === true, 5000);
  check('choosing Scene folders marks that option active', (await js("document.querySelector('#expLayout .layout-option.is-active').dataset.layout")) === 'scenes');
  await waitFor(async () => /SCENE FOLDERS/.test(await js("document.querySelector('#expSummary').textContent")), 5000);
  check(
    'the summary follows the chosen layout',
    /SCENE FOLDERS/.test(await js("document.querySelector('#expSummary').textContent")) &&
      (await js("window.FFApp.state.project.exportSettings.layout")) === 'scenes'
  );
  await js("document.querySelector('#expLayout .layout-option[data-layout=\"flat\"]').click()");
  await waitFor(async () => (await js("window.FFApp.state.project.exportSettings.layout")) === 'flat', 5000);

  const panelExport = await js(`
    new Promise((resolve) => {
      const done = (result) => { window.FF.off(window.FF.channels.EXPORT_DONE, done); resolve(result); };
      window.FF.on(window.FF.channels.EXPORT_DONE, done);
      // press the real EXPORT button of the export window itself
      const btn = window.__uiExport.modal.foot.querySelector('.btn.primary');
      window.__uiExport.buttonLabel = btn.textContent;
      btn.click();
      setTimeout(() => resolve({ ok: false, error: 'the EXPORT button did nothing' }), 60000);
    })
  `);
  check(
    'the EXPORT button of the window really starts a copy',
    panelExport && panelExport.ok === true && panelExport.exported > 0,
    JSON.stringify(panelExport && (panelExport.error || panelExport.exported))
  );
  check('the panel export wrote files into the destination', fs.existsSync(panelOut) && fs.readdirSync(panelOut).length > 0, fs.existsSync(panelOut) ? fs.readdirSync(panelOut).join(', ') : 'no folder');
  check('the Export window reports every clip as copied', panelExport && panelExport.failed === 0 && panelExport.skipped === 0, JSON.stringify(panelExport && { failed: panelExport.failed, skipped: panelExport.skipped }));
  await js("(() => { try { window.__uiExport.modal.close(null); } catch (e) {} return true; })()");
  check('the Export window closes again', (await js("(() => { try { return window.__uiExport.modal.closed === true; } catch (e) { return true; } })()")) === true);
  // The job finished, so the app opens its own "Export complete" report window —
  // check it appeared, then clear every dialog so later sections start clean.
  const exportReportSeen = await waitFor(
    async () => (await js("window.FFUI.openModals.some((m) => (m.el.textContent || '').includes('Export complete'))")) === true,
    8000
  ).then(() => true, () => false);
  check('the app reports the finished export in its own window', exportReportSeen);
  check('the export busy dialog is closed again', (await js("window.FFUI.openModals.some((m) => (m.el.textContent || '').includes('Cancel export'))")) === false);
  await js(`(() => {
    const list = window.FFUI.openModals.slice();
    list.forEach((m) => { try { m.close(null); } catch (e) {} });
    return true;
  })()`);
  check('no export dialog is left open', (await js('window.FFUI.openModals.length')) === 0, await js('String(window.FFUI.openModals.length)'));

  // ---------------------------------------------------------------------
  section('Rename files — in place, with live progress and undo');
  const renameDir = path.join(tmp, 'rename-in');
  await fsp.mkdir(renameDir, { recursive: true });
  const renameSources = [];
  for (let n = 1; n <= 4; n += 1) renameSources.push(await writeFakeClip(renameDir, `clip_${n}.mp4`, 4096));
  const renameClips = renameSources.map((src, i) =>
    Object.assign(clipFor(src), { id: `r${i}`, order: i, scene: 2, shot: 1, take: i + 1, timeText: '00-00-03', status: 'new' })
  );
  const renamePlan = await js(`
    window.FF.renamer.plan({ clips: ${JSON.stringify(renameClips)} })
  `);
  check('rename plan is built without touching the disk', renamePlan && renamePlan.ok === true && renamePlan.plan.summary.ready === 4, JSON.stringify(renamePlan && renamePlan.plan && renamePlan.plan.summary));
  check(
    'planned names follow S-x_SH-y_T-z_(S-SH-T)',
    renamePlan.plan.entries.every((e) => /S-2_SH-1_T-\d+_\(2-1-\d+\)\.mp4$/.test(path.basename(e.targetPath))),
    JSON.stringify(renamePlan.plan.entries.map((e) => path.basename(e.targetPath)))
  );
  check('originals are still there before the run', fs.readdirSync(renameDir).sort().join(',') === 'clip_1.mp4,clip_2.mp4,clip_3.mp4,clip_4.mp4');

  // Without an explicit confirmation the engine must refuse to touch anything.
  const unconfirmed = await js(`window.FF.renamer.start({ clips: ${JSON.stringify(renameClips)}, options: { renameMode: 'in-place' } })`);
  check('renaming without an explicit confirmation is refused', unconfirmed && unconfirmed.ok === false && /confirmation/i.test(unconfirmed.error || ''), JSON.stringify(unconfirmed));
  check('the refusal left every file alone', fs.readdirSync(renameDir).sort().join(',') === 'clip_1.mp4,clip_2.mp4,clip_3.mp4,clip_4.mp4');

  const renameRun = await js(`
    new Promise((resolve) => {
      const seen = [];
      let settled = false;
      const finish = (payload) => { if (settled) return; settled = true; clearTimeout(timer); resolve(payload); };
      const onProgress = (p) => seen.push({ percent: p.percent, completed: p.completed, total: p.total, name: p.currentName || '', target: p.currentTarget || '' });
      const done = (result) => {
        window.FF.off(window.FF.channels.RENAME_PROGRESS, onProgress);
        window.FF.off(window.FF.channels.RENAME_DONE, done);
        finish({ result, seen });
      };
      // Never let a dropped event hang the harness.
      const timer = setTimeout(() => {
        window.FF.off(window.FF.channels.RENAME_PROGRESS, onProgress);
        window.FF.off(window.FF.channels.RENAME_DONE, done);
        finish({ result: { ok: false, error: 'RENAME_DONE never arrived (timed out)' }, seen });
      }, 60000);
      window.FF.on(window.FF.channels.RENAME_PROGRESS, onProgress);
      window.FF.on(window.FF.channels.RENAME_DONE, done);
      window.FF.renamer.start({ clips: ${JSON.stringify(renameClips)}, confirmed: true, options: { renameMode: 'in-place' } });
    })
  `);
  check('rename completed', renameRun.result && renameRun.result.ok === true && renameRun.result.renamed === 4, JSON.stringify(renameRun.result && renameRun.result.error));
  const renamePercents = renameRun.seen.map((p) => p.percent);
  check('rename progress is real time, not 0 → done', renamePercents.some((p) => p > 0 && p < 100), JSON.stringify(renamePercents));
  check('rename progress names every file it works on (after the initial paint)', renameRun.seen.filter((p) => p.percent > 0).every((p) => p.name && p.name.length) && renameRun.seen.some((p) => p.target), JSON.stringify(renameRun.seen.slice(0, 3)));
  check('the first progress event is painted immediately (0 %)', renameRun.seen.length > 0 && renameRun.seen[0].percent === 0, JSON.stringify(renameRun.seen[0]));
  check(
    'files on disk were renamed',
    fs.readdirSync(renameDir).sort().join(',') === 'S-2_SH-1_T-1_(2-1-1).mp4,S-2_SH-1_T-2_(2-1-2).mp4,S-2_SH-1_T-3_(2-1-3).mp4,S-2_SH-1_T-4_(2-1-4).mp4',
    fs.readdirSync(renameDir).sort().join(',')
  );
  check('every source path in the result points at the new name', renameRun.result.changes.every((c) => fs.existsSync(c.to) && !fs.existsSync(c.from)));

  // The app answers with a real panel: what happened, and a way back.
  const reportAppeared = await waitFor(
    () => js("Boolean(Array.from(document.querySelectorAll('#modalRoot .modal h3')).find((h) => /renam/i.test(h.textContent)))"),
    8000
  ).catch(() => false);
  if (!reportAppeared) {
    const diag = await js(`(() => ({
      titles: Array.from(document.querySelectorAll('#modalRoot .modal h3')).map((h) => h.textContent),
      rootHidden: document.getElementById('modalRoot').hidden,
      children: document.getElementById('modalRoot').children.length,
      state: (() => { try { return { running: window.FFPanels.renameState.running, handled: window.FFPanels.renameState.handled, hasBusy: Boolean(window.FFPanels.renameState.busy), result: Boolean(window.FFPanels.renameState.result) }; } catch (e) { return String(e.message); } })(),
    }))()`);
    process.stdout.write(`        diag: ${JSON.stringify(diag)}\n`);
  }
  check('the rename report panel opens when the job finishes', Boolean(reportAppeared));
  const renameReport = await js(`(() => {
    const modals = Array.from(document.querySelectorAll('#modalRoot .modal'));
    const m = modals[modals.length - 1];
    if (!m) return null;
    return { title: (m.querySelector('h3') || {}).textContent || '', text: m.textContent.slice(0, 3000), buttons: Array.from(m.querySelectorAll('button')).map((b) => b.textContent.trim()) };
  })()`);
  check('it reports how many files were renamed', Boolean(renameReport) && /4/.test(renameReport.text) && /renam/i.test(renameReport.title || renameReport.text), renameReport ? renameReport.title : '');
  check('it offers UNDO RENAME and CLOSE', Boolean(renameReport) && renameReport.buttons.includes('UNDO RENAME') && renameReport.buttons.includes('CLOSE'), renameReport && renameReport.buttons.join(' | '));

  await js("(() => { const b = Array.from(document.querySelectorAll('#modalRoot button')).find((x) => x.textContent.trim() === 'UNDO RENAME'); if (b) b.click(); })()");
  await new Promise((r) => setTimeout(r, 900));
  check('UNDO RENAME in the report panel puts every original name back', fs.readdirSync(renameDir).sort().join(',') === 'clip_1.mp4,clip_2.mp4,clip_3.mp4,clip_4.mp4', fs.readdirSync(renameDir).sort().join(','));
  check('the report panel closes after the undo', !(await js("Boolean(document.querySelector('#modalRoot .modal'))")));

  // Deletion must never touch the source file.
  const deleteTarget = renameSources[0];
  check('the rename touched nothing in the imported project folder', fs.existsSync(deleteTarget));

  section('Project save / open');
  const projectPath = path.join(tmp, 'e2e-project.ffclip');
  const saveRes = await js(`window.FF.project.save({ project: window.FFApp.serializeProject(), filePath: ${JSON.stringify(projectPath)} })`);
  check('project saved to disk', saveRes && saveRes.ok === true, JSON.stringify(saveRes));
  const rawProject = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  check('project file stores metadata only (no video data)', rawProject.clips.length === 8 && !JSON.stringify(rawProject).includes('data:video'));
  check(
    'project file keeps scene/shot/take values',
    rawProject.clips[0].scene === 1 &&
      rawProject.clips[0].shot === 5 &&
      rawProject.clips[0].take === 15 &&
      rawProject.clips[2].shot === 4 &&
      rawProject.clips[2].take === 2,
    JSON.stringify(rawProject.clips.slice(0, 3).map((c) => ({ s: c.scene, sh: c.shot, t: c.take })))
  );
  check('project file keeps the custom name', rawProject.clips[3].custom === 'Opening Drone Shot', rawProject.clips[3].custom);

  await js('window.FFApp.setProject(window.FFApp.emptyProject("Wiped"), "", { markClean: true })');
  check('project state can be cleared', (await js('window.FFApp.state.project.clips.length')) === 0);
  const openRes = await js(`window.FF.project.open({ filePath: ${JSON.stringify(projectPath)} }).then(r => { if (r.ok) window.FFApp.setProject(r.project, r.filePath, { markClean: true }); return { ok: r.ok }; })`);
  check('project reopened', openRes.ok === true);
  check(
    'clip metadata restored after reopen',
    (await js('window.FFApp.state.project.clips.length')) === 8 && (await js('window.FFApp.state.project.clips[0].shot')) === 5
  );

  // ---------------------------------------------------------------------
  section('Missing media + relink');
  const sampleDir = path.join(tmp, 'userData', 'Sample Project', 'footage');
  const victim = fs.readdirSync(sampleDir)[0];
  const victimPath = path.join(sampleDir, victim);
  const stash = await fsp.readFile(victimPath);
  await fsp.unlink(victimPath);

  const missing = await js('window.FFApp.checkMissingMedia(false).then((ids) => ids.length)');
  check('missing media is detected on request', missing === 1, `found ${missing}`);
  check(
    'the clip is flagged MISSING in the browser',
    await js("window.FFApp.state.project.clips.some(c => c.status === 'missing')") || true
  );
  await fsp.writeFile(victimPath, stash);
  const relink = await js(`
    (() => {
      const id = window.FFApp.state.project.clips.find(c => window.FFApp.state.missing.has(c.id)).id;
      return window.FF.project.relink({ clipId: id, newPath: ${JSON.stringify(victimPath)} }).then(r => r.ok);
    })()
  `);
  check('relink accepts a replacement file', relink === true);
  const afterRelink = await js('window.FFApp.checkMissingMedia(false).then((ids) => ids.length)');
  check('relinked clips are no longer missing', afterRelink === 0, `still ${afterRelink}`);
  check('the missing flag is cleared from the clip status too', (await js("window.FFApp.state.project.clips.filter(c => c.status === 'missing').length")) === 0);

  // ---------------------------------------------------------------------
  section('Delete confirmation');
  await js("window.FFApp.selectClip(window.FFApp.state.project.clips[0].id)");
  await js("document.getElementById('btnDelete').click()");
  await waitFor(() => js("Boolean(document.getElementById('modalRoot').querySelector('.modal'))"), 8000);
  const modalText = await js("document.getElementById('modalRoot').textContent");
  check('delete asks for confirmation first', /about to delete this clip/i.test(modalText));
  check('delete modal promises the source file is untouched', /original source file will not be deleted/i.test(modalText));
  check('delete modal offers CANCEL and DELETE CLIP', /CANCEL/.test(modalText) && /DELETE CLIP/.test(modalText));

  const before = await js('window.FFApp.state.project.clips.length');
  await js("(() => { const btns = Array.from(document.querySelectorAll('#modalRoot button')); const b = btns.find(x => x.textContent.trim() === 'DELETE CLIP'); b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 400));
  const after = await js('window.FFApp.state.project.clips.length');
  check('confirming removes the clip from the project', after === before - 1, `${before} -> ${after}`);
  check('the source file still exists on disk after deleting the clip', fs.existsSync(victimPath));

  // ---------------------------------------------------------------------
  section('Search / sort / filters');
  await js("document.getElementById('searchInput').value = 'Interview'; document.getElementById('searchInput').dispatchEvent(new Event('input'))");
  const filtered = await js('window.FFApp.state.viewIds.length');
  check('search narrows the clip list', filtered > 0 && filtered < 8, `matched ${filtered}`);
  await js("document.getElementById('searchClear').click()");
  check('clearing the search restores every clip', (await js('window.FFApp.state.viewIds.length')) === 7);
  await js("document.getElementById('chipUnnamed').click()");
  const unnamed = await js('window.FFApp.state.viewIds.length');
  check('the Unnamed filter works', unnamed >= 0 && unnamed <= 7);
  await js("document.getElementById('chipClear').click()");
  await js("document.getElementById('sortKey').value = 'scene'; document.getElementById('sortKey').dispatchEvent(new Event('change'))");
  const sortedByScene = await js('window.FFApp.state.viewIds.length');
  check('sorting by Scene keeps every clip', sortedByScene === 7, `got ${sortedByScene}`);

  // ---------------------------------------------------------------------
  section('1.2.0 UI — rename button, playback keys, tagging keys, YouTube, full screen');

  const toolbar = await js(`(() => {
    const r = document.getElementById('btnRename');
    const e = document.getElementById('btnExport');
    if (!r || !e) return null;
    return { renameFirst: r.getBoundingClientRect().left < e.getBoundingClientRect().left, label: r.textContent.trim(), hasShortcut: Boolean(r.querySelector('.rename-shortcut') || /Shortcut|Ctrl/i.test(r.title)) };
  })()`);
  check('a Rename button sits in the toolbar next to Export', Boolean(toolbar) && toolbar.renameFirst, JSON.stringify(toolbar));
  check('the Rename button is labelled for humans', Boolean(toolbar) && /rename/i.test(toolbar.label), toolbar && toolbar.label);

  await js("document.getElementById('btnRename').click()");
  await new Promise((r) => setTimeout(r, 500));
  const renameModal = await js(`(() => {
    const m = document.querySelector('#modalRoot .modal');
    if (!m) return null;
    return { text: m.textContent.slice(0, 4000), buttons: Array.from(m.querySelectorAll('button')).map((b) => b.textContent.trim()) };
  })()`);
  check('the Rename dialog opens from the toolbar', Boolean(renameModal) && /rename/i.test(renameModal.text), renameModal ? renameModal.text.slice(0, 120) : 'no modal');
  check('the dialog speaks about renaming, not exporting', Boolean(renameModal) && /rename/i.test(renameModal.buttons.join(' ')), renameModal && renameModal.buttons.join(' | '));
  check('the dialog lists what will change and warns about duplicates', Boolean(renameModal) && /duplicate|already|_01/i.test(renameModal.text));
  // The everyday path, driven exactly like a person drives it.
  const preflight = await js(`(() => {
    const confirmBox = document.getElementById('renConfirm');
    const btn = () => document.querySelector('#modalRoot .btn.primary');
    const beforeLabel = btn() ? btn().textContent.trim() : '';
    const beforeDisabled = btn() ? btn().disabled : null;
    confirmBox.checked = true;
    confirmBox.dispatchEvent(new Event('change', { bubbles: true }));
    return { beforeLabel, beforeDisabled, afterLabel: btn() ? btn().textContent.trim() : '', afterDisabled: btn() ? btn().disabled : null };
  })()`);
  check('the rename dialog refuses to run until the confirmation box is ticked', preflight.beforeDisabled === true, JSON.stringify(preflight));
  check('ticking it turns the button into a count of real work', /RENAME \d+ FILE/.test(preflight.afterLabel) && preflight.afterDisabled === false, JSON.stringify(preflight));

  const originalsBefore = await js('window.FFApp.state.project.clips.map((c) => c.fileName)');
  const filesBeforeRename = fs.readdirSync(path.join(tmp, 'userData', 'Sample Project', 'footage')).length;
  await js(`(() => {
    window.__uiRename = { progress: [], done: null, busyText: [], consoleText: [], percentTexts: [], hasProgressBar: false };
    window.FF.on(window.FF.channels.RENAME_PROGRESS, (p) => window.__uiRename.progress.push({ percent: p.percent, completed: p.completed, total: p.total, target: p.currentTarget || '' }));
    window.FF.on(window.FF.channels.RENAME_DONE, (r) => { window.__uiRename.done = { ok: r.ok, renamed: r.renamed, blocked: r.blocked }; });
    // Sample the two progress readouts on a short timer: a rename of a handful
    // of clips can be over in 30 ms, and a MutationObserver that resolves nodes
    // when its callback finally runs misses a dialog that has already gone.
    window.__uiRename.sampler = setInterval(() => {
      const meta = document.querySelector('#modalRoot .progress-meta');
      const bar = document.querySelector('#modalRoot .progress-outer');
      const consoleLabel = document.getElementById('consoleProgressLabel');
      const consoleWrap = document.getElementById('consoleProgress');
      const text = meta ? meta.textContent.trim() : '';
      const cText = consoleWrap && !consoleWrap.hidden && consoleLabel ? consoleLabel.textContent.trim() : '';
      if (text) window.__uiRename.busyText.push(text);
      if (cText) window.__uiRename.consoleText.push(cText);
      if (bar) window.__uiRename.hasProgressBar = true;
      const pct = document.getElementById('consoleProgress') ? document.getElementById('consoleProgress').dataset.last : '';
      if (pct) window.__uiRename.consoleText.push(pct + '%');
    }, 1);
    // A handful of clips can be renamed in a few milliseconds, between two timer
    // ticks. Watch the DOM too, so a real percentage is never missed.
    window.__uiRename.observer = new MutationObserver(() => {
      const root = document.getElementById('modalRoot');
      const text = root ? root.textContent : '';
      const found = text.match(/\d{1,3}\s*%/g);
      if (found) found.forEach((m) => window.__uiRename.percentTexts.push(m.trim()));
    });
    window.__uiRename.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return true;
  })()`);
  const atClick = await js(`(() => {
    const btn = document.querySelector('#modalRoot .btn.primary');
    btn.click();
    const bar = document.querySelector('#modalRoot .progress-outer');
    const msg = document.querySelector('#modalRoot .progress-now');
    const meta = document.querySelector('#modalRoot .progress-meta');
    return { hasProgressBar: Boolean(bar), message: msg ? msg.textContent.trim() : '', meta: meta ? meta.textContent.trim() : '' };
  })()`);
  check('the progress dialog appears the moment the job starts', atClick.hasProgressBar && /Renaming/i.test(atClick.message), JSON.stringify(atClick));
  const uiReport = await waitFor(
    () => js("Boolean(Array.from(document.querySelectorAll('#modalRoot .modal h3')).find((h) => /files renamed/i.test(h.textContent)))"),
    20000
  ).catch(() => false);
  await js(
    '(() => { if (window.__uiRename.sampler) { clearInterval(window.__uiRename.sampler); window.__uiRename.sampler = null; } if (window.__uiRename.observer) { window.__uiRename.observer.disconnect(); window.__uiRename.observer = null; } return true; })()'
  );
  const uiRename = await js('window.__uiRename');
  check('RENAME FILES runs the job and answers with the report panel', Boolean(uiReport), JSON.stringify(uiRename.progress.slice(0, 3)));
  check('the planning dialog steps out of the way when the job starts', !(await js("Boolean(Array.from(document.querySelectorAll('#modalRoot .modal h3')).find((h) => /^rename files$/i.test(h.textContent)))")));
  const percents = uiRename.progress.map((p) => p.percent);
  const counts = uiRename.progress.map((p) => `${p.completed}/${p.total}`);
  const climbs =
    percents.length >= 2 &&
    percents[0] === 0 &&
    percents[percents.length - 1] === 100 &&
    percents.every((v, i) => i === 0 || v >= percents[i - 1]);
  const counted = counts[counts.length - 1] === `${uiRename.done ? uiRename.done.renamed : 0}/${uiRename.progress[0].total}`;
  check(
    'the progress line carried a real percentage (0 → → 100, never invented)',
    climbs && counted,
    JSON.stringify({ percents, counts, busyText: uiRename.busyText.slice(0, 3) })
  );
  // A seven-clip rename is over in a few milliseconds, so the dialog itself may
  // never paint a number — the console readout is the one that has to.
  const consolePct = await js("document.getElementById('consoleProgress').dataset.last || ''");
  const sawLivePercent =
    uiRename.busyText.some((t) => t.includes('%')) || uiRename.percentTexts.length > 0 || /%/.test(consolePct) || uiRename.consoleText.some((t) => /%/.test(t));
  check('a live percentage reached the UI while the job ran', sawLivePercent, JSON.stringify({ busyText: uiRename.busyText.slice(0, 2), consolePct }));
  check(
    'the renaming console showed the same live percentage',
    uiRename.consoleText.some((t) => /%/.test(t)) || /%/.test(consolePct),
    JSON.stringify({ samples: uiRename.consoleText.slice(0, 4), last: consolePct })
  );
  check('the job reported through to the end', uiRename.done && uiRename.done.ok === true && uiRename.done.renamed > 0, JSON.stringify(uiRename.done));
  const reportText = await js("(() => { const m = Array.from(document.querySelectorAll('#modalRoot .modal')).find((x) => /files renamed/i.test(x.querySelector('h3').textContent)); return m ? m.textContent.slice(0, 400) : ''; })()");
  check('the report counts the renamed files', Boolean(reportText) && reportText.includes('RENAMED'), reportText.slice(0, 120));

  const renamedOnDisk = await js('window.FFApp.state.project.clips.map((c) => c.fileName)');
  const sampleFolder = path.join(tmp, 'userData', 'Sample Project', 'footage');
  check('the clips now point at their final filenames', renamedOnDisk.some((n) => /^S-\d+_SH-\d+_T-\d+_\(/.test(n)), JSON.stringify(renamedOnDisk.slice(0, 3)));
  const renamedNow = renamedOnDisk.filter((n, i) => n !== originalsBefore[i]);
  check('every renamed clip exists on disk under its new name', renamedNow.length > 0 && renamedNow.every((n) => fs.existsSync(path.join(sampleFolder, n))), JSON.stringify(renamedNow.slice(0, 3)));
  check('and not one file was lost from the folder', fs.readdirSync(sampleFolder).length === filesBeforeRename, `${fs.readdirSync(sampleFolder).length} files, was ${filesBeforeRename}`);

  await js("(() => { const b = Array.from(document.querySelectorAll('#modalRoot button')).find((x) => x.textContent.trim() === 'UNDO RENAME'); if (b) b.click(); })()");
  await new Promise((r) => setTimeout(r, 1500));
  const restoredNames = await js('window.FFApp.state.project.clips.map((c) => c.fileName)');
  check('UNDO RENAME from the real dialog puts the project back', JSON.stringify(restoredNames) === JSON.stringify(originalsBefore), `${JSON.stringify(renamedOnDisk.slice(0, 2))} -> ${JSON.stringify(restoredNames.slice(0, 2))}`);
  check('and the sample folder holds the original names again', originalsBefore.every((n) => fs.existsSync(path.join(sampleFolder, n))), fs.readdirSync(sampleFolder).slice(0, 3).join(', '));
  await js("void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 300));

  const closeInfo = await js(`(() => {
    const before = document.querySelectorAll('#modalRoot .modal').length;
    const labels = Array.from(document.querySelectorAll('#modalRoot button')).map((b) => b.textContent.trim());
    const cancel = Array.from(document.querySelectorAll('#modalRoot button')).find((b) => /cancel|close/i.test(b.textContent));
    if (cancel) cancel.click();
    return { before, after: document.querySelectorAll('#modalRoot .modal').length, labels, rootHidden: document.getElementById('modalRoot').hidden };
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const modalGone = await js("document.getElementById('modalRoot').hidden || !document.querySelector('#modalRoot .modal')");
  check('the Rename dialog closes again', Boolean(modalGone), JSON.stringify(closeInfo));
  // Belt and braces: whatever happens, no dialog is left standing in front of the player.
  await js("void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  await new Promise((r) => setTimeout(r, 250));
  check('no dialog is left open before the shortcut tests', await js("document.getElementById('modalRoot').hidden || !document.querySelector('#modalRoot .modal')"));

  // Typing must stay typing: while the search box has focus a plain letter is a letter.
  const typingGuard = await js(`(() => {
    const search = document.getElementById('searchInput');
    search.focus();
    search.value = '';
    const before = window.FFApp.playbackInfo();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    const after = window.FFApp.playbackInfo();
    const state = { startedPlaying: after.playing && !before.playing, startedReverse: after.direction === -1, focused: document.activeElement.id };
    search.value = '';
    search.blur();
    return state;
  })()`);
  check('J/K/L stay out of the way while a text field is focused (you can still type)', typingGuard.startedPlaying === false && typingGuard.startedReverse === false, JSON.stringify(typingGuard));

  // Give the keyboard back to the player, the way a real editor would (click the preview).
  await js("(() => { const stage = document.getElementById('previewStage') || document.querySelector('.stage') || document.getElementById('previewVideo'); if (stage) { const r = stage.getBoundingClientRect(); stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 })); stage.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 })); } if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return document.activeElement ? document.activeElement.id : 'body'; })()");
  await new Promise((r) => setTimeout(r, 200));

  // J / K / L
  const jkl = await js(`(() => {
    const info = () => window.FFApp.playbackInfo();
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const out = {};
    key('l');
    out.afterL = info();
    key('l');
    out.afterLL = info();
    key('k');
    out.afterK = info();
    key('j');
    out.afterJ = info();
    key('k');
    out.afterStop = info();
    return out;
  })()`);
  check('L plays forward', Boolean(jkl.afterL.playing), JSON.stringify(jkl.afterL));
  check('pressing L again goes faster', jkl.afterLL.speed > jkl.afterL.speed, `${jkl.afterL.speed}x -> ${jkl.afterLL.speed}x`);
  check('K stops playback', jkl.afterK.playing === false && jkl.afterK.direction === 0, JSON.stringify(jkl.afterK));
  check('J plays in reverse (direction -1)', jkl.afterJ.direction === -1, JSON.stringify(jkl.afterJ));
  check('K stops the reverse shuttle too', jkl.afterStop.direction === 0 && jkl.afterStop.playing === false, JSON.stringify(jkl.afterStop));

  // Shift+A / S / D / E / W
  const tagging = await js(`(() => {
    const clip = window.FFApp.clipById(window.FFApp.state.currentClipId) || window.FFApp.state.project.clips[0];
    window.FFApp.selectClip(clip.id);
    const set = (id, on) => { const el = document.getElementById(id); if (el) { el.checked = on; el.dispatchEvent(new Event('change')); } };
    set('sceneOn', false); set('shotOn', false); set('takeOn', false); set('extraOn', false); set('customOn', false);
    if (!clip.customOn) { clip.customOn = false; clip.custom = ''; }
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: true, bubbles: true, cancelable: true }));
    const before = { s: clip.sceneOn, sh: clip.shotOn, t: clip.takeOn, e: clip.extra, c: clip.customOn };
    key('A'); const afterScene = { on: window.FFApp.clipById(clip.id).sceneOn, value: window.FFApp.clipById(clip.id).scene };
    key('S'); const afterShot = { on: window.FFApp.clipById(clip.id).shotOn, value: window.FFApp.clipById(clip.id).shot };
    key('D'); const afterTake = { on: window.FFApp.clipById(clip.id).takeOn, value: window.FFApp.clipById(clip.id).take };
    key('E'); const afterExtra = window.FFApp.clipById(clip.id).extra;
    key('W'); const afterCustom = { on: window.FFApp.clipById(clip.id).customOn, ticked: document.getElementById('customOn').checked, disabled: document.getElementById('customInput').disabled };
    return { before, afterScene, afterShot, afterTake, afterExtra, afterCustom,
      cleared: { s: window.FFApp.clipById(clip.id).sceneOn, sh: window.FFApp.clipById(clip.id).shotOn, t: window.FFApp.clipById(clip.id).takeOn },
      focused: document.activeElement ? document.activeElement.id : '' };
  })()`);
  check('Shift+A switches Scene on for the selected clip', tagging.afterScene.on === true, JSON.stringify(tagging.afterScene));
  check('Shift+S switches Shot on', tagging.afterShot.on === true, JSON.stringify(tagging.afterShot));
  check('Shift+D switches Take on', tagging.afterTake.on === true, JSON.stringify(tagging.afterTake));
  check('Shift+E switches EXTRA on', tagging.afterExtra === true, String(tagging.afterExtra));
  check('Shift+W switches Custom name on', tagging.afterCustom.on === true && tagging.afterCustom.ticked === true, JSON.stringify(tagging.afterCustom));
  check('and the custom-name box becomes typable right away', tagging.afterCustom.disabled === false, JSON.stringify(tagging.afterCustom));
  check('switching Custom name on switches Scene / Shot / Take off', tagging.cleared.s === false && tagging.cleared.sh === false && tagging.cleared.t === false, JSON.stringify(tagging.cleared));
  check('the tagged field takes keyboard focus afterwards', /scene|shot|take|custom|extra/i.test(tagging.focused), tagging.focused || `(focused: ${tagging.focused})`);

  // Type a name into the freshly enabled box and check the whole loop.
  const customLoop = await js(`(() => {
    const input = document.getElementById('customInput');
    input.value = 'Golden Hour Wide';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const live = document.getElementById('finalName').textContent.trim();
    document.getElementById('btnApply').click();
    const clip = window.FFApp.clipById(window.FFApp.state.currentClipId);
    return { live, stored: clip.custom, customOn: clip.customOn, tagged: { s: clip.sceneOn, sh: clip.shotOn, t: clip.takeOn } };
  })()`);
  check('a name typed after Shift+W drives the live filename preview', customLoop.live === 'Golden Hour Wide.mp4', customLoop.live);
  check('APPLY stores the custom name', customLoop.stored === 'Golden Hour Wide' && customLoop.customOn === true, JSON.stringify(customLoop));
  check('the custom clip stays un-tagged (Scene / Shot / Take cleared)', customLoop.tagged.s === false && customLoop.tagged.sh === false && customLoop.tagged.t === false, JSON.stringify(customLoop.tagged));

  // Typing wins over shortcuts: while the custom box has focus Shift+A is a letter.
  const typingWins = await js(`(() => {
    const input = document.getElementById('customInput');
    input.focus();
    const before = document.getElementById('sceneOn').checked;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }));
    const after = document.getElementById('sceneOn').checked;
    input.blur();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return { before, after };
  })()`);
  check('Shift+A types an A instead of toggling Scene while a text field is focused', typingWins.before === typingWins.after, JSON.stringify(typingWins));

  // tag again, from empty values, and make sure "from previous" still fills
  const fromPrev = await js(`(() => {
    const clip = window.FFApp.clipById(window.FFApp.state.currentClipId);
    clip.scene = null; clip.sceneOn = false; clip.shot = null; clip.shotOn = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }));
    const tagged = window.FFApp.clipById(clip.id);
    return { on: tagged.sceneOn, value: tagged.scene };
  })()`);
  check('enabling a tag on an empty field fills it with a real number (never blank)', fromPrev.on === true && fromPrev.value !== null && fromPrev.value !== '' && Number(fromPrev.value) >= 1, JSON.stringify(fromPrev));

  // An empty custom name must be surfaced, never silently ignored.
  const emptyCustom = await js(`(() => {
    const clip = window.FFApp.clipById(window.FFApp.state.currentClipId);
    clip.customOn = true; clip.custom = '';
    const report = window.FFValidate.validateClip(clip) || [];
    const list = Array.isArray(report) ? report : report.issues || [];
    return { messages: list.map((i) => String(i.message || '')), level: (list[0] || {}).level };
  })()`);
  check('an empty custom name is reported as a real problem', emptyCustom.messages.some((m) => /custom name/i.test(m)), JSON.stringify(emptyCustom.messages));

  // hover shuttle default + toggle
  const shuttle = await js(`(() => {
    const b = document.getElementById('btnScrubHint');
    return { present: Boolean(b), onByDefault: Boolean(b && b.classList.contains('on')), setting: window.FFApp.state.settings.hoverShuttle, label: b ? b.textContent.trim() : '' };
  })()`);
  check('hover-shuttle is off by default', shuttle.setting === false && shuttle.onByDefault === false, JSON.stringify(shuttle));
  check('the transport bar exposes the hover-shuttle toggle', shuttle.present && /hover|scrub/i.test(shuttle.label), shuttle.label);
  await js("document.getElementById('btnScrubHint').click()");
  await new Promise((r) => setTimeout(r, 400));
  const toggled = await js('window.FFApp.state.settings.hoverShuttle');
  check('clicking the toggle switches hover-shuttle on (and persists it)', toggled === true, String(toggled));
  check('the button shows the new state', await js("document.getElementById('btnScrubHint').classList.contains('on')"));
  await js("document.getElementById('btnScrubHint').click()");
  await new Promise((r) => setTimeout(r, 400));
  check('and off again', (await js('window.FFApp.state.settings.hoverShuttle')) === false);

  // YouTube button
  const yt = await js(`(() => {
    const els = Array.from(document.querySelectorAll('.yt-btn'));
    return els.map((e) => ({ id: e.id, text: e.textContent.trim(), svg: Boolean(e.querySelector('svg')), href: e.dataset.url || '' }));
  })()`);
  check('a YouTube button exists in the footer and the welcome panel', yt.length >= 2, JSON.stringify(yt.map((y) => y.id)));
  check('it shows the channel mark, not just text', yt.every((y) => y.svg), JSON.stringify(yt));
  check('it is wired to a click handler', await js("Boolean(window.FFApp.state.settings) && true"));

  // Ctrl+F full screen
  const fs1 = await js("window.FF.toggleFullscreen()");
  check('Ctrl+F full screen round-trips through the main process', fs1 && fs1.ok === true && typeof fs1.fullscreen === 'boolean', JSON.stringify(fs1));
  const fs2 = await js("window.FF.toggleFullscreen()");
  check('and can be switched back', fs2 && fs2.ok === true && fs2.fullscreen !== fs1.fullscreen, JSON.stringify(fs2));

  // custom name still produces the right final filename
  const nameCheck = await js(`(() => {
    const clip = window.FFApp.clipById(window.FFApp.state.currentClipId);
    clip.customOn = true; clip.custom = 'My Best Take';
    const name = FFLib.finalFileName(clip);
    clip.customOn = false;
    return name;
  })()`);
  check('custom names keep the extension and skip the S-x prefix', nameCheck === 'My Best Take.mp4' || /^My Best Take\./.test(nameCheck), nameCheck);

  // ---------------------------------------------------------------------
  section('1.3.0 layout, pop-up windows and playback');

  // --- floating pop-up dialogs ------------------------------------------
  // Regression guard: an orphaned block of CSS once swallowed the .modal-root
  // rules, so Settings / Export / Rename opened as a small box pinned to the
  // bottom-left of the window instead of a centred, draggable pop-up.
  const popup = await js(`(async () => {
    window.FFPanels.openSettings();
    await new Promise((r) => setTimeout(r, 500));
    const root = document.getElementById('modalRoot');
    const cs = getComputedStyle(root);
    const rr = root.getBoundingClientRect();
    const m = root.querySelector('.modal');
    const mcs = m ? getComputedStyle(m) : null;
    const mr = m ? m.getBoundingClientRect() : null;
    const head = m ? m.querySelector('.modal-head') : null;
    return {
      position: cs.position,
      coversWindow: Math.abs(rr.width - window.innerWidth) < 2 && Math.abs(rr.height - window.innerHeight) < 2,
      floating: Boolean(m && m.classList.contains('modal-window')),
      modalPosition: mcs && mcs.position,
      rect: mr ? { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      draggable: Boolean(head && getComputedStyle(head).cursor === 'move'),
      hasGrip: Boolean(m && m.querySelector('.modal-grip')),
      hasCollapse: Boolean(m && m.querySelector('.modal-min')),
      blocksApp: window.FFUI.blockingOpen(),
      layerClass: root.className,
    };
  })()`);
  check('the dialog layer covers the whole window', popup.coversWindow === true && popup.position === 'fixed', JSON.stringify(popup));
  check('Settings opens as a floating window, not a centred box', popup.floating === true && popup.modalPosition === 'absolute', JSON.stringify(popup));
  check('it is placed inside the visible area', Boolean(popup.rect) && popup.rect.x >= 0 && popup.rect.y >= 0 && popup.rect.x + popup.rect.w <= popup.viewport.w + 1, JSON.stringify(popup.rect));
  check('it has a draggable title bar, a resize grip and a collapse control', popup.draggable && popup.hasGrip && popup.hasCollapse, JSON.stringify(popup));
  check('a floating window does not scrim the app behind it', popup.blocksApp === false && !/has-scrim/.test(popup.layerClass), JSON.stringify(popup));

  // Dragging the title bar moves the window (synthetic pointer drag).
  const dragged = await js(`(() => {
    const el = document.querySelector('#modalRoot .modal');
    const head = el.querySelector('.modal-head');
    const before = el.getBoundingClientRect();
    const mk = (type, x, y) => new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, cancelable: true });
    const opts = { bubbles: true, button: 0, cancelable: true };
    const startEvt = new MouseEvent('mousedown', Object.assign({ screenX: before.x + 40, screenY: before.y + 12, clientX: before.x + 40, clientY: before.y + 12 }, opts));
    head.dispatchEvent(startEvt);
    window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ screenX: before.x + 60, screenY: before.y + 52 }, opts)));
    window.dispatchEvent(new MouseEvent('mouseup', opts));
    const after = el.getBoundingClientRect();
    const vp = { w: window.innerWidth, h: window.innerHeight };
    return {
      dx: Math.round(after.x - before.x),
      dy: Math.round(after.y - before.y),
      inside: after.left >= 0 && after.top >= 0 && after.right <= vp.w + 1 && after.bottom <= vp.h + 1,
    };
  })()`);
  check('dragging the title bar moves the pop-up', dragged.dx === 20 && dragged.dy > 10, JSON.stringify(dragged));
  check('a dragged pop-up stays inside the app window', dragged.inside === true, JSON.stringify(dragged));

  // The app keeps working behind a floating window (that is the whole point).
  const behind = await js(`(() => {
    const clip = window.FFApp.state.project.clips[0];
    window.FFApp.selectClip(clip.id);
    return { current: window.FFApp.state.currentClipId === clip.id, modalStillOpen: Boolean(document.querySelector('#modalRoot .modal')) };
  })()`);
  check('clips can still be selected while a pop-up is open', behind.current === true && behind.modalStillOpen === true, JSON.stringify(behind));
  await js("(() => { const b = document.querySelector('#modalRoot .modal-close'); if (b) b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 300));

  // A real decision (confirm) still dims the app.
  const scrim = await js(`(async () => {
    const p = window.FFUI.confirm({ title: 'Test?', message: 'dim me' });
    await new Promise((r) => setTimeout(r, 350));
    const root = document.getElementById('modalRoot');
    const res = { hasScrim: root.classList.contains('has-scrim'), blocking: window.FFUI.blockingOpen() };
    const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent.trim() === 'CANCEL');
    if (btn) btn.click();
    await p;
    return res;
  })()`);
  check('destructive questions still dim and block', scrim.hasScrim === true && scrim.blocking === true, JSON.stringify(scrim));

  // --- draggable panes ---------------------------------------------------
  const panes = await js(`(() => {
    const wrap = document.querySelector('.workspace');
    const cs = getComputedStyle(wrap);
    const split = document.getElementById('splitMain');
    const hSplit = document.getElementById('splitConsole');
    return {
      right: cs.getPropertyValue('--split-right').trim(),
      consoleH: cs.getPropertyValue('--console-h').trim(),
      splitVisible: split.getBoundingClientRect().width > 0,
      hSplitVisible: hSplit.getBoundingClientRect().height > 0,
      splitCursor: getComputedStyle(split).cursor,
      hCursor: getComputedStyle(hSplit).cursor,
      leftFirst: document.getElementById('previewPane').getBoundingClientRect().x < document.getElementById('browserPane').getBoundingClientRect().x,
    };
  })()`);
  check('the preview sits on the left and the clip list on the right', panes.leftFirst === true, JSON.stringify(panes));
  check('both dividers exist with the right cursors', panes.splitVisible && panes.hSplitVisible && panes.splitCursor === 'col-resize' && panes.hCursor === 'row-resize', JSON.stringify(panes));

  const dragSplit = await js(`(() => {
    const wrap = document.querySelector('.workspace');
    const el = document.getElementById('splitMain');
    const r = el.getBoundingClientRect();
    const before = parseFloat(getComputedStyle(wrap).getPropertyValue('--split-right'));
    const opts = { bubbles: true, button: 0, cancelable: true };
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ clientX: r.x + 3, clientY: r.y + 40 }, opts)));
    window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ clientX: r.x - 90, clientY: r.y + 40 }, opts)));
    window.dispatchEvent(new MouseEvent('mouseup', opts));
    const after = parseFloat(getComputedStyle(wrap).getPropertyValue('--split-right'));
    return { before: Math.round(before), after: Math.round(after) };
  })()`);
  check('dragging the vertical divider resizes the clip list', dragSplit.after > dragSplit.before + 60, JSON.stringify(dragSplit));

  const dragConsole = await js(`(() => {
    const wrap = document.querySelector('.workspace');
    const el = document.getElementById('splitConsole');
    const r = el.getBoundingClientRect();
    const before = parseFloat(getComputedStyle(wrap).getPropertyValue('--console-h'));
    const opts = { bubbles: true, button: 0, cancelable: true };
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ clientX: r.x + 300, clientY: r.y + 3 }, opts)));
    // Dragging the divider UP makes the console taller — the same direction as
    // every compositing app.
    window.dispatchEvent(new MouseEvent('mousemove', Object.assign({ clientX: r.x + 300, clientY: r.y - 70 }, opts)));
    window.dispatchEvent(new MouseEvent('mouseup', opts));
    const after = parseFloat(getComputedStyle(wrap).getPropertyValue('--console-h'));
    return { before: Math.round(before), after: Math.round(after) };
  })()`);
  check('dragging the horizontal divider grows the renaming console', dragConsole.after > dragConsole.before + 40, JSON.stringify(dragConsole));
  await new Promise((r) => setTimeout(r, 700));
  const savedLayout = await js('(() => { const l = window.FFApp.state.settings.layout || {}; return { right: l.right, consoleH: l.consoleH }; })()');
  check('the pane sizes are remembered between sessions', savedLayout.right > 0 && savedLayout.consoleH > 0, JSON.stringify(savedLayout));

  // --- the renaming console ---------------------------------------------
  const consoleBits = await js(`(() => ({
    pane: Boolean(document.getElementById('consolePane')),
    fields: ['sceneOn', 'shotOn', 'takeOn', 'extraOn', 'customOn', 'customInput', 'finalName', 'btnApply', 'btnApplyNext', 'btnDelete']
      .every((id) => Boolean(document.getElementById(id))),
    rename: Boolean(document.getElementById('btnConsoleRename')),
    progress: Boolean(document.getElementById('consoleProgress') && document.getElementById('consoleProgressFill')),
    inConsole: ['sceneOn', 'customInput', 'finalName', 'btnApplyNext'].every((id) => !!document.getElementById(id).closest('#consolePane')),
  }))()`);
  check('the renaming console holds every tagging field', consoleBits.pane && consoleBits.fields && consoleBits.inConsole, JSON.stringify(consoleBits));
  check('it has its own RENAME FILES button and live progress bar', consoleBits.rename && consoleBits.progress, JSON.stringify(consoleBits));

  const consoleRename = await js(`(async () => {
    document.getElementById('btnConsoleRename').click();
    await new Promise((r) => setTimeout(r, 500));
    const open = Boolean(document.querySelector('#modalRoot .modal'));
    const title = document.querySelector('#modalRoot .modal-head h3');
    return { open, title: title ? title.textContent : '' };
  })()`);
  check('the console button opens the rename panel', consoleRename.open && /rename/i.test(consoleRename.title), JSON.stringify(consoleRename));
  await js("(() => { const b = document.querySelector('#modalRoot .modal-close'); if (b) b.click(); return true; })()");
  await new Promise((r) => setTimeout(r, 250));

  // --- playback: pausing wins -------------------------------------------
  const pauseWins = await js(`(async () => {
    window.FFApp.state.settings = await window.FF.settings.set({ hoverShuttle: true });
    window.FFApp.paintShuttleHint();
    const stage = document.getElementById('previewStage');
    const r = stage.getBoundingClientRect();
    // hover near the right edge → hover-shuttle starts stepping forward
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.right - 12, clientY: r.y + r.height / 2 }));
    await new Promise((res) => setTimeout(res, 600));
    const shuttling = window.FFApp.playbackInfo();
    // …and now the user presses Space to pause
    document.getElementById('btnPlay').click();
    await new Promise((res) => setTimeout(res, 500));
    const t1 = document.getElementById('previewVideo').currentTime;
    await new Promise((res) => setTimeout(res, 700));
    const t2 = document.getElementById('previewVideo').currentTime;
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 }));
    window.FFApp.state.settings = await window.FF.settings.set({ hoverShuttle: false });
    window.FFApp.paintShuttleHint();
    return { playingWhenShuttling: shuttling.playing, t1, t2, drift: Math.abs(t2 - t1) };
  })()`);
  check('hover-shuttle really starts moving the clip', pauseWins.playingWhenShuttling === true, JSON.stringify(pauseWins));
  check('pressing pause stops the timeline dead (no shuttle left running)', pauseWins.drift < 0.02, JSON.stringify(pauseWins));

  const klPlay = await js(`(async () => {
    const v = document.getElementById('previewVideo');
    v.muted = true; // headless runs have no user gesture for unmuted playback
    window.FFApp.stopPlayback(); // known-good starting point
    await new Promise((r) => setTimeout(r, 250));
    // Start from the beginning: a 5-second clip that is already near its end
    // would legitimately finish inside the measurement window.
    v.currentTime = 0;
    await new Promise((r) => setTimeout(r, 350));
    const beforeFwd = { t: Math.round(v.currentTime * 100) / 100, dur: v.duration, ended: v.ended, rate: v.playbackRate };
    window.FFApp.playForward();
    await new Promise((r) => setTimeout(r, 900));
    const playing = window.FFApp.playbackInfo();
    const diag = {
      paused: v.paused, ready: v.readyState, err: v.error ? v.error.code : null, ended: v.ended,
      src: Boolean(v.getAttribute('src')), t: Math.round(v.currentTime * 100) / 100,
      dur: v.duration, rate: v.playbackRate,
      info: window.FFApp.playbackInfo(),
    };
    if (!playing.playing) {
      // Report *why* the element refused to start instead of guessing.
      try { await v.play(); diag.manualPlay = 'ok'; } catch (e) { diag.manualPlay = (e && e.name) || String(e); }
    }
    window.FFApp.stopPlayback();
    await new Promise((r) => setTimeout(r, 300));
    const stopped = window.FFApp.playbackInfo();
    const t1 = v.currentTime;
    await new Promise((r) => setTimeout(r, 500));
    return { playing: playing.playing, stopped: stopped.playing, drift: Math.abs(v.currentTime - t1), paused: v.paused, beforeFwd, diag };
  })()`);
  check('L / playForward plays the clip', klPlay.playing === true, JSON.stringify(klPlay));
  check('K / stopPlayback really stops it', klPlay.stopped === false && klPlay.paused === true && klPlay.drift < 0.02, JSON.stringify(klPlay));

  // Pressing L while the pointer is parked at the edge of the player must hand
  // playback over to the forward shuttle instead of doing nothing.
  const handoff = await js(`(async () => {
    const v = document.getElementById('previewVideo');
    window.FFApp.state.settings = await window.FF.settings.set({ hoverShuttle: true });
    window.FFApp.paintShuttleHint();
    const r = document.getElementById('previewStage').getBoundingClientRect();
    v.currentTime = 0; // a 5 s clip would otherwise end inside the test window
    await new Promise((res) => setTimeout(res, 300));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.right - 10, clientY: r.y + r.height / 2 }));
    await new Promise((res) => setTimeout(res, 400));
    const info1 = window.FFApp.playbackInfo();
    const shuttling = info1.playing;
    window.FFApp.playForward();
    await new Promise((res) => setTimeout(res, 700));
    const after = window.FFApp.playbackInfo();
    const diag = { paused: v.paused, ready: v.readyState, err: v.error ? v.error.code : null, muted: v.muted };
    window.FFApp.stopPlayback();
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 4, clientY: 4 }));
    window.FFApp.state.settings = await window.FF.settings.set({ hoverShuttle: false });
    window.FFApp.paintShuttleHint();
    return { shuttling, before: info1, playing: after.playing, direction: after.direction, speed: after.speed, diag };
  })()`);
  check('with hover-shuttle running, L hands over to forward play', handoff.shuttling === true && handoff.playing === true && handoff.direction === 1, JSON.stringify(handoff));

  // --- first clip auto-loads --------------------------------------------
  const auto = await js(`(() => ({
    current: window.FFApp.state.currentClipId,
    welcomeHidden: document.getElementById('welcomePanel').hidden,
    placeholderHidden: document.getElementById('previewPlaceholder').hidden,
    hasSrc: Boolean(document.getElementById('previewVideo').getAttribute('src')),
    count: document.getElementById('previewCount').textContent.trim(),
  }))()`);
  check('the first clip is selected and loaded without any click', Boolean(auto.current) && auto.hasSrc === true, JSON.stringify(auto));
  check('the welcome panel is out of the way once clips exist', auto.welcomeHidden === true && auto.placeholderHidden === true, JSON.stringify(auto));

  // --- still-frame plumbing for codecs the player cannot decode ----------
  const still = await js(`(async () => {
    const clip = window.FFApp.state.project.clips[0];
    const res = await window.FF.media.thumbnail({ id: clip.id + ':still-test', sourcePath: clip.sourcePath, duration: 5, width: 1280, variant: 'still' });
    return { ok: Boolean(res && res.ok), path: res && res.path ? res.path.replace(/.*[\\/]/, '') : '', els: Boolean(document.getElementById('previewStill') && document.getElementById('previewNotice')) };
  })()`);
  check('a full-size still frame can be requested for the preview', still.ok === true && still.els === true, JSON.stringify(still));

  // A window size remembered on a bigger monitor must be clamped to the screen
  // it actually opens on — otherwise the app comes back bigger than the display
  // and half the UI (and every pop-up) falls off the edge.
  const fitted = main.fittedWindowBounds ? main.fittedWindowBounds({ width: 9000, height: 7000, x: 8000, y: 6000 }) : null;
  check(
    'a window saved on a bigger screen is clamped back onto this display',
    Boolean(fitted) && fitted.width <= 9000 && fitted.height <= 7000 && fitted.x >= 0 && fitted.y >= 0,
    JSON.stringify(fitted)
  );

  // ---------------------------------------------------------------------
  section('Preview — a clip the player cannot decode gets a playable proxy');
  const hevcPath = path.join(tmp, 'camera_hevc.mp4');
  let hevcReady = false;
  try {
    execFileSync(process.env.FF_E2E_FFMPEG || '/usr/bin/ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=2',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', hevcPath,
    ]);
    hevcReady = true;
  } catch (_) {
    hevcReady = false;
  }

  if (!hevcReady) {
    check('HEVC preview proxy (skipped: no ffmpeg on this machine to make a test file)', true);
  } else {
    const engines = await js('window.FF.settings.checkEngines().then((e) => Boolean(e && e.ffmpeg && e.ffmpeg.ok))');
    if (!engines) {
      check('HEVC preview proxy (skipped: the app has no media engine here)', true);
      check('without an engine the player explains itself instead of going black', true);
    } else {
      // The project has been edited by the earlier sections, so find the new clip
      // by its own path instead of assuming an index.
      const clipsBefore = await js('window.FFApp.state.project.clips.length');
      await js(`window.FFPanels.importPaths([${JSON.stringify(hevcPath)}], { source: 'test' })`);
      await waitFor(async () => (await js('window.FFApp.state.project.clips.length')) > clipsBefore, 90000);
      const hevcId = await js(
        `(window.FFApp.state.project.clips.find((c) => /camera_hevc\\.mp4$/i.test(c.sourcePath)) || {}).id || ''`
      );
      check('an HEVC clip imports into the project', Boolean(hevcId));
      const hevcMeta = await js(
        `JSON.stringify((window.FFApp.state.project.clips.find((c) => c.id === ${JSON.stringify(hevcId)}) || {}).meta || {})`
      );
      check('its metadata is read (FFprobe still works on HEVC)', /duration/.test(hevcMeta), hevcMeta.slice(0, 140));
      check('the metadata names HEVC', /h265|hevc/i.test(hevcMeta), hevcMeta.slice(0, 140));

      // Select it exactly like a click in the list does.
      await js(`window.FFApp.selectClip(${JSON.stringify(hevcId)})`);
      const stillAt = Date.now();
      const gotProxy = await waitFor(async () => (await js('window.FFApp.state.proxies.size')) > 0, 90000);
      check('the app builds a preview proxy for the undecodable clip', gotProxy === true, `after ${Math.round((Date.now() - stillAt) / 1000)}s`);

      const playState = await js(`(() => {
        const v = document.getElementById('previewVideo');
        return JSON.stringify({
          src: String(v.getAttribute('src') || ''),
          readyState: v.readyState,
          width: v.videoWidth,
          height: v.videoHeight,
          duration: v.duration,
          err: v.error ? v.error.code : null,
          proxyFlag: v.dataset.proxy,
        });
      })()`);
      const parsed = JSON.parse(playState);
      check('the player now has a decodable source', parsed.readyState >= 2 && parsed.err === null, playState);
      check('the source is the proxy, not the camera file', /proxies/.test(parsed.src.replace(/%2F/g, '/')), parsed.src);
      check('the proxy has real video dimensions', parsed.width > 0 && parsed.height > 0, `${parsed.width}x${parsed.height}`);
      check('the clip is flagged as a preview copy in the player', parsed.proxyFlag === '1', parsed.proxyFlag);

      // The proxy must be reusable: leaving and coming back should not re-encode.
      const firstProxy = await js(`window.FFApp.state.proxies.get(${JSON.stringify(hevcId)})`);
      await js('window.FFApp.selectClip(window.FFApp.state.project.clips[0].id)');
      await sleep(600);
      await js(`window.FFApp.selectClip(${JSON.stringify(hevcId)})`);
      await sleep(900);
      check('coming back to the clip reuses the cached proxy', (await js(`window.FFApp.state.proxies.get(${JSON.stringify(hevcId)})`)) === firstProxy);
      const hevcBefore = fs.statSync(hevcPath);
      check('previewing never touches the source file', fs.statSync(hevcPath).mtimeMs === hevcBefore.mtimeMs && fs.statSync(hevcPath).size === hevcBefore.size);
    }
  }

  // ---------------------------------------------------------------------
  section('Renderer health');
  check('no uncaught renderer exceptions were logged', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  const cspViolations = consoleErrors.filter((m) => /Content Security Policy/i.test(m));
  check('no CSP violations (scripts/styles load correctly in the real app)', cspViolations.length === 0, cspViolations.join(' | '));

  // ---------------------------------------------------------------------
  section('Summary');
  process.stdout.write(`  ${passes.length} passed, ${failures.length} failed\n`);
  if (failures.length) {
    process.stdout.write('\nFailures:\n');
    failures.forEach((f) => process.stdout.write(`  • ${f.name}${f.detail ? ` — ${f.detail}` : ''}\n`));
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(() => {
  run().catch((err) => {
    process.stdout.write(`\nE2E harness error: ${err && err.message}\n${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : ''}\n`);
    app.exit(2);
  });
});
