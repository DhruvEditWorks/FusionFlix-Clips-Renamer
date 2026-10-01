'use strict';
/**
 * FUSION FLIX — panels & workflows
 * Import, export, project files, settings, help, about, recovery, relink.
 * Exposed as window.FFPanels (sandboxed renderer — talks to main via window.FF).
 */
(function () {
  const UI = window.FFUI;
  const FF = window.FF;
  const App = window.FFApp;
  const FFLib = window.FFLib;
  const FFValidate = window.FFValidate;
  const FFKeys = window.FFKeys;

  const $ = (id) => document.getElementById(id);
  const STATUS = FFLib.STATUS;

  const PANELS = {};
  let exportState = { plan: null, options: null, running: false, busy: null, results: null };
  let engineState = { busy: null };

  /** The channel button under the credit line. */
  const YOUTUBE_URL = 'https://www.youtube.com/@fusiononyoutube';

  // =========================================================================
  // Import
  // =========================================================================
  async function importClips() {
    const res = await FF.dialog.openClips();
    if (!res || !res.ok || !res.filePaths.length) return;
    importPaths(res.filePaths, { source: 'dialog' });
  }

  async function importFolder() {
    const res = await FF.dialog.openFolder();
    if (!res || !res.ok || !res.folderPath) return;
    importPaths([res.folderPath], { source: 'folder' });
  }

  async function importPaths(paths, options) {
    const state = App.state;
    if (state.importBusy) {
      UI.toast('An import is already running — please wait for it to finish.', { type: 'warning' });
      return;
    }
    if (!paths || !paths.length) return;
    state.importBusy = true;

    const progress = UI.busy({
      title: 'Importing clips',
      message: `Scanning ${paths.length} item${paths.length === 1 ? '' : 's'}…`,
      cancellable: true,
      cancelLabel: 'Cancel import',
      onCancel: () => {
        FF.importClips.cancel();
        progress.setMessage('Cancelling — finishing the current file…');
      },
    });

    PANELS.onImportProgress = (p) => {
      if (!p) return;
      const meta = p.total ? `${p.done || 0} / ${p.total} clips read` : `${p.found || 0} found`;
      progress.setProgress(p.percent || 0, meta);
      progress.setMessage(p.message || 'Working…');
    };

    let added = 0;
    try {
      const result = await FF.importClips.run({ paths, projectSettings: state.project.settings });
      progress.close();

      if (result && result.__error) throw new Error(result.message);
      if (!result || !result.ok) throw new Error((result && result.error) || 'The import could not be completed.');

      const clips = result.clips || [];
      if (clips.length) {
        const baseOrder = state.project.clips.length ? Math.max(...state.project.clips.map((c) => c.order ?? 0)) + 1 : 0;
        clips.forEach((clip, i) => {
          clip.order = baseOrder + i;
          state.project.clips.push(clip);
        });
        added = clips.length;
        App.markDirty();
        App.computeView();
        App.renderBrowser();
        App.renderFooter();
        // Selection first: the newly imported footage must be on screen (and the
        // first-run overlay gone) even if a smaller follow-up step fails.
        if (!state.currentClipId) {
          App.selectClip(state.project.clips[0].id);
        } else {
          // jump to the first newly imported clip so tagging can start straight away
          App.selectClip(clips[0].id, { scroll: true });
        }
        App.updateWelcome();
        App.updateProjectMeta();
        App.checkMissingMedia(false);
      }

      const warnings = (result && result.warnings) || [];
      if (result && result.cancelled) {
        UI.toast(`Import cancelled — ${added} clip${added === 1 ? '' : 's'} added.`, { type: 'warning' });
      } else if (added) {
        UI.toast(`${added} clip${added === 1 ? '' : 's'} imported in ${result.seconds || 0}s.`, { type: 'success', title: 'Import finished' });
      } else {
        UI.toast('No supported video files were found in that selection.', { type: 'warning', title: 'Nothing imported' });
      }

      if (warnings.length) {
        showList('Import notes', `${warnings.length} item${warnings.length === 1 ? '' : 's'} needed attention`, warnings, 'warning');
      }
      App.setStatus(`${added} clip${added === 1 ? '' : 's'} imported. Original files are untouched.`);
    } catch (err) {
      progress.close();
      UI.toast(err.message || 'The import could not be completed.', { type: 'error', title: 'Import failed', timeout: 9000 });
    } finally {
      state.importBusy = false;
      PANELS.onImportProgress = null;
    }
  }

  function showList(title, subtitle, lines, kind) {
    UI.modal({
      title,
      subtitle,
      size: 'wide',
      window: true,
      winKey: 'issues',
      defaultWidth: 760,
      body: (() => {
        const wrap = document.createElement('div');
        wrap.className = 'list-scroll';
        lines.slice(0, 300).forEach((line) => {
          const div = document.createElement('div');
          div.className = `list-line ${kind || ''}`;
          div.textContent = line;
          wrap.appendChild(div);
        });
        if (lines.length > 300) {
          const more = document.createElement('div');
          more.className = 'list-line';
          more.textContent = `…and ${lines.length - 300} more.`;
          wrap.appendChild(more);
        }
        return wrap;
      })(),
      buttons: [{ label: 'CLOSE', className: 'secondary' }],
    });
  }

  // =========================================================================
  // Rename (in place — no copying)
  // =========================================================================
  /**
   * The fast path: renames the files where they already are. Nothing is copied,
   * so a hundred gigabytes take the same time as a hundred megabytes.
   *
   * This is the only feature that writes to the user's own files, so it always
   * asks for an explicit confirmation and can always be undone.
   */
  // `handled` marks a run whose report was already drawn by startRenameFromPanel
  // (it receives the result from the same IPC call) — the RENAME_DONE broadcast
  // must not draw a second one.
  let renameState = { running: false, plan: null, busy: null, result: null, lastChanges: [], handled: false };

  function toRenameClip(clip) {
    return {
      id: clip.id,
      sourcePath: clip.sourcePath,
      fileName: clip.fileName,
      size: clip.size,
      sceneOn: clip.sceneOn,
      shotOn: clip.shotOn,
      takeOn: clip.takeOn,
      scene: clip.scene,
      shot: clip.shot,
      take: clip.take,
      extra: clip.extra,
      customOn: clip.customOn,
      custom: clip.custom,
      timeText: clip.timeText,
      status: clip.status,
      meta: clip.meta,
    };
  }

  async function openRename() {
    const state = App.state;
    if (!state.project.clips.length) {
      UI.toast('Import some clips first — there is nothing to rename yet.', { type: 'warning', title: 'Nothing to rename' });
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'modal-section';
    wrap.innerHTML = `
      <div class="kv-grid four" id="renSummary"></div>
      <h4>HOW IT WORKS</h4>
      <div class="list-line info">
        Every clip is renamed <b>in its own folder</b> to its final filename
        (<span class="mono">S-1_SH-2_T-1_(1-2-1).mp4</span>). Nothing is copied and nothing is moved,
        so it finishes in seconds even for hundreds of gigabytes. Files are <b>never overwritten</b> —
        a clash becomes <span class="mono">_01</span>, <span class="mono">_02</span>…
      </div>
      <div class="warn-box">
        <b>⚠  This is the one action that touches your original files.</b>
        <span>Their names change on disk. You can put them back at any time with <b>UNDO RENAME</b> (the log is saved inside the project file).</span>
      </div>
      <label class="checkbox-line">
        <input type="checkbox" id="renConfirm" class="checkbox">
        <span>Rename my original files in place — I understand the file names on disk will change.</span>
      </label>
      <div id="renChecks" class="modal-section"></div>
    `;

    const modal = UI.modal({
      title: 'Rename files',
      subtitle: 'Instant — renames in place instead of copying.',
      size: 'wide',
      window: true,
      winKey: 'rename',
      defaultWidth: 720,
      body: wrap,
      buttons: [
        { label: 'CANCEL', className: 'secondary', align: 'left' },
        {
          label: 'RENAME FILES',
          className: 'primary',
          keepOpen: true,
          onClick: () => startRenameFromPanel(),
        },
      ],
    });

    const confirmBox = wrap.querySelector('#renConfirm');
    const renameBtn = () => modal.foot.querySelector('.btn.primary');
    confirmBox.addEventListener('change', () => {
      const btn = renameBtn();
      if (btn) btn.disabled = !confirmBox.checked || !(renameState.plan && renameState.plan.summary.ready);
    });

    function paintPlan(plan) {
      renameState.plan = plan;
      const s = plan.summary;
      const cells = [
        ['TOTAL CLIPS', s.total],
        ['WILL RENAME', s.ready],
        ['ALREADY CORRECT', s.unchanged],
        ['CANNOT RENAME', s.blocked],
        ['SIZE', s.totalBytesText],
        ['FOLDER', s.folder ? s.folder.split(/[\\/]/).pop() : '—'],
      ];
      wrap.querySelector('#renSummary').innerHTML = cells
        .map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v ${String(v).length > 7 ? 'small' : ''}">${escapeHtml(String(v))}</span></div>`)
        .join('');

      const rows = [];
      const blocked = plan.entries.filter((e) => e.status === 'blocked');
      const notes = plan.entries.filter((e) => e.status === 'ready' && e.problem);
      if (blocked.length) {
        rows.push(`<div class="list-line error">${blocked.length} clip${blocked.length === 1 ? '' : 's'} will be skipped:</div>`);
        blocked.slice(0, 8).forEach((b) => rows.push(`<div class="list-line error">${escapeHtml(`${b.originalName} — ${b.problem}`)}</div>`));
        if (blocked.length > 8) rows.push(`<div class="list-line error">…and ${blocked.length - 8} more.</div>`);
      }
      if (notes.length) {
        rows.push(`<div class="list-line warning">${notes.length} file${notes.length === 1 ? '' : 's'} get a suffix to avoid a name clash.</div>`);
      }
      if (s.ready === 0 && s.unchanged > 0) rows.push('<div class="list-line info">Every clip already has its final filename.</div>');
      if (!rows.length) rows.push('<div class="list-line info">No problems found — ready to rename.</div>');
      wrap.querySelector('#renChecks').innerHTML = `<h4>PRE-FLIGHT CHECK</h4>${rows.slice(0, 20).join('')}`;

      const btn = renameBtn();
      if (btn) {
        btn.disabled = !confirmBox.checked || s.ready === 0;
        btn.textContent = s.ready ? `RENAME ${s.ready} FILE${s.ready === 1 ? '' : 'S'}` : 'NOTHING TO RENAME';
      }
    }

    async function refreshPlan() {
      const clips = App.state.project.clips.map(toRenameClip);
      const res = await FF.renamer.plan({ clips, options: {} });
      if (!res || !res.ok) {
        wrap.querySelector('#renChecks').innerHTML = `<div class="list-line error">${escapeHtml((res && res.error) || 'The rename could not be prepared.')}</div>`;
        return;
      }
      paintPlan(res.plan);
    }

    async function startRenameFromPanel() {
      if (!confirmBox.checked) {
        UI.toast('Tick the confirmation box first — this is the one action that renames your originals.', { type: 'warning' });
        return;
      }
      const plan = renameState.plan;
      if (!plan || !plan.summary.ready) return;

      const clips = App.state.project.clips.map(toRenameClip);
      renameState.running = true;
      renameState.result = null;

      const progress = UI.busy({
        title: 'Renaming files',
        message: `Renaming 0 of ${plan.summary.ready}…`,
        cancellable: true,
        cancelLabel: 'STOP RENAMING',
        onCancel: () => FF.renamer.cancel(),
      });
      renameState.busy = progress;

      // The planning dialog is stale the moment the job starts (its counts
      // describe files that are about to have different names), and leaving it
      // stacked behind the progress and the report means closing two dialogs.
      modal.close(null);

      const res = await FF.renamer.start({ clips, options: {}, confirmed: true });
      renameState.running = false;
      renameState.busy = null;
      progress.close();
      if (!res || (!res.renamed && res.ok === false)) {
        UI.toast((res && res.error) || 'The rename could not start.', { type: 'error', title: 'Rename failed' });
        return;
      }
      // This call owns the result, so the report is drawn here even if the
      // RENAME_DONE broadcast never made it into the renderer.
      renameState.handled = true;
      if (res.changes && res.changes.length) App.applyRenameChanges(res.changes);
      renameState.result = res;
      paintRenameResult(res);
      App.setStatus(`${res.renamed} file${res.renamed === 1 ? '' : 's'} renamed.`);
    }

    await refreshPlan();
    return modal;
  }

  /** Progress painting for the rename busy dialog (real percentages). */
  /**
   * The renaming console in the bottom band carries its own live progress bar,
   * so the percentage is visible even with the pop-up out of the way.
   */
  function consoleProgress(percent, label) {
    const wrap = document.getElementById('consoleProgress');
    const fill = document.getElementById('consoleProgressFill');
    const text = document.getElementById('consoleProgressLabel');
    if (!wrap || !fill || !text) return;
    if (percent === null || percent === undefined) {
      wrap.hidden = true;
      fill.style.width = '0%';
      text.textContent = '';
      return;
    }
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    wrap.hidden = false;
    fill.style.width = `${pct}%`;
    text.textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}%${label ? ` · ${label}` : ''}`;
    // Kept for diagnostics (and the automated UI test): the last real value,
    // even after the bar is hidden again.
    wrap.dataset.last = text.textContent;
  }

  function paintRenameProgress(p) {
    if (!p) return;
    const pct = Number.isFinite(p.percent) ? p.percent : 0;
    const done = `${p.completed || 0}/${p.total || 0}`;
    consoleProgress(
      pct,
      p.stage === 'undoing' ? `restoring originals ${done}` : `${p.currentTarget || 'preparing'} · ${done}`
    );
    if (!renameState.busy) return;
    const percent = Number.isFinite(p.percent) ? p.percent : 0;
    const eta = p.etaSeconds === null || p.etaSeconds === undefined ? '—' : formatEta(p.etaSeconds);
    renameState.busy.setMessage(
      p.stage === 'undoing'
        ? `Putting the original names back — ${p.completed || 0} of ${p.total || 0}`
        : `${p.currentTarget ? `${p.currentName} → ${p.currentTarget}` : p.currentName || 'Preparing…'}`
    );
    renameState.busy.setProgress(percent, `${percent.toFixed(1)}% · ${p.completed || 0}/${p.total || 0} files · left ${eta}`);
  }

  function paintRenameResult(result) {
    const body = document.createElement('div');
    body.className = 'modal-section';
    body.innerHTML = `
      <div class="kv-grid four">
        <div class="kv"><span class="k">RENAMED</span><span class="v">${result.renamed}</span></div>
        <div class="kv"><span class="k">ALREADY CORRECT</span><span class="v">${result.skipped}</span></div>
        <div class="kv"><span class="k">SKIPPED</span><span class="v">${result.blocked}</span></div>
        <div class="kv"><span class="k">TIME</span><span class="v small">${formatEta(result.elapsedSeconds)}</span></div>
      </div>
      <div class="path-value">${escapeHtml(result.folder || '')}</div>
      <p class="modal-note">Nothing was copied, nothing was deleted, and no file was overwritten.</p>
      ${result.failed.length ? '<h4>COULD NOT RENAME</h4><div class="list-scroll" id="renFail"></div>' : ''}
    `;
    const list = body.querySelector('#renFail');
    if (list) {
      result.failed.slice(0, 40).forEach((f) => {
        const d = document.createElement('div');
        d.className = 'list-line error';
        d.textContent = `${f.fileName} — ${f.message}`;
        list.appendChild(d);
      });
    }

    const changes = result.changes || [];
    renameState.lastChanges = changes;
    UI.modal({
      title: result.cancelled ? 'Rename stopped' : 'Files renamed',
      size: 'wide',
      window: true,
      winKey: 'renameReport',
      defaultWidth: 720,
      body,
      buttons: [
        changes.length
          ? {
              label: 'UNDO RENAME',
              className: 'secondary',
              align: 'left',
              onClick: async () => {
                const undoRes = await FF.renamer.undo({ changes });
                if (undoRes && undoRes.ok) {
                  App.applyRenameChanges(changes, { undo: true });
                  UI.toast(`Put ${undoRes.restored} original name${undoRes.restored === 1 ? '' : 's'} back.`, { type: 'success' });
                } else {
                  UI.toast((undoRes && undoRes.error) || 'Some files could not be put back — see the report.', { type: 'warning' });
                }
                return { keepOpen: false };
              },
            }
          : null,
        { label: 'CLOSE', className: 'primary' },
      ].filter(Boolean),
    });
  }

  // =========================================================================
  // Export
  // =========================================================================
  function exportOptions() {
    const state = App.state;
    const settings = state.settings || {};
    return {
      mode: (state.project.exportSettings && state.project.exportSettings.mode) || settings.defaultExportMode || 'folder',
      layout: (state.project.exportSettings && state.project.exportSettings.layout) || settings.exportLayout || 'flat',
      destination: (state.project.exportSettings && state.project.exportSettings.destination) || settings.defaultExportLocation || '',
      duplicateNaming: settings.duplicateNaming || 'suffix',
      keepGoing: true,
    };
  }

  async function openExport() {
    const state = App.state;
    if (!state.project.clips.length) {
      UI.toast('Import some clips first — there is nothing to export yet.', { type: 'warning', title: 'Nothing to export' });
      return;
    }

    exportState.options = exportOptions();
    const wrap = document.createElement('div');
    wrap.className = 'modal-section';
    wrap.innerHTML = `
      <div class="kv-grid four" id="expSummary"></div>
      <h4>WHAT EXPORT DOES</h4>
      <div class="list-line info">Copies each clip to the destination folder with its new name. That is all it does — no re-encoding, and <b>your originals are never touched</b>. Copying large rushes takes time: if you only want the files renamed, use <b>Rename</b> instead (instant, no copying).</div>
      <div class="rename-shortcut note-inline">
        <span>Want it instantly?</span>
        <button class="btn subtle" id="expGoRename" type="button">Rename the files instead (no copy)</button>
      </div>
      <h4>FOLDER STRUCTURE</h4>
      <div class="layout-choice" id="expLayout" role="radiogroup" aria-label="Folder structure">
        <button class="layout-option" type="button" data-layout="flat" role="radio" aria-checked="true">
          <b>Straight into the folder</b>
          <span>Every renamed clip lands directly in the destination you pick.</span>
        </button>
        <button class="layout-option" type="button" data-layout="scenes" role="radio" aria-checked="false">
          <b>Scene folders</b>
          <span>Windows them into Scene_01, Scene_02 … (never Shot or Take).</span>
        </button>
      </div>
      <h4>DESTINATION</h4>
      <div class="path-row">
        <div class="path-value" id="expDestination">No destination chosen</div>
        <button class="btn secondary" id="expChoose" type="button">Choose folder…</button>
      </div>
      <div id="expChecks" class="modal-section"></div>
      <div id="expFolders" class="modal-note"></div>
    `;

    const modal = UI.modal({
      title: 'Export (copies)',
      subtitle: 'Source footage stays read-only — export copies each clip with its new name.',
      size: 'wide',
      window: true,
      winKey: 'export',
      defaultWidth: 700,
      body: wrap,
      buttons: [
        { label: 'CANCEL', className: 'secondary', align: 'left' },
        { label: 'EXPORT', className: 'primary', autofocus: true, keepOpen: true, onClick: () => startExportFromPanel(false) },
      ],
    });

    wrap.querySelector('#expGoRename').addEventListener('click', () => {
      modal.close(null);
      openRename();
    });

    wrap.querySelector('#expChoose').addEventListener('click', async () => {
      const res = await FF.dialog.chooseDestination({
        title: 'Choose the export folder',
        defaultPath: exportState.options.destination || undefined,
      });
      if (res && res.ok) {
        exportState.options.destination = res.folderPath;
        state.project.exportSettings = Object.assign({}, state.project.exportSettings, { destination: res.folderPath });
        App.markDirty();
        refreshPlan();
      }
    });

    function paintLayoutChoice() {
      const chosen = exportState.options.layout === 'scenes' ? 'scenes' : 'flat';
      wrap.querySelectorAll('#expLayout .layout-option').forEach((btn) => {
        const on = btn.dataset.layout === chosen;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }

    wrap.querySelectorAll('#expLayout .layout-option').forEach((btn) => {
      btn.addEventListener('click', async () => {
        exportState.options.layout = btn.dataset.layout === 'scenes' ? 'scenes' : 'flat';
        state.project.exportSettings = Object.assign({}, state.project.exportSettings, { layout: exportState.options.layout });
        App.markDirty();
        paintLayoutChoice();
        // Remembered for next time as well.
        try {
          await FF.settings.set({ exportLayout: exportState.options.layout });
        } catch (_) {
          /* the panel keeps working even if the setting cannot be stored */
        }
        await refreshPlan();
      });
    });

    function paintSummary(plan) {
      const s = plan.summary;
      const processed = state.project.clips.filter((c) => c.status === STATUS.APPLIED || c.status === STATUS.EXPORTED).length;
      const cells = [
        ['TOTAL CLIPS', s.total],
        ['PROCESSED', processed],
        ['SCENES', s.scenes],
        ['EXTRAS', s.extras],
        ['WARNINGS', s.warnings],
        ['BLOCKED', s.blocked],
        ['SIZE', s.totalBytesText],
        ['MODE', s.layout === 'scenes' ? 'SCENE FOLDERS' : 'SAME FOLDER'],
      ];
      wrap.querySelector('#expSummary').innerHTML = cells
        .map(
          ([k, v]) =>
            `<div class="kv"><span class="k">${k}</span><span class="v ${String(v).length > 6 ? 'small' : ''}">${String(v)}</span></div>`
        )
        .join('');
    }

    function paintChecks(plan) {
      const box = wrap.querySelector('#expChecks');
      const rows = [];
      (plan.destinationChecks.messages || []).forEach((m) => rows.push({ level: m.level, text: m.message }));
      const blocked = plan.entries.filter((e) => e.status === 'blocked');
      const problems = plan.problems.filter((p) => p.level === 'warning');
      if (blocked.length) {
        rows.push({
          level: 'error',
          text: `${blocked.length} clip${blocked.length === 1 ? '' : 's'} cannot be exported:`,
        });
        blocked.slice(0, 8).forEach((b) => rows.push({ level: 'error', text: `${b.fileName} — ${b.problem}` }));
        if (blocked.length > 8) rows.push({ level: 'error', text: `…and ${blocked.length - 8} more.` });
      }
      if (problems.length) {
        rows.push({ level: 'warning', text: `${problems.length} clip note${problems.length === 1 ? '' : 's'}:` });
        problems.slice(0, 6).forEach((p) => rows.push({ level: 'warning', text: p.message }));
      }
      if (!rows.length) rows.push({ level: 'info', text: 'No problems found. Ready to export.' });
      box.innerHTML =
        '<h4>PRE-FLIGHT CHECK</h4>' +
        rows
          .slice(0, 20)
          .map((r) => `<div class="list-line ${r.level}">${escapeHtml(r.text)}</div>`)
          .join('');
      wrap.querySelector('#expFolders').textContent =
        plan.summary.layout === 'scenes'
          ? plan.folders.length
            ? `Folders that will be created (by Scene only): ${plan.folders.join('  ·  ')}`
            : 'No Scene folders yet — assign Scene numbers to organise the output.'
          : `No sub-folders: every file is copied into ${exportState.options.destination || 'the destination folder'} itself.`;
      wrap.querySelector('#expDestination').textContent = exportState.options.destination || 'No destination chosen';
    }

    async function refreshPlan() {
      const state2 = App.state;
      const clips = state2.project.clips.map(toExportClip);
      const res = await FF.exporter.plan({ clips, options: exportState.options });
      if (!res || !res.ok) {
        wrap.querySelector('#expChecks').innerHTML = `<div class="list-line error">${escapeHtml((res && res.error) || 'The export could not be prepared.')}</div>`;
        return null;
      }
      exportState.plan = res.plan;
      paintSummary(res.plan);
      paintChecks(res.plan);
      const exportBtn = modal.foot.querySelector('.btn.primary');
      if (exportBtn) {
        const ready = res.plan.summary.ready;
        exportBtn.disabled = ready === 0;
        exportBtn.textContent = ready ? `EXPORT ${ready} CLIP${ready === 1 ? '' : 'S'}` : 'NOTHING TO EXPORT';
      }
      return res.plan;
    }

    paintLayoutChoice();
    await refreshPlan();

    panelRefs.exportModal = modal;
    panelRefs.refreshPlan = refreshPlan;
    return modal;
  }

  const panelRefs = {};

  /** Strips renderer-only fields before sending clips to the exporter. */
  function toExportClip(clip) {
    return {
      id: clip.id,
      sourcePath: clip.sourcePath,
      fileName: clip.fileName,
      size: clip.size,
      sceneOn: clip.sceneOn,
      scene: clip.scene,
      shotOn: clip.shotOn,
      shot: clip.shot,
      takeOn: clip.takeOn,
      take: clip.take,
      extra: clip.extra,
      customOn: clip.customOn,
      custom: clip.custom,
      timeText: clip.timeText,
      status: clip.status,
      meta: clip.meta ? { duration: clip.meta.duration } : null,
    };
  }

  async function startExportFromPanel(onlyValid) {
    const modal = panelRefs.exportModal;
    const plan = panelRefs.refreshPlan ? await panelRefs.refreshPlan() : null;
    if (!plan) return false;
    if (!plan.destinationChecks.ok) {
      UI.toast((plan.destinationChecks.messages.find((m) => m.level === 'error') || {}).message || 'Choose a destination first.', {
        type: 'error',
        title: 'Export cannot start',
      });
      return false;
    }
    if (onlyValid) {
      plan.entries = plan.entries.filter((e) => e.status !== 'blocked');
    }
    if (plan.summary.ready === 0) {
      UI.toast('No clips are ready to export.', { type: 'warning' });
      return false;
    }
    // warn about blocked clips and let the user continue with the valid ones
    const blocked = plan.entries.filter((e) => e.status === 'blocked');
    if (blocked.length && !onlyValid) {
      const proceed = await UI.confirm({
        title: 'Some clips cannot be exported',
        message: `${blocked.length} clip${blocked.length === 1 ? '' : 's'} will be skipped (missing source file or missing metadata).`,
        detail: 'The remaining clips will be exported normally. You can fix and re-export the skipped ones later.',
        confirmLabel: 'CONTINUE',
        cancelLabel: 'CANCEL',
      });
      if (!proceed) return false;
    }
    if (modal) modal.close('export');
    if (App.state.project.exportSettings) {
      App.state.project.exportSettings.destination = exportState.options.destination;
    }
    App.markDirty();
    runExport();
    return true;
  }

  function runExport() {
    const state = App.state;
    exportState.running = true;

    const wrap = document.createElement('div');
    wrap.className = 'modal-section';
    wrap.innerHTML = `
      <div class="progress-now" id="exNow">Preparing export…</div>
      <div class="progress-outer"><div class="progress-inner" id="exBar"></div></div>
      <div class="progress-meta"><span id="exPct">0%</span><span id="exEta"></span></div>
      <div class="kv-grid" id="exGrid"></div>
      <div class="path-value" id="exDest"></div>
      <div class="list-scroll" id="exFailures" style="display:none"></div>
    `;

    const busy = UI.busy({
      title: 'Exporting clips',
      message: 'Starting…',
      cancellable: true,
      cancelLabel: 'Cancel export',
      onCancel: () => FF.exporter.cancel(),
    });
    busy.el.querySelector('.modal-body').replaceChildren(wrap);
    exportState.busy = busy;

    FF.exporter
      .start({ clips: state.project.clips.map(toExportClip), options: exportState.options })
      .then((res) => {
        if (res && res.ok === false) {
          finishExport({ ok: false, error: (res && res.error) || 'The export could not start.' });
        }
      })
      .catch((err) => finishExport({ ok: false, error: err.message }));
  }

  function paintProgress(progress) {
    if (!exportState.busy) return;
    const bar = $('exBar');
    if (!bar) return;
    bar.style.width = `${progress.percent || 0}%`;
    $('exPct').textContent = `${(progress.percent || 0).toFixed(0)}%`;
    const current = progress.currentName ? `${progress.currentName}` : progress.stage === 'finalising' ? 'Finalising archive…' : 'Preparing…';
    $('exNow').textContent = current;
    const eta = progress.etaSeconds === null || progress.etaSeconds === undefined ? '—' : formatEta(progress.etaSeconds);
    $('exEta').textContent = `Remaining: ${eta} · Elapsed: ${formatEta(progress.elapsedSeconds || 0)}`;
    $('exGrid').innerHTML = [
      ['CLIP', `${progress.completed || 0} / ${progress.total || 0}`],
      ['SCENE', progress.currentScene || '—'],
      ['SOURCE', progress.currentSource || '—'],
      ['BYTES', `${humanBytes(progress.bytesDone)} / ${humanBytes(progress.bytesTotal)}`],
    ]
      .map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v small">${escapeHtml(String(v))}</span></div>`)
      .join('');
    $('exDest').textContent = progress.destination || '';
  }

  function formatEta(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function humanBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i += 1;
    }
    return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
  }

  function finishExport(result) {
    exportState.running = false;
    const state = App.state;

    if (result && Array.isArray(result.results)) {
      const byId = new Map(result.results.map((r) => [r.id, r]));
      let changed = false;
      for (const clip of state.project.clips) {
        const r = byId.get(clip.id);
        if (!r) continue;
        if (r.status === 'exported') {
          clip.status = STATUS.EXPORTED;
          changed = true;
        } else if (r.status === 'failed') {
          clip.status = STATUS.SKIPPED;
          changed = true;
        }
      }
      if (changed) App.markDirty();
    }

    if (exportState.busy) exportState.busy.close();
    App.renderBrowser(true);
    App.renderFooter();

    if (!result || result.ok === false) {
      if (result && result.cancelled) {
        UI.toast('Export cancelled. Partial files were removed where possible.', { type: 'warning', title: 'Export cancelled' });
      } else {
        UI.modal({
          title: 'Unable to export',
          size: 'small',
          window: true,
          winKey: 'exportError',
          defaultWidth: 460,
          body: `<div class="modal-section"><p style="font-size:13.5px;margin:0">${escapeHtml(
            (result && result.error) || 'The export could not be completed.'
          )}</p><p class="modal-note">The source file may be missing or inaccessible. Your originals are untouched.</p></div>`,
          buttons: [
            { label: 'CANCEL', className: 'secondary' },
            { label: 'RETRY', className: 'primary', keepOpen: true, onClick: () => { runExport(); return true; } },
          ],
        });
      }
      App.setStatus('Export did not complete.', 'warn');
      return;
    }

    const failures = result.results.filter((r) => r.status === 'failed');
    const skipped = result.results.filter((r) => r.status === 'skipped');

    const body = document.createElement('div');
    body.className = 'modal-section';
    body.innerHTML = `
      <div class="kv-grid four">
        <div class="kv"><span class="k">EXPORTED</span><span class="v">${result.exported}</span></div>
        <div class="kv"><span class="k">SKIPPED</span><span class="v">${result.skipped}</span></div>
        <div class="kv"><span class="k">FAILED</span><span class="v">${result.failed}</span></div>
        <div class="kv"><span class="k">TIME</span><span class="v small">${formatEta(result.seconds)}</span></div>
      </div>
      <div class="path-value">${escapeHtml(result.destination || '')}</div>
      <p class="modal-note">${
        result.layout === 'scenes'
          ? 'Organised into Scene folders only — shots and takes stay inside their Scene folder.'
          : 'Every file was copied straight into the destination folder. Your originals were not touched.'
      }</p>
      ${failures.length || skipped.length ? '<h4>NOTES</h4>' : ''}
      <div class="list-scroll" id="resList"></div>
    `;
    const list = body.querySelector('#resList');
    failures.slice(0, 40).forEach((f) => {
      const d = document.createElement('div');
      d.className = 'list-line error';
      d.textContent = `${f.fileName} — ${f.message}`;
      list.appendChild(d);
    });
    skipped.slice(0, 20).forEach((s) => {
      const d = document.createElement('div');
      d.className = 'list-line warning';
      d.textContent = `${s.fileName} — ${s.message || 'Skipped because the destination file already exists.'}`;
      list.appendChild(d);
    });

    UI.modal({
      title: result.cancelled ? 'Export cancelled' : 'Export complete',
      subtitle: result.cancelled ? 'Some clips were not exported.' : `${result.exported} clip${result.exported === 1 ? '' : 's'} exported.`,
      size: 'wide',
      window: true,
      winKey: 'exportReport',
      defaultWidth: 720,
      body,
      buttons: [
        {
          label: 'OPEN DESTINATION',
          className: 'secondary',
          align: 'left',
          onClick: () => {
            FF.shell.openPath({ path: result.destination });
          },
        },
        { label: 'CLOSE', className: 'primary' },
      ],
    });

    App.setStatus(`Export finished: ${result.exported} exported, ${result.skipped} skipped, ${result.failed} failed.`);
  }

  // =========================================================================
  // Project files
  // =========================================================================
  async function newProject() {
    const state = App.state;
    const proceed = async () => {
      if (state.dirty) {
        const choice = await UI.modal({
          title: 'Unsaved changes',
          size: 'small',
          body: '<div class="modal-section"><p style="margin:0;font-size:13.5px">This project has unsaved metadata changes.</p><p class="modal-note">Original footage is never affected — this is only about the project file.</p></div>',
          buttons: [
            { label: 'CANCEL', className: 'secondary', value: 'cancel' },
            { label: 'DISCARD CHANGES', className: 'danger', value: 'discard' },
            { label: 'SAVE FIRST', className: 'primary', value: 'save', autofocus: true },
          ],
        });
        if (choice === 'cancel' || !choice) return false;
        if (choice === 'save') {
          const saved = await saveProject(false);
          if (!saved) return false;
        }
      }
      App.setProject(App.emptyProject('Untitled Project'), '', { markClean: true });
      App.setStatus('New project created.');
      UI.toast('New project ready. Import clips to begin.', { type: 'info' });
      return true;
    };
    await proceed();
  }

  async function openProject() {
    const state = App.state;
    if (state.dirty) {
      const choice = await UI.modal({
        title: 'Unsaved changes',
        size: 'small',
        body: '<div class="modal-section"><p style="margin:0;font-size:13.5px">Save the current project before opening another one?</p></div>',
        buttons: [
          { label: 'CANCEL', className: 'secondary', value: 'cancel' },
          { label: 'DISCARD CHANGES', className: 'danger', value: 'discard' },
          { label: 'SAVE FIRST', className: 'primary', value: 'save', autofocus: true },
        ],
      });
      if (choice === 'cancel' || !choice) return;
      if (choice === 'save') {
        const saved = await saveProject(false);
        if (!saved) return;
      }
    }

    const picked = await FF.dialog.openProject();
    if (!picked || !picked.ok) return;
    const res = await FF.project.open({ filePath: picked.filePath });
    if (!res || res.ok === false) {
      UI.toast((res && res.error) || 'That project file could not be opened.', { type: 'error', title: 'Open failed' });
      return;
    }
    App.setProject(res.project, res.filePath, { markClean: true });
    App.setStatus(`Opened ${res.project.name} — ${res.project.clips.length} clips.`);
    UI.toast(`${res.project.clips.length} clips restored from the project file.`, { type: 'success', title: 'Project opened' });
  }

  async function saveProject(forceDialog) {
    const state = App.state;
    const payload = {
      project: App.serializeProject(),
      filePath: forceDialog ? '' : state.projectPath || '',
    };
    const res = await FF.project.save(payload);
    if (!res || res.ok === false) {
      if (res && res.cancelled) return false;
      UI.toast((res && res.error) || 'The project could not be saved.', { type: 'error', title: 'Save failed' });
      return false;
    }
    state.projectPath = res.filePath;
    App.markClean();
    App.updateProjectMeta();
    App.setStatus(`Project saved — ${res.clipCount} clips of metadata.`);
    UI.toast('Project saved (metadata only — your footage was not touched).', { type: 'success', timeout: 2600 });
    return true;
  }

  // =========================================================================
  // Sample project
  // =========================================================================
  async function loadSample() {
    const busy = UI.busy({
      title: 'Preparing the sample project',
      message: 'Generating short synthetic clips with FFmpeg (only happens once)…',
      cancellable: false,
    });
    try {
      const res = await FF.demo.generate();
      if (!res || res.ok === false) {
        busy.close();
        const engines = await FF.settings.checkEngines();
        if (!engines.ffmpeg.ok) {
          UI.modal({
            title: 'Sample clips need FFmpeg',
            size: 'small',
            body:
              '<div class="modal-section"><p style="margin:0;font-size:13.5px">The sample project is created locally with FFmpeg, which was not found on this machine.</p>' +
              '<p class="modal-note">Everything else already works: import your own clips, tag Scene / Shot / Take, hover-preview, rename and export. To enable the sample project (and clip durations + reference timecodes), point the app at ffmpeg.exe and ffprobe.exe in Settings → Media engine → Locate.</p></div>',
            buttons: [
              { label: 'CLOSE', className: 'secondary' },
              {
                label: 'OPEN SETTINGS',
                className: 'primary',
                onClick: () => {
                  openSettings();
                },
              },
            ],
          });
          return;
        }
        UI.toast((res && res.error) || 'The sample clips could not be created.', { type: 'error', title: 'Sample unavailable' });
        return;
      }
      busy.close();

      // Build the project through the normal import pipeline.
      const state = App.state;
      const project = App.emptyProject('Sample Project — Fusion Flix');
      App.setProject(project, '', { markClean: true });

      const importResult = await FF.importClips.run({ paths: res.files, projectSettings: project.settings });
      const clips = (importResult && importResult.clips) || [];
      clips.forEach((clip, i) => {
        clip.order = i;
      });
      // Placeholder metadata so every panel shows realistic content.
      // Placeholder metadata matched to the generated sample clip names so the
      // interface shows realistic content in every panel.
      const demoMeta = [
        { scene: 1, shot: 1, take: 1, customOn: true, custom: 'City B-Roll Opening' }, // 01_city_broll
        { scene: 1, shot: 1, take: 2, customOn: true, custom: 'Opening Drone Shot' }, // 02_drone_pass
        { scene: 1, shot: 2, take: 1 }, // 03_interview_a
        { scene: 2, shot: 1, take: 1, customOn: true, custom: 'Interview A — Master' }, // 04_interview_b
        { scene: 2, shot: 1, take: 2, extra: true }, // 05_cu_hands
        { scene: 2, shot: 2, take: 1 }, // 06_wide_establish
        { scene: 3, shot: 1, take: 1, extra: true }, // 07_detail_macro
        {}, // 08_closing_shot — left untagged so the first-run flow is visible
      ];
      clips.forEach((clip, i) => {
        const meta = demoMeta[i] || {};
        clip.sceneOn = meta.scene !== undefined;
        clip.scene = meta.scene === undefined ? null : meta.scene;
        clip.shotOn = meta.shot !== undefined;
        clip.shot = meta.shot === undefined ? null : meta.shot;
        clip.takeOn = meta.take !== undefined;
        clip.take = meta.take === undefined ? null : meta.take;
        clip.extra = Boolean(meta.extra);
        clip.customOn = Boolean(meta.customOn);
        clip.custom = meta.custom || '';
        clip.status = i < 6 ? STATUS.APPLIED : STATUS.NEW;
      });

      state.project.clips = clips;
      state.project.name = 'Sample Project — Fusion Flix';
      App.state.project.name = state.project.name;
      $('projectName').value = state.project.name;
      state.currentClipId = clips.length ? clips[0].id : null;
      App.markDirty();
      App.refreshAll();
      App.selectClip(clips.length ? clips[0].id : null);
      App.updateWelcome();
      App.setStatus(`Sample project ready — ${clips.length} generated clips. Nothing was downloaded.`);
      UI.toast('Sample project loaded. Hover a thumbnail to preview and try Apply & Next.', { type: 'success', title: 'Sample project', timeout: 6000 });
    } catch (err) {
      busy.close();
      UI.toast(err.message || 'The sample project could not be prepared.', { type: 'error' });
    }
  }

  // =========================================================================
  // Settings
  // =========================================================================
  const ACCENT_PRESETS = [
    { name: 'Fusion Orange', hex: '#f0562f' },
    { name: 'Ember', hex: '#e0721e' },
    { name: 'Gold', hex: '#e0a020' },
    { name: 'Lime', hex: '#7cb518' },
    { name: 'Mint', hex: '#12b886' },
    { name: 'Teal', hex: '#0ea5a5' },
    { name: 'Azure', hex: '#3b82f6' },
    { name: 'Violet', hex: '#8b5cf6' },
    { name: 'Rose', hex: '#e0245e' },
    { name: 'Graphite', hex: '#8b95a1' },
  ];

  /**
   * Opens the media-engine part of Settings. The player uses this from its
   * "this clip cannot be shown" notice, so a user with camera codecs can fix
   * preview with one click instead of hunting through menus.
   */
  function openEngineSetup() {
    const modal = openSettings();
    Promise.resolve(modal)
      .then(() => {
        const row = document.querySelector('#setDownloadEngine');
        const scrollTo = row && row.closest ? row.closest('.setting-row') : null;
        if (scrollTo && scrollTo.scrollIntoView) scrollTo.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (row && row.focus) row.focus();
      })
      .catch(() => {});
    return modal;
  }

  /**
   * The one and only FFmpeg download flow — used by Settings, the welcome
   * panel card and the player's "cannot be shown" notice.
   */
  async function downloadEngine() {
    const enginesNow = await FF.settings.checkEngines();
    const go = await UI.confirm({
      title: 'Download FFmpeg',
      message: enginesNow.ffmpeg.ok ? 'FFmpeg is already available. Download again and replace it?' : 'Download the official Windows build of FFmpeg (about 35 MB)?',
      detail: 'It is fetched from the official FFmpeg build server and unpacked into this installation\u2019s ffmpeg folder. Needs an internet connection \u2014 everything else in the app stays offline.',
      confirmLabel: 'DOWNLOAD',
    });
    if (!go) return;

    const progress = UI.busy({
      title: 'Downloading FFmpeg',
      message: 'Starting\u2026',
      cancellable: true,
      cancelLabel: 'CANCEL DOWNLOAD',
      onCancel: () => FF.engineDownload.cancel(),
    });
    engineState.busy = (p) => {
      const percent = Number(p.percent) || 0;
      progress.setMessage(p.message || 'Downloading\u2026');
      progress.setProgress(percent, `${percent.toFixed(1)}%${p.received ? ` \u00b7 ${(p.received / 1048576).toFixed(1)} MB` : ''}`);
    };
    engineState.busy.done = () => {
      progress.close();
      App.state.thumbs = new Map();
      App.state.thumbRequested = new Set();
      App.renderBrowser(true);
      App.checkMissingMedia(false);
      FF.settings.checkEngines().then(paintEngines);
    };

    const res = await FF.engineDownload.start({});
    if (!res || !res.ok) {
      progress.close();
      engineState.busy = null;
      UI.toast((res && res.error) || 'The download could not be started.', { type: 'error', title: 'Download failed' });
      return;
    }
    if (App.invalidateEngine) App.invalidateEngine();
  }

  async function openSettings() {
    const state = App.state;
    const current = await FF.settings.get();
    const engines = await FF.settings.checkEngines();

    const wrap = document.createElement('div');
    wrap.className = 'settings-grid';
    wrap.innerHTML = `
      <h4 class="shortcut-group-title">APPEARANCE</h4>
      <div class="setting-row">
        <div class="setting-label"><b>Theme</b><span>Cinema is the standard dark look, Daylight is the white one, Midnight is darker still.</span></div>
        <div class="setting-control">
          <select class="input select" id="setTheme">
            <option value="cinema">Cinema (dark)</option>
            <option value="daylight">Daylight (white)</option>
            <option value="midnight">Midnight (black)</option>
          </select>
        </div>
      </div>
      <div class="setting-row" style="align-items:flex-start">
        <div class="setting-label"><b>Button &amp; accent colour</b><span>Used for buttons, highlights, the active clip and the filename preview. Pick a swatch or any colour with the wheel.</span></div>
        <div class="setting-control" style="flex:1 1 auto; min-width:0">
          <div class="swatch-row" id="accentSwatches"></div>
          <div class="color-wheel-row">
            <input type="color" class="color-wheel" id="accentWheel" aria-label="Choose accent colour">
            <input type="text" class="input hex-input" id="accentHex" maxlength="7" spellcheck="false" aria-label="Accent colour hex code">
            <button class="btn subtle mini" id="accentReset" type="button">Reset</button>
          </div>
        </div>
      </div>

      <h4 class="shortcut-group-title">TAGGING DEFAULTS</h4>
      <div class="setting-row">
        <div class="setting-label"><b>Scene / Shot / Take start switched on</b><span>Every newly imported clip begins with these fields enabled, ready for NEXT FROM PREVIOUS. Clips already imported are not changed.</span></div>
        <div class="setting-control" style="gap:14px">
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="defSceneOn" class="checkbox"> <span>Scene</span></label>
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="defShotOn" class="checkbox"> <span>Shot</span></label>
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="defTakeOn" class="checkbox"> <span>Take</span></label>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><b>Starting numbers</b><span>Where a fresh import begins counting.</span></div>
        <div class="setting-control" style="gap:8px">
          <input type="number" class="input number" id="defSceneValue" min="0" max="99999" aria-label="Starting Scene number" title="Starting Scene">
          <input type="number" class="input number" id="defShotValue" min="0" max="99999" aria-label="Starting Shot number" title="Starting Shot">
          <input type="number" class="input number" id="defTakeValue" min="0" max="99999" aria-label="Starting Take number" title="Starting Take">
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Ticking a box fills it from the previous clip + 1</b><span>Switch Scene / Shot / Take on — with the mouse or Shift+A / Shift+S / Shift+D — and an empty box continues from the clip before it. Runs the same logic as NEXT FROM PREVIOUS.</span></div>
        <div class="setting-control">
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="setAutoFill" class="checkbox"> <span>Enabled</span></label>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><b>Custom Name switches Scene / Shot / Take off</b><span>Typing a custom name replaces the standard S-x_SH-y_T-z filename, so the three switches are cleared for that clip.</span></div>
        <div class="setting-control">
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="setCustomClears" class="checkbox"> <span>Enabled</span></label>
        </div>
      </div>

      <h4 class="shortcut-group-title">PREVIEW</h4>
      <div class="setting-row">
        <div class="setting-label"><b>Hover-shuttle (forward / backward by mouse)</b><span><b>Off by default.</b> When on, moving the pointer towards the left or right edge of the player shuttles backwards or forwards — the further out, the faster (0.25× → 8×).</span></div>
        <div class="setting-control">
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="setHoverShuttle" class="checkbox"> <span>Enabled</span></label>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><b>Hover brings the clip into the main preview</b><span>Hovering a clip in the list loads it into the big player. Turn this off if you prefer the preview to change only when you click.</span></div>
        <div class="setting-control">
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="setHoverPreroll" class="checkbox"> <span>Enabled</span></label>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><b>Simple view (preview only)</b><span>Hide both side panels and give the picture the whole window. Toggle any time with P.</span></div>
        <div class="setting-control">
          <label class="group-label" style="letter-spacing:normal"><input type="checkbox" id="setFocusMode" class="checkbox"> <span>Start in focus view</span></label>
        </div>
      </div>

      <h4 class="shortcut-group-title">KEYBOARD</h4>
      <div id="shortcutEditor" class="shortcut-edit"></div>
      <div id="shortcutWarning"></div>

      <h4 class="shortcut-group-title">FILES &amp; EXPORT</h4>
      <div class="setting-row">
        <div class="setting-label"><b>Default export location</b><span>Pre-filled in the Export panel.</span></div>
        <div class="setting-control">
          <button class="btn secondary" id="setExportDir" type="button">Choose…</button>
        </div>
      </div>
      <div class="path-row"><div class="path-value" id="setExportDirValue"></div></div>

      <div class="setting-row">
        <div class="setting-label"><b>Export location</b><span>Where the Export panel starts. Export always copies into Scene folders.</span></div>
        <div class="setting-control">
          <span class="muted" id="setExportModeNote">Copies · Scene folders only · never overwrites</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Thumbnail cache</b><span>Thumbnails are cached here for instant scrolling.</span></div>
        <div class="setting-control">
          <button class="btn secondary" id="setCacheDir" type="button">Choose…</button>
          <button class="btn subtle" id="setCacheClear" type="button">Clear cache</button>
        </div>
      </div>
      <div class="path-row"><div class="path-value" id="setCacheValue"></div></div>

      <div class="setting-row">
        <div class="setting-label"><b>Preview quality</b><span>Resolution of generated thumbnails. Lower is faster on huge projects.</span></div>
        <div class="setting-control">
          <select class="input select" id="setPreview">
            <option value="low">Low (fastest)</option>
            <option value="medium">Medium (default)</option>
            <option value="high">High (sharpest)</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Autosave project metadata</b><span>Never touches source video — project data only.</span></div>
        <div class="setting-control">
          <select class="input select" id="setAutosave">
            <option value="on">On (every 30 seconds)</option>
            <option value="on60">On (every 60 seconds)</option>
            <option value="off">Off</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Export folder structure</b><span>Export always copies the renamed clips. This is only about where they land inside the destination — the Export window can change it per export.</span></div>
        <div class="setting-control">
          <select class="input select" id="setExportLayout">
            <option value="flat">Straight into the destination folder</option>
            <option value="scenes">Scene_01, Scene_02 … folders</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Duplicate filenames</b><span>What to do when the destination already has that name.</span></div>
        <div class="setting-control">
          <select class="input select" id="setDuplicates">
            <option value="suffix">Add _01, _02 … (never overwrites)</option>
            <option value="skip">Skip that clip</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Timecode fallback</b><span>Used only when a clip has no embedded timecode — never random.</span></div>
        <div class="setting-control">
          <select class="input select" id="setTimecode">
            <option value="file-time">File timestamp (HH-MM-SS of the file)</option>
            <option value="zero">Always 00-00-00</option>
            <option value="index">Project position (00-00-01, 00-00-02 …)</option>
          </select>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label"><b>Media engine</b><span id="engineSummary"></span></div>
        <div class="setting-control">
          <button class="btn accent" id="setDownloadEngine" type="button" title="Downloads the official Windows build of FFmpeg straight into this installation">Download FFmpeg…</button>
          <button class="btn subtle" id="setLocateFfmpeg" type="button">Locate FFmpeg…</button>
          <button class="btn subtle" id="setLocateFfprobe" type="button">Locate FFprobe…</button>
          <button class="btn subtle" id="setCheckEngines" type="button">Check again</button>
        </div>
      </div>
      <div id="engineDetail" class="modal-section"></div>
    `;

    const modal = UI.modal({
      title: 'Settings',
      subtitle: 'Stored outside your projects — they apply to every project.',
      size: 'wide',
      window: true,
      winKey: 'settings',
      defaultWidth: 720,
      body: wrap,
      onClose: (value) => {
        // Closing the panel while a key button is armed must never leave the
        // app listening for a chord — that used to kill every shortcut.
        stopCapture();
        if (value === 'SAVE SETTINGS') return;
        // Cancelled (or ✕): undo the live preview so nothing changes behind the user's back.
        App.applyTheme(current.theme, current.accentColor);
        App.setFocusMode(Boolean(current.focusMode), { persist: false });
      },
      buttons: [
        { label: 'RE-APPLY TIMECODES', className: 'subtle', align: 'left', keepOpen: true, onClick: () => applyTimecodes() },
        { label: 'CANCEL', className: 'secondary' },
        { label: 'SAVE SETTINGS', className: 'primary', autofocus: true, onClick: () => saveSettings() },
      ],
    });

    const draft = Object.assign({}, current);
    const shortcutDraft = Object.assign({}, current.shortcuts || {});
    let accentValue = current.accentColor || '#f0562f';

    const refresh = () => {
      wrap.querySelector('#setExportDirValue').textContent = draft.defaultExportLocation || 'Not set — you choose on every export';
      wrap.querySelector('#setCacheValue').textContent = draft.thumbnailCacheDir || state.info.cacheDir || '';
      wrap.querySelector('#setPreview').value = draft.previewQuality;
      wrap.querySelector('#setAutosave').value = draft.autosaveEnabled === false ? 'off' : (draft.autosaveSeconds || 30) > 30 ? 'on60' : 'on';
      wrap.querySelector('#setDuplicates').value = draft.duplicateNaming;
      wrap.querySelector('#setExportLayout').value = draft.exportLayout === 'scenes' ? 'scenes' : 'flat';
      wrap.querySelector('#setTimecode').value = draft.timecodeFallback;
      wrap.querySelector('#setTheme').value = draft.theme || 'cinema';
      wrap.querySelector('#defSceneOn').checked = draft.defaultSceneOn !== false;
      wrap.querySelector('#defShotOn').checked = draft.defaultShotOn !== false;
      wrap.querySelector('#defTakeOn').checked = draft.defaultTakeOn !== false;
      wrap.querySelector('#defSceneValue').value = String(draft.defaultSceneValue === undefined ? 1 : draft.defaultSceneValue);
      wrap.querySelector('#defShotValue').value = String(draft.defaultShotValue === undefined ? 1 : draft.defaultShotValue);
      wrap.querySelector('#defTakeValue').value = String(draft.defaultTakeValue === undefined ? 1 : draft.defaultTakeValue);
      wrap.querySelector('#setHoverPreroll').checked = draft.hoverPreroll !== false;
      wrap.querySelector('#setHoverShuttle').checked = Boolean(draft.hoverShuttle);
      wrap.querySelector('#setAutoFill').checked = draft.autoFillFromPrevious !== false;
      wrap.querySelector('#setCustomClears').checked = draft.customNameClearsTagging !== false;
      wrap.querySelector('#setFocusMode').checked = Boolean(draft.focusMode);
      paintAccent();
      paintShortcuts();
    };

    // ---- accent colour -----------------------------------------------------
    function paintAccent() {
      const row = wrap.querySelector('#accentSwatches');
      row.innerHTML = '';
      ACCENT_PRESETS.forEach((preset) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = `swatch${preset.hex.toLowerCase() === accentValue.toLowerCase() ? ' on' : ''}`;
        dot.style.background = preset.hex;
        dot.title = `${preset.name} — ${preset.hex}`;
        dot.addEventListener('click', () => {
          accentValue = preset.hex;
          App.applyTheme(draft.theme, accentValue);
          paintAccent();
        });
        row.appendChild(dot);
      });
      wrap.querySelector('#accentWheel').value = accentValue;
      wrap.querySelector('#accentHex').value = accentValue.toUpperCase();
    }
    wrap.querySelector('#accentWheel').addEventListener('input', (event) => {
      accentValue = event.target.value;
      App.applyTheme(draft.theme, accentValue);
      paintAccent();
    });
    wrap.querySelector('#accentHex').addEventListener('change', (event) => {
      const parsed = App.hexToRgb(event.target.value.trim());
      if (!parsed) {
        UI.toast('That is not a valid colour code. Use something like #F0562F.', { type: 'warning' });
        paintAccent();
        return;
      }
      accentValue = App.rgbToHex(parsed);
      App.applyTheme(draft.theme, accentValue);
      paintAccent();
    });
    wrap.querySelector('#accentReset').addEventListener('click', () => {
      accentValue = '#f0562f';
      App.applyTheme(draft.theme, accentValue);
      paintAccent();
    });

    // ---- shortcut editor ---------------------------------------------------
    let capturingId = null;
    function paintShortcuts() {
      const host = wrap.querySelector('#shortcutEditor');
      const merged = FFKeys.mergeBindings(shortcutDraft);
      const conflicts = FFKeys.findConflicts(merged.bindings);
      const clashing = new Set();
      Object.values(conflicts).forEach((ids) => ids.forEach((id) => clashing.add(id)));

      host.innerHTML = '';
      FFKeys.grouped().forEach((group) => {
        const title = document.createElement('div');
        title.className = 'shortcut-group-title';
        title.textContent = group.name.toUpperCase();
        host.appendChild(title);

        group.items.forEach((def) => {
          const line = document.createElement('div');
          line.className = 'shortcut-line';

          const label = document.createElement('div');
          label.className = 'sc-label';
          const b = document.createElement('b');
          b.textContent = def.label;
          label.appendChild(b);
          if (def.hint) {
            const hintSpan = document.createElement('span');
            hintSpan.textContent = def.hint;
            label.appendChild(hintSpan);
          }
          line.appendChild(label);

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'key-btn';
          const combo = merged.bindings[def.id];
          btn.textContent = capturingId === def.id ? 'press keys…' : FFKeys.formatCombo(combo);
          if (capturingId === def.id) btn.classList.add('capturing');
          if (!combo && capturingId !== def.id) btn.classList.add('unbound');
          if (clashing.has(def.id)) {
            btn.classList.add('clash');
            btn.title = `Also used by: ${conflicts[combo].filter((x) => x !== def.id).map((x) => (FFKeys.definitionById(x) || {}).label || x).join(', ')}`;
          }
          btn.addEventListener('click', () => {
            capturingId = def.id;
            App.state.capturingKey = true; // the app's own shortcuts stand aside
            paintShortcuts();
            document.addEventListener('keydown', captureHandler, true);
          });
          line.appendChild(btn);

          const clear = document.createElement('button');
          clear.type = 'button';
          clear.className = 'btn mini subtle';
          clear.textContent = '⨯';
          clear.title = 'Unbind this shortcut';
          clear.addEventListener('click', () => {
            shortcutDraft[def.id] = '';
            stopCapture();
            paintShortcuts();
          });
          line.appendChild(clear);
          host.appendChild(line);
        });
      });

      const warning = wrap.querySelector('#shortcutWarning');
      const clashCount = Object.keys(conflicts).length;
      warning.innerHTML = clashCount
        ? `<div class="shortcut-warning"><b>⚠</b><span>${clashCount} key combination${clashCount === 1 ? ' is' : 's are'} used more than once. The action higher up the list wins — change one of them to avoid surprises.</span></div>`
        : '';
    }

    // capture the next keystroke while a key button is armed
    const stopCapture = () => {
      capturingId = null;
      App.state.capturingKey = false;
      document.removeEventListener('keydown', captureHandler, true);
    };

    const captureHandler = (event) => {
      if (!capturingId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        stopCapture();
        paintShortcuts();
        return;
      }
      const combo = FFKeys.comboFromEvent(event);
      if (!combo) return;
      // Modifier-only presses return '' — keep waiting for a real key.
      shortcutDraft[capturingId] = combo;
      stopCapture();
      paintShortcuts();
    };

    function paintEngines(info) {
      const rows = [
        { name: 'FFmpeg', ok: info.ffmpeg.ok, version: info.ffmpeg.version || info.ffmpeg.error || '', path: info.ffmpeg.path },
        { name: 'FFprobe', ok: info.ffprobe.ok, version: info.ffprobe.version || info.ffprobe.error || '', path: info.ffprobe.path },
      ];
      const allOk = rows.every((r) => r.ok);
      wrap.querySelector('#engineSummary').textContent = allOk
        ? 'FFmpeg and FFprobe are available — metadata, timecodes and thumbnails are fully enabled.'
        : 'Not found. Clips still import, rename, preview and export; durations and reference timecodes need FFprobe, thumbnails fall back to an in-app capture.';
      wrap.querySelector('#engineDetail').innerHTML =
        rows
          .map(
            (r) =>
              `<div class="engine-line"><span class="engine-dot ${r.ok ? 'ok' : 'bad'}"></span><b>${r.name}</b><span class="muted">${escapeHtml(
                String(r.version || 'not found').slice(0, 90)
              )}</span></div>` +
              (r.ok && r.path ? `<div class="engine-line"><span class="engine-dot"></span><span class="muted mono" style="font-size:10.5px">${escapeHtml(String(r.path).slice(0, 120))}</span></div>` : '')
          )
          .join('') +
        (allOk
          ? ''
          : '<div class="list-line info">Already have FFmpeg? Use <b>Locate FFmpeg…</b> / <b>Locate FFprobe…</b> and pick ffmpeg.exe and ffprobe.exe — or drop both files into the <b>ffmpeg</b> folder next to the application. No restart needed.</div>');
    }
    paintEngines(engines);

    wrap.querySelector('#setExportDir').addEventListener('click', async () => {
      const res = await FF.dialog.chooseDestination({ title: 'Default export location' });
      if (res && res.ok) {
        draft.defaultExportLocation = res.folderPath;
        refresh();
      }
    });
    wrap.querySelector('#setCacheDir').addEventListener('click', async () => {
      const res = await FF.settings.chooseCacheDir();
      if (res && res.ok) {
        draft.thumbnailCacheDir = res.cacheDir;
        state.info.cacheDir = res.cacheDir;
        refresh();
        UI.toast('Thumbnail cache moved. New thumbnails will be generated there.', { type: 'success' });
      }
    });
    wrap.querySelector('#setCacheClear').addEventListener('click', async () => {
      const ok = await UI.confirm({
        title: 'Clear the thumbnail cache?',
        message: 'Cached thumbnails will be regenerated the next time you browse clips. Your footage is not affected.',
        confirmLabel: 'CLEAR CACHE',
      });
      if (!ok) return;
      const res = await FF.settings.clearThumbs();
      if (res && res.ok) {
        App.state.thumbs = new Map();
        App.state.thumbRequested = new Set();
        App.renderBrowser(true);
        UI.toast('Thumbnail cache cleared.', { type: 'success' });
      }
    });
    wrap.querySelector('#setCheckEngines').addEventListener('click', async () => {
      if (App.invalidateEngine) App.invalidateEngine();
      const info = await FF.settings.checkEngines();
      paintEngines(info);
      if (info && info.ffmpeg && info.ffmpeg.ok && App.invalidateEngine) App.invalidateEngine();
    });

    /**
     * Downloads FFmpeg into the app's own ffmpeg folder — the same thing the
     * Windows installer offers ("download the media engine now?"). Progress is
     * real: bytes on the wire, then extraction, then installation.
     */
    // The flow itself lives at module scope (downloadEngine) so the welcome
    // panel card and the player notice can use the same one.
    wrap.querySelector('#setDownloadEngine').addEventListener('click', () => downloadEngine());

    const locate = async (which) => {
      const res = await FF.settings.locateEngine({ which });
      if (!res || res.ok === false) {
        if (res && !res.cancelled) UI.toast(res.error || 'That file could not be used.', { type: 'error', title: 'Locate failed' });
        return;
      }
      UI.toast(`${which === 'ffmpeg' ? 'FFmpeg' : 'FFprobe'} set successfully.`, { type: 'success', timeout: 2600 });
      if (App.invalidateEngine) App.invalidateEngine();
      // Re-check every clip that lacked metadata so the columns fill in.
      if (res.engines) paintEngines(res.engines);
      App.state.thumbs = new Map();
      App.state.thumbRequested = new Set();
      App.renderBrowser(true);
      App.checkMissingMedia(false);
      if (App.state.project.clips.length) {
        const clip = App.current();
        if (clip) App.loadClipIntoPreview(clip);
      }
    };
    wrap.querySelector('#setLocateFfmpeg').addEventListener('click', () => locate('ffmpeg'));
    wrap.querySelector('#setLocateFfprobe').addEventListener('click', () => locate('ffprobe'));
    /**
     * Copies every control in the panel into the draft.
     *
     * The selects used to be the only controls with a change-listener, so a
     * checkbox-only edit (or a starting-number edit) was silently dropped when
     * the panel was saved. saveSettings() now calls this first, and every
     * control re-reads the whole form, so nothing can fall through.
     */
    function readForm() {
      const val = (id) => wrap.querySelector(`#${id}`).value;
      const num = (id, fallback) => {
        const raw = val(id);
        const n = Number(raw);
        return raw === '' || !Number.isFinite(n) ? fallback : Math.max(0, Math.floor(n));
      };
      draft.defaultExportMode = 'folder';
      draft.previewQuality = val('setPreview');
      const auto = val('setAutosave');
      draft.autosaveEnabled = auto !== 'off';
      draft.autosaveSeconds = auto === 'on60' ? 60 : 30;
      draft.duplicateNaming = val('setDuplicates');
      draft.exportLayout = val('setExportLayout') === 'scenes' ? 'scenes' : 'flat';
      draft.timecodeFallback = val('setTimecode');
      draft.theme = val('setTheme');
      draft.defaultSceneOn = wrap.querySelector('#defSceneOn').checked;
      draft.defaultShotOn = wrap.querySelector('#defShotOn').checked;
      draft.defaultTakeOn = wrap.querySelector('#defTakeOn').checked;
      draft.defaultSceneValue = num('defSceneValue', draft.defaultSceneValue === undefined ? 1 : draft.defaultSceneValue);
      draft.defaultShotValue = num('defShotValue', draft.defaultShotValue === undefined ? 1 : draft.defaultShotValue);
      draft.defaultTakeValue = num('defTakeValue', draft.defaultTakeValue === undefined ? 1 : draft.defaultTakeValue);
      draft.hoverPreroll = wrap.querySelector('#setHoverPreroll').checked;
      draft.hoverShuttle = wrap.querySelector('#setHoverShuttle').checked;
      draft.autoFillFromPrevious = wrap.querySelector('#setAutoFill').checked;
      draft.customNameClearsTagging = wrap.querySelector('#setCustomClears').checked;
      draft.focusMode = wrap.querySelector('#setFocusMode').checked;
      draft.accentColor = accentValue;
      draft.shortcuts = Object.assign({}, shortcutDraft);
    }

    // Live preview of the look for every control that can change it.
    ['setPreview', 'setAutosave', 'setDuplicates', 'setTimecode', 'setTheme',
      'defSceneOn', 'defShotOn', 'defTakeOn', 'defSceneValue', 'defShotValue', 'defTakeValue',
      'setHoverPreroll', 'setFocusMode', 'setHoverShuttle', 'setAutoFill', 'setCustomClears'].forEach((id) => {
      const el = wrap.querySelector(`#${id}`);
      if (!el) return;
      el.addEventListener('change', () => {
        readForm();
        App.applyTheme(draft.theme, accentValue);
        App.setFocusMode(draft.focusMode, { persist: false });
        if (id === 'setTimecode') wrap.querySelector('#setExportDir').disabled = false;
      });
    });

    async function applyTimecodes() {
      const mode = wrap.querySelector('#setTimecode').value;
      const ok = await UI.confirm({
        title: 'Re-apply timecode fallback?',
        message: `Clips without embedded timecode will be re-stamped using: ${mode === 'zero' ? '00-00-00' : mode === 'index' ? 'project position' : 'file timestamp'}.`,
        detail: 'Clips that have real source timecode keep their embedded values. This only rewrites project metadata.',
        confirmLabel: 'RE-APPLY',
      });
      if (!ok) return;
      const clips = App.state.project.clips;
      clips.forEach((clip, index) => {
        clip.timeText = FFLib.computeTimeText(Object.assign({}, clip.meta || {}, { mtimeMs: clip.mtimeMs }), { index, timecodeFallback: mode });
      });
      App.markDirty();
      App.refreshAll();
      draft.timecodeFallback = mode;
      UI.toast(`Timecodes updated for ${clips.length} clips.`, { type: 'success' });
    }

    async function saveSettings() {
      readForm(); // pick up checkboxes / number inputs that never fired a change event
      const saved = await FF.settings.set(draft);
      state.settings = saved;
      App.applyTheme(saved.theme, saved.accentColor);
      App.reloadBindings(saved.shortcuts);
      App.setFocusMode(Boolean(saved.focusMode), { persist: false });
      App.paintShuttleHint();
      App.state.project.settings = Object.assign({}, App.state.project.settings, {
        timecodeFallback: saved.timecodeFallback,
        duplicateNaming: saved.duplicateNaming,
        exportLayout: saved.exportLayout,
      });
      const conflicts = FFKeys.findConflicts(FFKeys.mergeBindings(saved.shortcuts).bindings);
      const clashCount = Object.keys(conflicts).length;
      UI.toast(
        clashCount ? `Settings saved — ${clashCount} shortcut clash(es) remain.` : 'Settings saved.',
        { type: clashCount ? 'warning' : 'success', timeout: clashCount ? 4200 : 2000 }
      );
      App.setStatus('Settings updated.');
      FF.reloadMenu();
      return true;
    }

    refresh();
    return modal;
  }

  // =========================================================================
  // Help / About
  // =========================================================================
  function openHelp() {
    const merged = FFKeys.mergeBindings((App.state.settings && App.state.settings.shortcuts) || {});
    const conflicts = FFKeys.findConflicts(merged.bindings);

    const rows = [];
    FFKeys.grouped().forEach((group) => {
      rows.push(`<tr><td colspan="2" style="padding-top:12px"><span class="shortcut-group-title">${escapeHtml(group.name.toUpperCase())}</span></td></tr>`);
      group.items.forEach((def) => {
        const combo = merged.bindings[def.id];
        const keys = combo
          ? combo
              .split('+')
              .map((part) => `<kbd>${escapeHtml(FFKeys.formatCombo(part))}</kbd>`)
              .join('')
          : '<span class="muted">unbound</span>';
        const clash = combo && conflicts[combo] ? ' <span title="Also used by another action">⚠</span>' : '';
        const hint = def.hint ? `<div class="modal-note" style="font-size:10.5px">${escapeHtml(def.hint)}</div>` : '';
        rows.push(`<tr><td>${keys}${clash}</td><td>${escapeHtml(def.label)}${hint}</td></tr>`);
      });
    });

    UI.modal({
      title: 'Keyboard shortcuts',
      subtitle: 'Every action can be remapped in Settings → Keyboard. Escape always closes a dialog.',
      size: 'wide',
      window: true,
      winKey: 'help',
      defaultWidth: 700,
      body:
        '<table class="shortcut-table">' +
        rows.join('') +
        '</table>' +
        '<div class="modal-section" style="margin-top:12px">' +
        '<h4>MOUSE</h4>' +
        '<div class="modal-note">Hover a clip: it loads into the main player (Settings → Preview can turn that off — the old pop-up preview is gone). ' +
        'Double-click a clip to play it. ' +
        '<b>Hover-shuttle</b> (forward/backward by moving the pointer to the edges of the video) is <b>off by default</b> — switch it on in Settings → Preview ' +
        'or by clicking the “Hover-shuttle OFF” button in the transport bar. Pressing pause always stops everything, shuttle included.</div>' +
        '<h4 style="margin-top:10px">THE WINDOW</h4>' +
        '<div class="modal-note">The workspace is laid out like a compositing app: <b>player on the left</b>, ' +
        '<b>clip list on the right</b>, <b>renaming console along the bottom</b>. ' +
        'Drag the dividers between them to size the panes (double-click a divider to reset it) — the sizes are remembered. ' +
        'Settings, Export, Rename and the reports open as <b>floating pop-up windows</b> that you can drag by their title bar, ' +
        'collapse with –, and keep open while you work. <kbd>P</kbd> is still the distraction-free focus view.</div>' +
        '<h4 style="margin-top:10px">PLAYBACK (J / K / L)</h4>' +
        '<div class="modal-note"><kbd>L</kbd> plays forward, <kbd>J</kbd> plays backward, <kbd>K</kbd> stops — like DaVinci Resolve. ' +
        'Tap <kbd>L</kbd> or <kbd>J</kbd> again to shuttle 2× 4× 8×. <kbd>Ctrl+F</kbd> is full screen.</div>' +
        '<h4 style="margin-top:10px">RENAMING vs EXPORTING</h4>' +
        '<div class="modal-note"><b>Rename</b> (Ctrl+Shift+R) renames your files where they are — instant, no copying, and undoable with UNDO RENAME. ' +
        '<b>Export</b> (Ctrl+E) copies the renamed files into a folder you pick — straight into it, or into Scene_01, Scene_02 … if you prefer — and never touches the originals.</div>' +
        '<h4 style="margin-top:10px">THE FAST LOOP</h4>' +
        '<div class="modal-note">Press <kbd>F</kbd> to continue numbering from the previous clip (inside a Scene/Shot/Take box it affects only that field), ' +
        'or just tick a box with <kbd>Shift+A</kbd> / <kbd>Shift+S</kbd> / <kbd>Shift+D</kbd> — an empty box fills itself from the clip before. ' +
        'Then <kbd>Enter</kbd> to save and jump on.</div>' +
        '</div>',
      buttons: [{ label: 'CLOSE', className: 'primary' }, { label: 'EDIT SHORTCUTS', className: 'secondary', onClick: () => { openSettings(); } }],
    });
  }

  async function openAbout() {
    const info = await FF.appInfo();
    const wrap = document.createElement('div');
    wrap.className = 'about';
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    canvas.className = 'about-icon';
    UI.drawBrandIcon(canvas);
    wrap.appendChild(canvas);
    wrap.insertAdjacentHTML(
      'beforeend',
      `<h3>FUSION FLIX</h3>
       <p class="about-sub">Clip Renamer &amp; Sorter</p>
       <p class="about-footer">A free to use tool by Fusion Flix (Dhruv Sharma) 💓</p>
       <p class="about-line">Built for filmmakers, editors and creators.</p>
       <p class="about-version">Version ${escapeHtml(info.version)} · Electron ${escapeHtml(info.electron)} · offline, no account required</p>
       <button class="btn yt-btn large" id="aboutYouTube" type="button">
         <span class="yt-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M9 6.5v11l9-5.5-9-5.5z" fill="currentColor"/></svg></span>
         <span class="yt-text">Fusion On YouTube</span>
       </button>`
    );
    UI.modal({
      title: 'About',
      size: 'small',
      window: true,
      winKey: 'about',
      defaultWidth: 430,
      body: wrap,
      buttons: [{ label: 'CLOSE', className: 'primary' }],
    });
  }

  // =========================================================================
  // Media engine check
  // =========================================================================
  async function checkEngines() {
    const info = await FF.settings.checkEngines();
    const ok = info.ffmpeg.ok && info.ffprobe.ok;
    UI.modal({
      title: ok ? 'Media engine ready' : 'Media engine problem',
      size: 'wide',
      window: true,
      winKey: 'engines',
      defaultWidth: 640,
      body:
        '<div class="modal-section">' +
        `<div class="engine-line"><span class="engine-dot ${info.ffmpeg.ok ? 'ok' : 'bad'}"></span><b>FFmpeg</b><span class="muted">${escapeHtml(
          String(info.ffmpeg.version || info.ffmpeg.error || 'not found')
        )}</span></div>` +
        `<div class="engine-line"><span class="engine-dot ${info.ffprobe.ok ? 'ok' : 'bad'}"></span><b>FFprobe</b><span class="muted">${escapeHtml(
          String(info.ffprobe.version || info.ffprobe.error || 'not found')
        )}</span></div>` +
        (ok
          ? '<p class="modal-note">Durations, resolutions, frame rates, timecodes and thumbnails are all available.</p>'
          : '<p class="modal-note">Put ffmpeg.exe and ffprobe.exe in the “ffmpeg” folder next to the application, then restart Fusion Flix. Without them, clips can still be imported and renamed using the file timestamp fallback.</p>') +
        '</div>',
      buttons: [{ label: 'CLOSE', className: 'primary' }],
    });
  }

  // =========================================================================
  // Missing media / relink
  // =========================================================================
  async function relinkClip(clipId) {
    const clip = App.clipById(clipId);
    if (!clip) return;
    const picked = await FF.dialog.chooseVideo();
    if (!picked || !picked.ok) return;
    const res = await FF.project.relink({ clipId, newPath: picked.filePath });
    if (!res || res.ok === false) {
      UI.toast((res && res.error) || 'That file could not be used.', { type: 'error', title: 'Relink failed' });
      return;
    }
    clip.sourcePath = res.sourcePath;
    clip.fileName = res.fileName;
    clip.size = res.size;
    clip.mtimeMs = res.mtimeMs;
    clip.meta = res.meta;
    clip.timeText = FFLib.computeTimeText(Object.assign({}, clip.meta, { mtimeMs: res.mtimeMs }), {
      index: clip.order || 0,
      timecodeFallback: (App.state.settings && App.state.settings.timecodeFallback) || 'file-time',
    });
    if (clip.status === STATUS.MISSING) clip.status = STATUS.APPLIED;
    App.state.missing.delete(clip.id);
    App.state.thumbs.delete(clip.id);
    App.state.thumbRequested.delete(clip.id);
    App.markDirty();
    App.refreshAll();
    App.loadClipIntoPreview(clip);
    UI.toast(`Relinked "${clip.fileName}".`, { type: 'success' });
    App.setStatus(`Relinked ${clip.fileName}.`);
  }

  async function relinkFlow() {
    const missing = Array.from(App.state.missing);
    if (!missing.length) {
      await App.checkMissingMedia(false);
      if (!App.state.missing.size) {
        UI.toast('All clips are present on disk.', { type: 'success', timeout: 2500 });
        return;
      }
    }
    const ids = Array.from(App.state.missing);
    if (ids.length === 1) {
      relinkClip(ids[0]);
      return;
    }
    const body = document.createElement('div');
    body.className = 'modal-section';
    body.innerHTML = '<p class="modal-note">Select a clip to relink. Nothing is substituted automatically — you always choose the exact file.</p>';
    const list = document.createElement('div');
    list.className = 'list-scroll';
    ids.forEach((id) => {
      const clip = App.clipById(id);
      if (!clip) return;
      const row = document.createElement('button');
      row.className = 'list-line';
      row.style.cursor = 'pointer';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.innerHTML = `<span class="name">${escapeHtml(clip.fileName)}</span><span class="muted">${escapeHtml(clip.sourcePath || '')}</span>`;
      row.addEventListener('click', () => {
        App.selectClip(clip.id);
        relinkClip(clip.id);
      });
      list.appendChild(row);
    });
    body.appendChild(list);
    UI.modal({
      title: 'Missing media',
      subtitle: `${ids.length} clips could not be found`,
      size: 'wide',
      window: true,
      winKey: 'missing',
      defaultWidth: 720,
      body,
      buttons: [{ label: 'CLOSE', className: 'secondary' }],
    });
  }

  // =========================================================================
  // Crash recovery + close handling
  // =========================================================================
  async function checkRecovery() {
    try {
      const res = await FF.autosave.list();
      const entries = (res && res.entries) || [];
      if (!entries.length) return;
      const entry = entries[0];
      UI.modal({
        title: 'Recover unsaved changes?',
        subtitle: `Autosaved ${new Date(entry.autosavedAt).toLocaleString()}`,
        size: 'small',
        body: `<div class="modal-section"><p style="margin:0;font-size:13.5px">Fusion Flix found project metadata that was not saved normally — usually because the app was closed unexpectedly.</p>
               <div class="list-line">${escapeHtml(entry.name)} · ${entry.clipCount} clips${entry.path ? ` · ${escapeHtml(entry.path)}` : ' (never saved)'}</div>
               <p class="modal-note">Only metadata is recovered. Your original footage is never modified.</p></div>`,
        buttons: [
          {
            label: 'DISCARD',
            className: 'secondary',
            value: 'discard',
            onClick: async () => {
              await FF.autosave.discard({ key: entry.key });
            },
          },
          { label: 'RESTORE PROJECT', className: 'primary', value: 'restore', autofocus: true },
        ],
        onClose: async (value) => {
          if (value !== 'restore') return;
          const read = await FF.autosave.read({ key: entry.key });
          if (!read || read.ok === false) {
            UI.toast('That autosave could not be read.', { type: 'error' });
            return;
          }
          App.setProject(read.project, read.savedPath || '', { markClean: false });
          UI.toast(`${read.project.clips.length} clips recovered from autosave.`, { type: 'success', title: 'Project recovered' });
        },
      });
    } catch (_) {
      /* recovery is best-effort only */
    }
  }

  async function handleBeforeClose() {
    const state = App.state;
    if (!state.dirty) {
      FF.confirmClose();
      return;
    }
    App.autosaveNow();
    const res = await FF.quitConfirm({ message: 'You have unsaved metadata changes in this project.' });
    const response = res && typeof res.response === 'number' ? res.response : 2;
    if (response === 0) {
      const saved = await saveProject(false);
      if (saved) FF.confirmClose();
    } else if (response === 1) {
      FF.confirmClose();
    }
    // response === 2 → cancel: stay open
  }

  // =========================================================================
  // Issues report
  // =========================================================================
  function showIssues() {
    const validation = App.state.validation;
    if (!validation) return;
    const rows = [];
    for (const clip of App.state.project.clips) {
      const list = validation.byClip[clip.id] || [];
      for (const issue of list) {
        rows.push({ clip, issue });
      }
    }
    if (!rows.length) {
      UI.toast('No validation issues — the project is export-ready.', { type: 'success' });
      return;
    }
    const body = document.createElement('div');
    body.className = 'list-scroll';
    rows.slice(0, 250).forEach(({ clip, issue }) => {
      const row = document.createElement('button');
      row.className = `list-line ${issue.level}`;
      row.style.cursor = 'pointer';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.innerHTML = `<span class="name">${escapeHtml(clip.fileName)}</span><span>${escapeHtml(issue.message)}</span>`;
      row.addEventListener('click', () => App.selectClip(clip.id));
      body.appendChild(row);
    });
    UI.modal({
      title: 'Project report',
      subtitle: `${validation.errorCount} error(s) · ${validation.warningCount} warning(s)`,
      size: 'wide',
      window: true,
      winKey: 'report',
      defaultWidth: 740,
      body,
      buttons: [{ label: 'CLOSE', className: 'secondary' }],
    });
  }

  /** Vector icons inside panels/modals that are built at runtime. */
  function paintModalIcons(root) {
    UI.applyIcons(root);
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // =========================================================================
  // Wiring
  // =========================================================================
  function initEvents() {
    FF.on(FF.channels.IMPORT_PROGRESS, (progress) => {
      // Import progress is shown inside the import busy dialog via polling of
      // the latest message; we store it and let the dialog read it.
      if (PANELS.onImportProgress) PANELS.onImportProgress(progress);
      if (progress && progress.message && App.state.importBusy) App.setStatus(progress.message);
    });
    FF.on(FF.channels.EXPORT_PROGRESS, (progress) => {
      if (progress && exportState.running) consoleProgress(progress.percent, progress.currentName || 'exporting');
      else if (progress && progress.stage === 'sample') consoleProgress(progress.percent, 'building sample');
      if (progress && !exportState.running && progress.stage === 'done') consoleProgress(null);
      if (exportState.running) paintProgress(progress);
      else if (progress && progress.stage === 'sample') App.setStatus(progress.message);
    });
    FF.on(FF.channels.EXPORT_DONE, (result) => {
      if (exportState.running) finishExport(result);
    });

    // Rename: real percentages, live.
    // A preview proxy is being built for an unplayable clip: real percentage.
    FF.on(FF.channels.MEDIA_PROXY_PROGRESS, (progress) => {
      if (progress && App.onProxyProgress) App.onProxyProgress(progress);
    });

    FF.on(FF.channels.RENAME_PROGRESS, (progress) => paintRenameProgress(progress));
    FF.on(FF.channels.RENAME_DONE, (result) => {
      renameState.running = false;
      consoleProgress(null);
      if (renameState.busy) {
        renameState.busy.close();
        renameState.busy = null;
      }
      if (renameState.handled) {
        // startRenameFromPanel() already reported this run (it gets the result
        // back from the same call). Doing it twice would stack two reports.
        renameState.handled = false;
        return;
      }
      if (!result) return;
      if (result.ok === false && !result.renamed) {
        UI.toast(result.error || 'The files could not be renamed.', { type: 'error', title: 'Rename failed' });
        return;
      }
      if (result.changes && result.changes.length) {
        App.applyRenameChanges(result.changes);
      }
      renameState.result = result;
      paintRenameResult(result);
      App.setStatus(`${result.renamed} file${result.renamed === 1 ? '' : 's'} renamed.`);
    });

    // Optional FFmpeg download (Settings → Media engine).
    FF.on(FF.channels.ENGINE_DOWNLOAD_PROGRESS, (progress) => {
      if (engineState.busy && progress) engineState.busy(progress);
    });
    FF.on(FF.channels.ENGINE_DOWNLOAD_DONE, async (result) => {
      const busy = engineState.busy;
      engineState.busy = null;
      if (busy) busy.done(result);
      if (result && result.ok) {
        if (App.invalidateEngine) App.invalidateEngine();
        UI.toast('FFmpeg installed — previews, thumbnails, durations and timecodes are now fully enabled.', { type: 'success', timeout: 4000 });
      } else if (result && !result.cancelled) {
        UI.toast(result.error || 'The engine could not be downloaded.', { type: 'error', title: 'Download failed' });
      }
    });

    // The renaming console has its own RENAME FILES button (the toolbar keeps
    // one as well) — both open the same panel.
    const consoleRename = document.getElementById('btnConsoleRename');
    if (consoleRename) consoleRename.addEventListener('click', () => openRename());

    // Every YouTube button (status bar, welcome panel, About) opens the channel
    // in the user's own browser — the app itself never needs the network.
    document.addEventListener('click', async (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('.yt-btn') : null;
      if (!btn) return;
      event.preventDefault();
      const res = await FF.shell.openUrl({ url: YOUTUBE_URL });
      if (!res || !res.ok) UI.toast((res && res.error) || 'That link could not be opened.', { type: 'warning' });
    });
  }

  window.FFPanels = Object.assign(PANELS, {
    ACCENT_PRESETS,
    openRename,
    renameState,
    importClips,
    importFolder,
    importPaths,
    openExport,
    saveProject,
    openProject,
    newProject,
    openSettings,
    openEngineSetup,
    installEngine: () => {
      if (App.hideEngineCard) App.hideEngineCard();
      return downloadEngine();
    },
    openHelp,
    openAbout,
    loadSample,
    checkEngines,
    relinkClip,
    relinkFlow,
    checkRecovery,
    handleBeforeClose,
    showIssues,
    showList,
    exportState,
  });

  // The import progress events need to reach the busy dialog created in
  // importPaths(); that dialog reads through this hook.
  //
  // app.js and this file are two scripts racing each other: app.js announces
  // itself with 'ff-ready' when it has finished starting, and if that event
  // lands before this listener is attached then NONE of the wiring below ever
  // happens — the app still runs, it just never reacts (a rename would finish
  // and report nothing). So the hook also runs on load when the app is already
  // ready, and it can only ever run once.
  let eventsWired = false;
  function wireEvents() {
    if (eventsWired) return;
    eventsWired = true;
    initEvents();
    const statusBrand = document.querySelector('.status-brand');
    if (statusBrand) {
      statusBrand.style.cursor = 'pointer';
      statusBrand.title = 'A free to use tool by Fusion Flix (Dhruv Sharma) 💓';
    }
  }
  document.addEventListener('ff-ready', wireEvents);
  if (window.FFApp && window.FFApp.ready) wireEvents();
})();
