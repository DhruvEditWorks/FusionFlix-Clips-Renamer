#!/usr/bin/env node
/**
 * FUSION FLIX — screenshot generator (development tool).
 *
 * Boots the real application headlessly, loads the generated sample project and
 * writes screenshots into ./shots. Handy for documentation and design reviews.
 *
 * Linux:  xvfb-run -a electron tools/make-screenshots.js
 * Windows/macOS:  electron tools/make-screenshots.js
 */
process.env.FF_E2E = '1';
const { app, BrowserWindow } = require('electron');
const fs=require('fs'), os=require('os'), path=require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(),'ffs-')));
app.commandLine.appendSwitch('disable-gpu');
require('../main.js');
const waitFor = async (fn, t=60000) => { const s=Date.now(); for(;;){ const v=await fn(); if(v) return v; if(Date.now()-s>t) throw new Error('timeout'); await new Promise(r=>setTimeout(r,300)); } };
(async () => {
  await app.whenReady();
  const w = await waitFor(() => { const x = BrowserWindow.getAllWindows()[0]; return x && !x.webContents.isLoading() ? x : null; });
  const wc = w.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  await waitFor(() => js('window.FFApp && window.FFApp.ready === true'));
  w.setSize(1600, 1000);
  await new Promise(r=>setTimeout(r,600));
  // Renderer work keeps running while the window is off-screen.
  try { wc.setBackgroundThrottling(false); } catch (_) {}
  /**
   * Software rendering (xvfb) can hand back the frame from *before* a theme
   * switch — the compositor has not produced a new surface yet. Waiting for two
   * animation frames and nudging the window one pixel forces a fresh frame.
   */
  const settle = async (ms = 700) => {
    await wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', true).catch(() => {});
    await new Promise((r) => setTimeout(r, ms));
    const [w0, h0] = w.getContentSize();
    w.setContentSize(w0, h0 + 1);
    await new Promise((r) => setTimeout(r, 200));
    w.setContentSize(w0, h0);
    await new Promise((r) => setTimeout(r, 350));
  };
  const shot = async (name) => {
    await settle();
    process.stdout.write('capturing ' + name + '\n');
    const img = await Promise.race([
      wc.capturePage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage timed out')), 15000)),
    ]).catch((e) => { process.stdout.write('  ' + e.message + '\n'); return null; });
    if (img) fs.writeFileSync(path.join(__dirname,'..','shots',name), img.toPNG());
  };
  // Software rendering in CI is very slow with backdrop blur; the app keeps it,
  // the screenshot harness turns it off so captures do not stall.
  await js(`void (() => { const st = document.createElement('style');
     st.textContent = '.modal-root{backdrop-filter:none !important} .drag-overlay{backdrop-filter:none !important}';
     document.head.appendChild(st); })()`);
  fs.mkdirSync(path.join(__dirname,'..','shots'), { recursive: true });

  await shot('01-welcome.png');
  await js('window.FFPanels.loadSample()');
  await waitFor(() => js('window.FFApp.state.project.clips.length > 0'), 90000);
  // wait for thumbnails and hover preview
  await waitFor(() => js("document.querySelectorAll('#clipListInner .clip-row img[src^=\"ffthumb://\"]').length >= 3"), 60000);
  await new Promise(r=>setTimeout(r,1500));
  await shot('02-main.png');
  // select a clip + move pointer into the right scrub zone to show the shuttle UI
  await js('window.FFApp.selectClip(window.FFApp.state.project.clips[2].id)');
  await new Promise(r=>setTimeout(r,1200));
  await js(`void (() => { const r = document.getElementById('previewStage').getBoundingClientRect();
     const ev = new MouseEvent('mousemove', { clientX: r.right - 40, clientY: r.top + r.height/2, bubbles: true });
     window.dispatchEvent(ev); })()`);
  await new Promise(r=>setTimeout(r,900));
  await shot('03-scrub-forward.png');
  await js(`void (() => { const r = document.getElementById('previewStage').getBoundingClientRect();
     const ev = new MouseEvent('mousemove', { clientX: r.left + 40, clientY: r.top + r.height/2, bubbles: true });
     window.dispatchEvent(ev); })()`);
  await new Promise(r=>setTimeout(r,900));
  await shot('04-scrub-backward.png');
  // export panel
  process.stdout.write('opening export panel\n');
  await js('void window.FFPanels.openExport()');
  await new Promise(r=>setTimeout(r,1500));
  await shot('05-export.png');
  await js("void document.getElementById('modalRoot').querySelector('.modal-close').click()");
  process.stdout.write('opening help\n');
  await js('void window.FFPanels.openHelp()');
  await new Promise(r=>setTimeout(r,900));
  await shot('06-help.png');
  await js("void document.getElementById('modalRoot').querySelector('.modal-close').click()");
  process.stdout.write('opening about\n');
  await js('void window.FFPanels.openAbout()');
  await new Promise(r=>setTimeout(r,900));
  await shot('07-about.png');
  await js("void document.getElementById('modalRoot').querySelector('.modal-close').click()");
  process.stdout.write('opening settings\n');
  await js('void window.FFPanels.openSettings()');
  await new Promise(r=>setTimeout(r,1600));
  await shot('08-settings.png');
  await js("void document.getElementById('modalRoot').querySelector('.modal-close').click()");
  await js('window.FFApp.selectClip(window.FFApp.state.project.clips[0].id)');
  // hover preview on a clip row
  await js(`void (() => { const row = document.querySelector('#clipListInner .clip-row:nth-child(3)');
     const t = row.querySelector('.clip-thumb'); const r = t.getBoundingClientRect();
     row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left+10, clientY: r.top+10 })); })()`);
  await new Promise(r=>setTimeout(r,2200));
  await shot('09-hover-preview.png');
  // delete confirmation modal
  await js("void document.getElementById('btnDelete').click()");
  await new Promise(r=>setTimeout(r,700));
  await shot('10-delete-confirm.png');
  await js("void document.getElementById('modalRoot').querySelector('.modal-close').click()");
  await new Promise(r=>setTimeout(r,500));

  // white Daylight theme + a custom accent colour chosen in Settings
  await js("window.FFApp.applyTheme('daylight', '#2f7cf6')");
  await js("window.FFApp.setFocusMode(false, { persist: false })");
  await js('window.FFApp.selectClip(window.FFApp.state.project.clips[2].id)');
  await new Promise(r=>setTimeout(r,1600));
  await settle(900);
  await shot('11-daylight-theme.png');

  // focus (simple) view — the preview centred, both side panels out of the way
  await js("window.FFApp.setFocusMode(true, { persist: false })");
  await new Promise(r=>setTimeout(r,1400));
  await settle(900);
  await shot('12-focus-view.png');

  await js("window.FFApp.applyTheme('cinema', '#f0562f'); window.FFApp.setFocusMode(false, { persist: false })");
  await new Promise(r=>setTimeout(r,400));
  app.exit(0);
})();
