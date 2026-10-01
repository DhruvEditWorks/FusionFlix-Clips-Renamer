'use strict';
/**
 * FUSION FLIX — CLIP RENAMER & SORTER
 * Renderer application logic: project state, virtualised clip browser, preview
 * transport with hover-scrubbing, Clip Information panel, undo/redo, autosave.
 *
 * Runs sandboxed: the only outside access is window.FF (preload) and the pure
 * libraries in renderer/lib/*.
 */
(function () {
  const FFKeys = window.FFKeys;
  const FFLib = window.FFLib;
  const FFValidate = window.FFValidate;
  const FFSanitize = window.FFSanitize;
  const UI = window.FFUI;
  const FF = window.FF;

  const $ = (id) => document.getElementById(id);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const STATUS = FFLib.STATUS;
  const SCRUB_STEPS = [0.25, 0.5, 1, 2, 4, 8];

  // ---------------------------------------------------------------- state --
  const state = {
    info: null,
    settings: null,
    project: FFLib.DEFAULT_PROJECT_SETTINGS
      ? { name: 'Untitled Project', clips: [], settings: Object.assign({}, FFLib.DEFAULT_PROJECT_SETTINGS), exportSettings: {} }
      : { name: 'Untitled Project', clips: [], settings: {}, exportSettings: {} },
    projectPath: '',
    dirty: false,
    order: 'import',
    orderDir: 1,
    search: '',
    filters: { unnamed: false, missing: false, extra: false, applied: false },
    viewIds: [],
    currentClipId: null,
    undo: [],
    redo: [],
    thumbs: new Map(), // clipId -> thumbnail file path
    thumbRequested: new Set(),
    thumbFallback: false,
    missing: new Set(),
    validation: null,
    validationTimer: null,
    importBusy: false,
    pendingEdits: { scene: false, shot: false, take: false, custom: false },
    hoverPreviewTimer: null,
    hoverClipId: null,
    hoverTimerRow: null,
    lastAppliedAt: 0,
    bindings: {},
    focusMode: false,
    capturingKey: false,
    // The player could not decode this clip (HEVC & friends) and is showing a
    // still frame instead — set per clip id.
    previewStillBy: null,
    // clipId -> proxy file path (built once, then reused for instant playback)
    proxies: new Map(),
    // clipId -> { percent } while a proxy is being built
    proxyBusy: new Map(),
    // null = unknown, true/false = "the media engine is installed"
    engineReady: null,
  };

  const clipById = (id) => state.project.clips.find((c) => c.id === id) || null;

  /** Thumbnails are either a cached file path or an inline data URL. */
  function thumbSrcFor(value) {
    if (!value) return '';
    return value.startsWith('data:') ? value : FF.thumbUrl(value);
  }
  const clipIndex = (id) => state.project.clips.findIndex((c) => c.id === id);
  const current = () => clipById(state.currentClipId);
  const isDirtyable = () => true;

  // ------------------------------------------------------------------ DOM --
  const dom = {
    list: $('clipList'),
    listInner: $('clipListInner'),
    listEmpty: $('listEmpty'),
    search: $('searchInput'),
    searchClear: $('searchClear'),
    sortKey: $('sortKey'),
    sortDir: $('sortDir'),
    browserCount: $('browserCount'),
    browserFoot: $('browserFoot'),
    previewVideo: $('previewVideo'),
    previewStill: $('previewStill'),
    previewNotice: $('previewNotice'),
    previewCount: $('previewCount'),
    previewPlaceholder: $('previewPlaceholder'),
    welcome: $('welcomePanel'),
    workspace: $('workspace'),
    consoleProgress: $('consoleProgress'),
    consoleProgressFill: $('consoleProgressFill'),
    consoleProgressLabel: $('consoleProgressLabel'),
    zoneBack: $('zoneBack'),
    zoneFwd: $('zoneFwd'),
    speedBack: $('speedBack'),
    speedFwd: $('speedFwd'),
    osd: $('previewOsd'),
    previewBadges: $('previewBadges'),
    previewMissing: $('previewMissing'),
    previewInfo: $('previewInfo'),
    stage: $('previewStage'),
    btnPlay: $('btnPlay'),
    timeline: $('timeline'),
    curTime: $('curTime'),
    totalTime: $('totalTime'),
    btnMute: $('btnMute'),
    volume: $('volume'),
    infoPosition: $('infoPosition'),
    infoFileName: $('infoFileName'),
    infoFileMeta: $('infoFileMeta'),
    sceneOn: $('sceneOn'),
    sceneInput: $('sceneInput'),
    sceneNext: $('sceneNext'),
    sceneHint: $('sceneHint'),
    sceneBadge: $('sceneBadge'),
    shotOn: $('shotOn'),
    shotInput: $('shotInput'),
    shotNext: $('shotNext'),
    shotHint: $('shotHint'),
    shotBadge: $('shotBadge'),
    takeOn: $('takeOn'),
    takeInput: $('takeInput'),
    takeNext: $('takeNext'),
    takeHint: $('takeHint'),
    takeBadge: $('takeBadge'),
    extraOn: $('extraOn'),
    customOn: $('customOn'),
    customInput: $('customInput'),
    customHint: $('customHint'),
    finalName: $('finalName'),
    finalPath: $('finalPath'),
    finalTimeSource: $('finalTimeSource'),
    clipIssues: $('clipIssues'),
    mediaStatus: $('mediaStatus'),
    projectName: $('projectName'),
    projectMeta: $('projectMeta'),
    dirtyDot: $('dirtyDot'),
    statusClip: $('statusClip'),
    statusCounts: $('statusCounts'),
    statusMessage: $('statusMessage'),
    dragOverlay: $('dragOverlay'),
    brandCanvas: $('brandIcon'),
    welcomeIcon: $('welcomeIcon'),
  };

  // --------------------------------------------------------------- helpers --
  function setStatus(message, kind) {
    dom.statusMessage.textContent = message || '';
    dom.statusMessage.style.color = kind === 'error' ? '#ffb0b0' : kind === 'warn' ? '#ffe0a3' : '';
  }

  function flashFooter() {
    const el = document.querySelector('.status-brand');
    if (!el) return;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 700);
  }

  function markDirty() {
    state.dirty = true;
    dom.dirtyDot.hidden = false;
    FF.setTitle({ name: state.project.name, dirty: true });
  }

  function markClean() {
    state.dirty = false;
    dom.dirtyDot.hidden = true;
    FF.setTitle({ name: state.project.name, dirty: false });
  }

  // ------------------------------------------------------- project handling --
  function emptyProject(name) {
    return {
      name: name || 'Untitled Project',
      settings: Object.assign({}, FFLib.DEFAULT_PROJECT_SETTINGS),
      exportSettings: { mode: (state.settings && state.settings.defaultExportMode) || 'folder', destination: state.settings ? state.settings.defaultExportLocation || '' : '', includeUnassigned: true },
      clips: [],
    };
  }

  function setProject(project, filePath, options) {
    const opts = options || {};
    state.project = project;
    state.projectPath = filePath || '';
    state.undo = [];
    state.redo = [];
    state.thumbs = new Map();
    state.thumbRequested = new Set();
    state.missing = new Set();
    state.currentClipId = project.clips.length ? project.clips[0].id : null;

    // keep settings in sync with the project-level preferences
    if (project.settings) {
      state.order = state.order || 'import';
    }
    dom.projectName.value = project.name || 'Untitled Project';
    if (opts.markClean === false) markDirty();
    else markClean();

    state.viewIds = [];
    refreshAll({ keepScroll: false });
    updateWelcome();
    FF.project.setPath({ filePath: state.projectPath });
    FF.project.registerMedia({ clips: project.clips });
    checkMissingMedia();
    updateTitleOnly();
  }

  function updateTitleOnly() {
    FF.setTitle({ name: state.project.name, dirty: state.dirty });
  }

  function checkMissingMedia(showToast) {
    const clips = state.project.clips.map((c) => ({ id: c.id, sourcePath: c.sourcePath }));
    if (!clips.length) {
      state.missing = new Set();
      return Promise.resolve([]);
    }
    return FF.project.checkMedia({ clips }).then((res) => {
      if (!res || res.ok === false) return [];
      state.missing = new Set(res.missing || []);
      for (const clip of state.project.clips) {
        if (state.missing.has(clip.id)) {
          clip.status = STATUS.MISSING;
        } else if (clip.status === STATUS.MISSING) {
          // The file is back (or was relinked) — stop flagging it.
          clip.status = STATUS.APPLIED;
        }
      }
      if (state.missing.size) {
        setStatus(`${state.missing.size} clip${state.missing.size === 1 ? '' : 's'} missing from disk — use Relink Clip.`, 'warn');
        if (showToast !== false) {
          UI.toast(`${state.missing.size} clip${state.missing.size === 1 ? '' : 's'} could not be found. Relink them from the Clip Information panel.`, {
            type: 'warning',
            title: 'Media Missing',
            timeout: 7000,
          });
        }
      }
      renderBrowser();
      renderFooter();
      renderInfo();
      return res.missing || [];
    });
  }

  // ------------------------------------------------------------ view / list --
  function passesFilters(clip) {
    const f = state.filters;
    if (f.unnamed && !FFLib.needsNaming(clip)) return false;
    if (f.missing && !state.missing.has(clip.id)) return false;
    if (f.extra && !clip.extra) return false;
    if (f.applied && clip.status !== STATUS.APPLIED && clip.status !== STATUS.EXPORTED) return false;

    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      clip.fileName,
      clip.custom,
      clip.sceneOn ? `s-${clip.scene} s${clip.scene} scene ${clip.scene}` : '',
      clip.shotOn ? `sh-${clip.shot} shot ${clip.shot}` : '',
      clip.takeOn ? `t-${clip.take} take ${clip.take}` : '',
      clip.extra ? 'extra' : '',
      FFLib.finalFileName(clip),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  }

  function computeView() {
    const filtered = state.project.clips.filter(passesFilters);
    const sorted = FFLib.sortClips(filtered, state.order, state.orderDir);
    state.viewIds = sorted.map((c) => c.id);
  }

  function scheduleValidation() {
    if (state.validationTimer) clearTimeout(state.validationTimer);
    state.validationTimer = setTimeout(() => {
      state.validationTimer = null;
      state.validation = FFValidate.validateProject(state.project.clips);
      renderBrowser();
      renderInfo();
      renderFooter();
    }, 60);
  }

  function refreshAll(options) {
    const opts = options || {};
    updateWelcome();
    computeView();
    // Never sit in front of an empty player while clips exist: the first clip
    // is loaded automatically (this is what made imported footage look like it
    // "did not preview" — nothing had been clicked yet).
    if (!state.currentClipId && state.viewIds.length) {
      const first = clipById(state.viewIds[0]);
      if (first) {
        state.currentClipId = first.id;
        loadClipIntoPreview(first);
      }
    }
    renderBrowser(opts.keepScroll);
    renderInfo();
    renderFooter();
    renderTransport();
    updateProjectMeta();
    scheduleValidation();
  }

  function updateProjectMeta() {
    const clips = state.project.clips;
    const duration = clips.reduce((a, c) => a + (Number(c.meta && c.meta.duration) || 0), 0);
    dom.projectMeta.textContent = clips.length
      ? `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${FFLib.formatDuration(duration)} total${state.projectPath ? ` · ${state.projectPath}` : ''}`
      : 'No clips loaded';
  }

  // ------------------------------------------------- clip browser rendering --
  const rowPool = [];

  function createRow() {
    const row = document.createElement('div');
    row.className = 'clip-row';
    row.setAttribute('role', 'option');

    const thumb = document.createElement('div');
    thumb.className = 'clip-thumb';
    const idx = document.createElement('span');
    idx.className = 'thumb-index';
    const badges = document.createElement('div');
    badges.className = 'clip-badges';
    const dur = document.createElement('span');
    dur.className = 'thumb-duration';
    thumb.append(idx, badges, dur);

    const main = document.createElement('div');
    main.className = 'clip-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'clip-name-row';
    const name = document.createElement('span');
    name.className = 'clip-name';
    nameRow.appendChild(name);
    const sub = document.createElement('div');
    sub.className = 'clip-sub';
    const out = document.createElement('div');
    out.className = 'clip-out';
    main.append(nameRow, sub, out);

    const side = document.createElement('div');
    side.className = 'clip-side';
    const chip = document.createElement('span');
    chip.className = 'status-chip';
    const del = document.createElement('button');
    del.className = 'row-delete';
    del.type = 'button';
    del.textContent = 'DELETE';
    del.title = 'Remove this clip from the project (the source file is not deleted)';
    side.append(chip, del);

    row.append(thumb, main, side);
    row._parts = { thumb, idx, badges, dur, name, sub, out, chip, del };
    return row;
  }

  function rowHeight() {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
    return Number.isFinite(value) ? value : 84;
  }

  function renderBrowser(keepScroll) {
    deferWelcome();
    const ids = state.viewIds;
    const rowH = rowHeight();
    const scrollTop = dom.list.scrollTop;

    dom.listInner.style.height = `${ids.length * rowH}px`;
    dom.listEmpty.hidden = ids.length !== 0;
    dom.listEmpty.style.display = ids.length === 0 && state.project.clips.length ? 'flex' : 'none';

    const viewport = dom.list.clientHeight || 600;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - 3);
    const end = Math.min(ids.length, Math.ceil((scrollTop + viewport) / rowH) + 3);
    const needed = Math.max(0, end - start);

    while (rowPool.length < needed) {
      const el = createRow();
      dom.listInner.appendChild(el);
      rowPool.push(el);
    }

    for (let i = 0; i < rowPool.length; i++) {
      const el = rowPool[i];
      const viewIndex = start + i;
      if (viewIndex >= end || viewIndex >= ids.length) {
        el.style.display = 'none';
        el._clipId = null;
        continue;
      }
      const clip = clipById(ids[viewIndex]);
      if (!clip) {
        el.style.display = 'none';
        el._clipId = null;
        continue;
      }
      el.style.display = '';
      el.style.transform = `translateY(${viewIndex * rowH}px)`;
      updateRow(el, clip, viewIndex);
    }

    requestThumbsForRange(start, end);
    if (!keepScroll) {
      // keep the current clip visible when the view changes
      const vIndex = state.viewIds.indexOf(state.currentClipId);
      if (vIndex >= 0) {
        const top = vIndex * rowH;
        const bottom = top + rowH;
        if (top < dom.list.scrollTop || bottom > dom.list.scrollTop + viewport) {
          dom.list.scrollTop = Math.max(0, top - viewport / 2 + rowH / 2);
        }
      }
    }
  }

  function updateRow(el, clip, viewIndex) {
    const p = el._parts;
    const isCurrent = clip.id === state.currentClipId;
    const issues = state.validation && state.validation.byClip[clip.id] ? state.validation.byClip[clip.id] : [];
    const hasError = issues.some((i) => i.level === 'error');
    const hasWarning = issues.some((i) => i.level === 'warning');

    if (el._clipId !== clip.id) el._hoverActive = false; // recycled row, fresh hover state
    el._clipId = clip.id;
    el.classList.toggle('is-current', isCurrent);
    el.dataset.clipId = clip.id;
    el.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
    el.setAttribute('aria-label', `${viewIndex + 1} of ${state.viewIds.length}. ${clip.fileName}`);

    p.idx.textContent = String(viewIndex + 1);
    p.idx.hidden = Boolean(state.thumbs.get(clip.id));

    // thumbnail
    const thumbPath = state.thumbs.get(clip.id);
    const existingImg = p.thumb.querySelector('img');
    if (thumbPath) {
      const url = thumbSrcFor(thumbPath);
      if (!existingImg) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.src = url;
        p.thumb.appendChild(img);
      } else if (existingImg.getAttribute('src') !== url) {
        existingImg.src = url;
      }
      p.idx.hidden = true;
    } else if (existingImg) {
      existingImg.remove();
    }

    // badges
    const badges = [];
    if (clip.sceneOn && clip.scene !== null && clip.scene !== undefined) badges.push(`S${clip.scene}`);
    if (clip.shotOn && clip.shot !== null && clip.shot !== undefined) badges.push(`SH${clip.shot}`);
    if (clip.takeOn && clip.take !== null && clip.take !== undefined) badges.push(`T${clip.take}`);
    const badgeHtml = badges.map((b) => `<span class="mini-badge">${b}</span>`).join('');
    const extraHtml = clip.extra ? '<span class="mini-badge extra">EXTRA</span>' : '';
    const customHtml = FFLib.hasCustomName(clip) ? '<span class="mini-badge custom">NAME</span>' : '';
    const html = badgeHtml + extraHtml + customHtml;
    if (p.badges.dataset.html !== html) {
      p.badges.innerHTML = html;
      p.badges.dataset.html = html;
    }

    p.dur.textContent = clip.meta && clip.meta.duration ? FFLib.formatDuration(clip.meta.duration) : '';

    // text
    p.name.textContent = clip.fileName;
    p.name.title = clip.sourcePath;

    const metaBits = [];
    if (clip.meta && clip.meta.resolutionText) metaBits.push(clip.meta.resolutionText);
    if (clip.meta && clip.meta.fpsText) metaBits.push(`${clip.meta.fpsText} fps`);
    if (clip.meta && clip.meta.durationText) metaBits.push(clip.meta.durationText);
    if (clip.meta && clip.meta.timecode) metaBits.push(`TC ${clip.meta.timecode}`);
    p.sub.textContent = metaBits.join(' · ') || 'No metadata yet';

    const unnamed = FFLib.needsNaming(clip);
    p.out.textContent = unnamed ? 'Not named yet — set Scene / Shot / Take' : FFLib.finalFileName(clip);
    p.out.classList.toggle('plain', unnamed);
    p.out.title = unnamed ? 'Enable Scene, Shot, Take or Custom Name' : `Export name: ${FFLib.finalFileName(clip)}`;

    // status chip
    let chipText = 'NEW';
    let chipClass = '';
    if (state.missing.has(clip.id)) {
      chipText = 'MISSING';
      chipClass = 'missing';
    } else if (hasError) {
      chipText = 'CHECK';
      chipClass = 'issue';
    } else if (hasWarning) {
      chipText = 'DUP?';
      chipClass = 'issue';
    } else if (clip.status === STATUS.EXPORTED) {
      chipText = 'EXPORTED';
      chipClass = 'exported';
    } else if (clip.status === STATUS.APPLIED) {
      chipText = 'APPLIED';
      chipClass = 'applied';
    }
    chipText = clip.extra && chipClass === '' ? 'EXTRA' : chipText;
    if (p.chip.textContent !== chipText) p.chip.textContent = chipText;
    p.chip.className = `status-chip ${chipClass}`;
  }

  function requestThumbsForRange(start, end) {
    if (!FF || !FF.media) return;
    for (let i = start; i < end && i < state.viewIds.length; i++) {
      const clip = clipById(state.viewIds[i]);
      if (!clip || state.thumbs.has(clip.id) || state.thumbRequested.has(clip.id)) continue;
      state.thumbRequested.add(clip.id);
      FF.media
        .thumbnail({ id: clip.id, sourcePath: clip.sourcePath, duration: clip.meta ? clip.meta.duration : 0 })
        .then((res) => {
          if (res && res.ok && res.path) {
            state.thumbs.set(clip.id, res.path);
            updateVisibleRow(clip.id);
            return;
          }
          if (res && res.fallback === 'renderer') {
            // FFmpeg is unavailable on this machine — build the thumbnail here
            // instead so the browser never shows an empty tile.
            state.thumbFallback = true;
            captureThumbnail(clip).then((dataUrl) => {
              if (dataUrl) {
                state.thumbs.set(clip.id, dataUrl);
                updateVisibleRow(clip.id);
              } else {
                state.thumbRequested.delete(clip.id);
              }
            });
            return;
          }
          state.thumbRequested.delete(clip.id);
        })
        .catch(() => state.thumbRequested.delete(clip.id));
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in thumbnail fallback (no FFmpeg required).
  // Grabs a frame from the clip with a hidden <video> and paints it to a canvas.
  // Only ever decodes two clips at a time.
  // ---------------------------------------------------------------------------
  const captureQueue = [];
  let captureActive = 0;

  function captureThumbnail(clip) {
    if (!clip || !clip.sourcePath) return Promise.resolve(null);
    const existing = captureQueue.find((job) => job.clipId === clip.id);
    if (existing) return existing.promise;

    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const job = { clipId: clip.id, clip, promise, resolve: resolveFn };
    captureQueue.push(job);
    pumpCaptures();
    return promise;
  }

  function pumpCaptures() {
    while (captureActive < 2 && captureQueue.length) {
      const job = captureQueue.shift();
      captureActive += 1;
      grabFrame(job.clip)
        .then((dataUrl) => job.resolve(dataUrl))
        .catch(() => job.resolve(null))
        .finally(() => {
          captureActive -= 1;
          pumpCaptures();
        });
    }
  }

  function grabFrame(clip) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(video);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          video.removeAttribute('src');
          video.load();
        } catch (_) {}
        video.remove();
        resolve(value);
      };

      const timer = setTimeout(() => finish(null), 12000);

      video.addEventListener('loadeddata', () => {
        const target = Math.min(0.7, Math.max(0.05, (video.duration || 2) * 0.15));
        try {
          video.currentTime = Number.isFinite(target) ? target : 0;
        } catch (_) {
          finish(null);
        }
      });

      video.addEventListener('seeked', () => {
        try {
          const width = 176;
          const ratio = (video.videoHeight || 9) / (video.videoWidth || 16);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = Math.max(2, Math.round(width * ratio));
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.72));
        } catch (_) {
          finish(null);
        }
      });

      video.addEventListener('error', () => finish(null));
      video.src = FF.mediaUrl(clip.sourcePath);
      try {
        video.load();
      } catch (_) {
        finish(null);
      }
    });
  }

  function updateVisibleRow(clipId) {
    for (const el of rowPool) {
      if (el._clipId === clipId && el.style.display !== 'none') {
        const clip = clipById(clipId);
        if (clip) updateRow(el, clip, state.viewIds.indexOf(clipId));
      }
    }
  }

  // ------------------------------------------------------------- selection --
  function clearPendingEdits() {
    state.pendingEdits.scene = false;
    state.pendingEdits.shot = false;
    state.pendingEdits.take = false;
    state.pendingEdits.custom = false;
  }

  function selectClip(id, options) {
    const opts = options || {};
    if (!id || !clipById(id)) return;
    // A new clip always repaints the panel from its own metadata.
    clearPendingEdits();
    state.currentClipId = id;
    // Hover pre-rolls the hovered clip into the main preview *and* keeps the
    // floating preview up, so the two never cancel each other out.
    if (opts.keepHover !== true) stopHoverPreview();
    if (opts.scroll !== false) scrollClipIntoView(id);
    loadClipIntoPreview(clipById(id));
    renderInfo();
    renderBrowser(true);
    renderFooter();
    // A selected clip must always be visible: whatever path got here (import,
    // restore, shortcut, click), the first-run overlay has to be out of the way.
    deferWelcome();
  }

  /**
   * Hides the welcome panel whenever there is anything to show and brings it
   * back only for a truly empty workspace. It runs from every selection/import
   * path *and* from the list renderer, so one missed call can never leave the
   * player covered by the first-run screen again.
   */
  function deferWelcome() {
    const run = () => updateWelcome();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  function scrollClipIntoView(id) {
    const index = state.viewIds.indexOf(id);
    if (index < 0) return;
    const rowH = rowHeight();
    const top = index * rowH;
    const bottom = top + rowH;
    const viewport = dom.list.clientHeight;
    if (top < dom.list.scrollTop + 4 || bottom > dom.list.scrollTop + viewport - 4) {
      dom.list.scrollTop = Math.max(0, top - viewport / 2 + rowH / 2);
      renderBrowser(true);
    }
  }

  function stepClip(delta) {
    if (!state.viewIds.length) return;
    let index = state.viewIds.indexOf(state.currentClipId);
    if (index < 0) index = 0;
    const next = clamp(index + delta, 0, state.viewIds.length - 1);
    selectClip(state.viewIds[next], { scroll: true });
    flashFooter();
  }

  // -------------------------------------------------------- preview / video --
  const video = dom.previewVideo;
  let previewLoadToken = 0;

  function loadClipIntoPreview(clip) {
    stopAllMotion();
    hidePreviewNotice();
    if (!clip) {
      video.dataset.empty = '1';
      video.removeAttribute('src');
      video.load();
      clearStill();
      dom.previewPlaceholder.hidden = false;
      dom.previewMissing.hidden = true;
      dom.previewBadges.innerHTML = '';
      setPreviewInfo(null);
      playPauseUI(false);
      renderTransport();
      return;
    }
    const token = ++previewLoadToken;
    const missing = state.missing.has(clip.id);
    dom.previewPlaceholder.hidden = true;
    dom.previewMissing.hidden = !missing;
    if (dom.previewCount) {
      const index = state.viewIds.indexOf(clip.id);
      dom.previewCount.textContent = `${index >= 0 ? index + 1 : '?'} of ${state.viewIds.length} · ${clip.fileName}`;
    }

    if (missing) {
      video.dataset.empty = '1';
      video.removeAttribute('src');
      video.load();
      clearStill();
      dom.previewVideo.setAttribute('aria-label', 'Media missing');
      setPreviewInfo(clip);
      renderPreviewBadges(clip);
      return;
    }

    // A clip we already know the player cannot decode: show its still frame
    // straight away instead of flashing a black rectangle first.
    if (state.previewStillBy && state.previewStillBy.id === clip.id) {
      showStillFor(clip, state.previewStillBy.reason);
    } else {
      clearStill();
    }

    const proxyPath = state.proxies.get(clip.id);
    const url = proxyPath ? FF.mediaUrl(proxyPath) : FF.mediaUrl(clip.sourcePath);
    if (video.getAttribute('src') !== url) {
      video.dataset.empty = '0';
      video.dataset.proxy = proxyPath ? '1' : '0';
      video.src = url;
      video.load();
      // Park on the first frame so the preview is never a black rectangle.
      const park = () => {
        video.removeEventListener('loadedmetadata', park);
        if (token !== previewLoadToken) return;
        try {
          video.currentTime = Math.min(0.1, Math.max(0, (clip.meta.duration || 1) * 0.02));
        } catch (_) {}
        renderTransport();
      };
      video.addEventListener('loadedmetadata', park);
    }
    setPreviewInfo(clip);
    renderPreviewBadges(clip);
  }

  // ------------------------------------------------- still frame fallback --
  /**
   * Windows/Chromium cannot decode every camera codec (HEVC 10-bit is the usual
   * suspect). When that happens the clip must not disappear: we ask the main
   * process for a full-size ffmpeg still and explain the situation calmly.
   */
  function clearStill() {
    if (dom.previewStill) {
      dom.previewStill.hidden = true;
      dom.previewStill.removeAttribute('src');
    }
    if (video) video.style.visibility = '';
  }

  function hidePreviewNotice() {
    if (dom.previewNotice) dom.previewNotice.hidden = true;
  }

  function showPreviewNotice(html) {
    if (!dom.previewNotice) return;
    dom.previewNotice.innerHTML = html;
    dom.previewNotice.hidden = false;
    const openBtn = dom.previewNotice.querySelector('[data-open-player]');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        const clip = current();
        if (clip) FF.shell.openPath({ path: clip.sourcePath });
      });
    }
    const relinkBtn = dom.previewNotice.querySelector('[data-relink]');
    if (relinkBtn) relinkBtn.addEventListener('click', () => window.FFPanels.relinkClip(state.currentClipId));
  }

  function codecLabelFor(clip) {
    const meta = (clip && clip.meta) || {};
    const raw = String(meta.videoCodec || '').trim();
    if (!raw) return '';
    const map = { h265: 'HEVC (H.265)', hevc: 'HEVC (H.265)', avc1: 'H.264', h264: 'H.264', prores: 'Apple ProRes', dnxhd: 'Avid DNxHD', av1: 'AV1', vp9: 'VP9' };
    return map[raw.toLowerCase()] || raw.toUpperCase();
  }

  function showStillFor(clip, reason) {
    if (!dom.previewStill) return;
    dom.previewStill.hidden = false;
    dom.previewStill.alt = `Still frame from ${clip.fileName}`;
    video.dataset.empty = '1';
    try {
      video.pause();
    } catch (_) {}
    video.style.visibility = 'hidden';
    const codec = codecLabelFor(clip);
    const why =
      reason === 'play' ? 'cannot be played inside the app' : 'cannot be decoded by the in-app player';
    showPreviewNotice(
      `<b>Showing a still frame — this clip ${why}.</b> ` +
        (codec ? `Codec: ${escapeHtml(codec)}. ` : '') +
        'Renaming, metadata and export all work normally; only playback needs an external player. ' +
        '<div class="pn-actions">' +
        '<button class="btn mini" data-open-player>OPEN IN PLAYER</button>' +
        '<button class="btn mini subtle" data-relink>RELINK / LOCATE</button>' +
        '</div>'
    );

    FF.media
      .thumbnail({ id: `${clip.id}:still`, sourcePath: clip.sourcePath, duration: clip.meta ? clip.meta.duration : 0, width: 1280, variant: 'still' })
      .then((res) => {
        if (state.currentClipId !== clip.id) return; // user moved on
        if (!res || !res.ok || !res.path) {
          // No engine and no still: never leave a black rectangle behind.
          showUnplayableFor(clip, reason);
          return;
        }
        dom.previewStill.src = FF.thumbUrl(res.path);
      })
      .catch(() => showUnplayableFor(clip, reason));
  }

  /** Called whenever the player cannot show a clip. */
  function onPreviewFailure(clip, reason) {
    if (!clip) return;
    stopAllMotion();
    playPauseUI(false);
    const why = reason || 'codec';
    state.previewStillBy = { id: clip.id, reason: why };
    if (why === 'read') {
      // The file itself is the problem, not the codec: a proxy cannot help.
      showUnreadableFor(clip);
      setPreviewInfo(clip);
      renderPreviewBadges(clip);
      return;
    }
    showStillFor(clip, why);
    setPreviewInfo(clip);
    renderPreviewBadges(clip);
    // A still frame is a stopgap — try to win real playback back with a proxy.
    requestProxyPreview(clip);
  }

  /** The file cannot be read at all: point at relink instead of a proxy. */
  function showUnreadableFor(clip) {
    if (!clip || state.currentClipId !== clip.id) return;
    if (dom.previewStill) {
      dom.previewStill.hidden = true;
      dom.previewStill.removeAttribute('src');
    }
    showPreviewNotice(
      '<b>This clip could not be read.</b> ' +
        'The file may have been moved, renamed or be on a drive that is not connected. ' +
        'Locate it again to keep previewing and renaming it — nothing in your project is lost.' +
        '<div class="pn-actions">' +
        '<button class="btn mini" data-relink>RELINK / LOCATE</button>' +
        '<button class="btn mini subtle" data-open-player>OPEN IN PLAYER</button>' +
        '</div>'
    );
    setStatus('This clip could not be read — clicking RELINK / LOCATE finds the file again.', 'error');
  }

  // ---------------------------------------------------- preview proxy -------
  /**
   * Camera codecs (HEVC/H.265, ProRes, DNxHD, 10-bit …) cannot be decoded by
   * the player Chromium ships, which is why such a clip used to show nothing at
   * all. When the media engine is available the app now builds a small H.264
   * stand-in for that one clip and plays that, so rushes stay scrubbable. The
   * original file is only ever read.
   */
  async function engineAvailable() {
    if (state.engineReady !== null) return state.engineReady;
    try {
      const engines = await FF.settings.checkEngines();
      state.engineReady = Boolean(engines && engines.ffmpeg && engines.ffmpeg.ok);
    } catch (_) {
      state.engineReady = false;
    }
    return state.engineReady;
  }

  /**
   * Forgets the cached "is the media engine installed?" answer. Settings calls
   * this after a download / locate / re-check, so a user who installs FFmpeg
   * while the app is open gets previews without restarting.
   */
  async function invalidateEngine() {
    state.engineReady = null;
    try {
      const engines = await FF.settings.checkEngines();
      if (engines && engines.ffmpeg && engines.ffmpeg.ok) hideEngineCard();
    } catch (_) {}
    const clip = current();
    if (clip && state.previewStillBy && state.previewStillBy.id === clip.id) requestProxyPreview(clip);
  }

  async function requestProxyPreview(clip) {
    if (!clip || !clip.sourcePath) return;
    const known = state.proxies.get(clip.id);
    if (known) {
      playProxy(clip, known);
      return;
    }
    if (state.proxyBusy.has(clip.id)) return;
    if (!(await engineAvailable())) {
      showUnplayableFor(clip, 'decode');
      return;
    }

    state.proxyBusy.set(clip.id, { percent: 0 });
    renderPreviewBadges(clip);
    setProxyStatus(clip, 0);
    try {
      const res = await FF.media.proxy({
        id: clip.id,
        sourcePath: clip.sourcePath,
        duration: clip.meta ? clip.meta.duration : 0,
        width: 1280,
      });
      state.proxyBusy.delete(clip.id);
      if (res && res.ok && res.path) {
        state.proxies.set(clip.id, res.path);
        if (state.currentClipId === clip.id) playProxy(clip, res.path);
        return;
      }
      if (res && res.engineMissing) state.engineReady = false;
      showUnplayableFor(clip, 'decode', res && res.error);
    } catch (_) {
      state.proxyBusy.delete(clip.id);
      showUnplayableFor(clip, 'decode');
    } finally {
      renderPreviewBadges(current());
    }
  }

  function setProxyStatus(clip, percent) {
    if (state.currentClipId !== clip.id) return;
    const codec = codecLabelFor(clip);
    showPreviewNotice(
      `<b>Preparing a playable preview… ${Math.round(percent)}%</b> ` +
        (codec ? `Codec: ${escapeHtml(codec)}. ` : '') +
        'The app is building a lightweight copy of this one clip for the built-in player. ' +
        'Your original file is only read — nothing is changed, moved or deleted.' +
        '<div class="pn-actions"><button class="btn mini subtle" data-cancel-proxy>CANCEL</button></div>'
    );
    const btn = dom.previewNotice.querySelector('[data-cancel-proxy]');
    if (btn) btn.addEventListener('click', () => FF.media.cancelProxy({ id: clip.id }));
  }

  /** Plays the proxy of a clip in the main player — with scrubbing, hover, all of it. */
  function playProxy(clip, proxyPath) {
    if (!proxyPath || state.currentClipId !== clip.id) return;
    const url = FF.mediaUrl(proxyPath);
    clearStill();
    hidePreviewNotice();
    dom.previewStill.hidden = true;
    video.dataset.empty = '0';
    video.dataset.proxy = '1';
    if (video.getAttribute('src') !== url) {
      video.removeAttribute('src');
      video.src = url;
      video.load();
    }
    setPreviewInfo(clip);
    renderPreviewBadges(clip);
  }

  /** Nothing here can show this clip (usually: the media engine is missing). */
  function showUnplayableFor(clip, reason, detail) {
    if (!clip || state.currentClipId !== clip.id) return;
    if (dom.previewStill) {
      dom.previewStill.hidden = true;
      dom.previewStill.removeAttribute('src');
    }
    const codec = codecLabelFor(clip);
    showPreviewNotice(
      `<b>This clip cannot be shown inside the app yet.</b> ` +
        (codec ? `Codec: <b>${escapeHtml(codec)}</b> — the built-in player handles H.264, VP9 and AV1. ` : '') +
        (detail ? `${escapeHtml(String(detail))} ` : '') +
        'Installing the free media engine lets the app build a playable preview for this codec. ' +
        'Renaming, tagging and export already work normally.' +
        '<div class="pn-actions">' +
        '<button class="btn mini" data-install-engine>INSTALL MEDIA ENGINE</button>' +
        '<button class="btn mini subtle" data-open-player>OPEN IN PLAYER</button>' +
        '<button class="btn mini subtle" data-relink>RELINK</button>' +
        '</div>'
    );
    const install = dom.previewNotice.querySelector('[data-install-engine]');
    if (install) {
      install.addEventListener('click', () => {
        if (window.FFPanels && window.FFPanels.openEngineSetup) window.FFPanels.openEngineSetup();
        else window.FFPanels.openSettings();
      });
    }
  }

  /** Progress events for a proxy being built (wired up in panels.js). */
  function onProxyProgress(progress) {
    if (!progress || !progress.id) return;
    const clip = clipById(progress.id);
    const entry = state.proxyBusy.get(progress.id);
    if (entry) entry.percent = progress.percent || 0;
    if (clip && state.currentClipId === clip.id && progress.stage !== 'ready') {
      setProxyStatus(clip, progress.percent || 0);
    }
    renderPreviewBadges(current());
  }

  function setPreviewInfo(clip) {
    if (!clip) {
      dom.previewInfo.innerHTML = '<span class="strip-item muted">No clip selected</span>';
      return;
    }
    const bits = [`<span class="strip-item"><b>${escapeHtml(clip.fileName)}</b></span>`];
    if (clip.meta && clip.meta.resolutionText) bits.push(`<span class="strip-item">${clip.meta.resolutionText}</span>`);
    if (clip.meta && clip.meta.fpsText) bits.push(`<span class="strip-item">${clip.meta.fpsText} fps</span>`);
    if (clip.meta && clip.meta.durationText) bits.push(`<span class="strip-item">${clip.meta.durationText}</span>`);
    if (clip.meta && clip.meta.videoCodec) bits.push(`<span class="strip-item">${escapeHtml(clip.meta.videoCodec)}</span>`);
    bits.push(`<span class="strip-item muted">${escapeHtml(FFLib.finalRelativePath(clip))}</span>`);
    dom.previewInfo.innerHTML = bits.join('<span class="muted">·</span>');
  }

  function renderPreviewBadges(clip) {
    // (proxy / unplayable hints are appended below, after the normal badges)
    const out = [];
    if (clip.sceneOn) out.push(`<span class="badge-pill accent">SCENE ${clip.scene}</span>`);
    if (clip.shotOn) out.push(`<span class="badge-pill">SHOT ${clip.shot}</span>`);
    if (clip.takeOn) out.push(`<span class="badge-pill">TAKE ${clip.take}</span>`);
    if (clip.extra) out.push('<span class="badge-pill warn">EXTRA</span>');
    if (state.missing.has(clip.id)) out.push('<span class="badge-pill missing">MEDIA MISSING</span>');

    // What the user is actually watching: the camera file, a preview proxy, or
    // a clip that still needs the media engine before it can be shown at all.
    const busy = state.proxyBusy.get(clip.id);
    if (busy) {
      out.push(`<span class="badge-pill warn">PREPARING PREVIEW ${Math.round(busy.percent || 0)}%</span>`);
    } else if (state.proxies.has(clip.id)) {
      out.push(`<span class="badge-pill accent" title="A lightweight H.264 copy of this clip made for previewing — the original file is untouched">PREVIEW COPY${codecLabelFor(clip) ? `: ${escapeHtml(codecLabelFor(clip))}` : ''}</span>`);
    }
    dom.previewBadges.innerHTML = out.join('');
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderTransport() {
    const duration = video.duration || (current() && current().meta ? current().meta.duration : 0) || 0;
    dom.totalTime.textContent = FFLib.formatClock(duration);
    if (!video.duration) dom.curTime.textContent = '00:00.0';
    dom.timeline.value = duration ? String(Math.round((video.currentTime / duration) * 1000)) : '0';
    updateTimelineFill();
    playPauseUI(!video.paused && !video.ended);
  }

  function updateTimelineFill() {
    const pct = (Number(dom.timeline.value) / 1000) * 100;
    dom.timeline.style.setProperty('--progress', `${pct}%`);
  }

  function playPauseUI(playing) {
    dom.btnPlay.innerHTML = UI.icon(playing ? 'pause' : 'play');
    dom.btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    dom.btnPlay.classList.toggle('playing', playing);
  }

  /**
   * Kills every kind of automatic motion: hover-shuttle and the J/K/L shuttle.
   * Pausing must always win — a hover-shuttle that kept stepping the timeline
   * after Space was pressed was the bug behind "pause karke bhi chal raha hai".
   */
  function stopAllMotion() {
    if (typeof endScrub === 'function') endScrub();
    if (typeof stopShuttle === 'function') stopShuttle(true);
    if (typeof hideOsdSoon === 'function') hideOsdSoon();
  }

  /** True when the player sits on the last frame of the clip. */
  function atEndOfClip() {
    const duration = video.duration || 0;
    return Boolean(video.ended) || (duration > 0 && video.currentTime >= duration - 0.06);
  }

  /**
   * Plays again from the very start when the clip has finished. Playing an
   * already-ended element is a no-op in Chromium, so "press space after the clip
   * ended" used to look exactly like a broken play button.
   */
  function replayFromStart() {
    video.pause();
    try {
      video.currentTime = 0;
    } catch (_) {}
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      video.removeEventListener('seeked', go);
      video.playbackRate = 1;
      startPlayback();
    };
    if (video.seeking || video.currentTime > 0.01) {
      video.addEventListener('seeked', go, { once: true });
      setTimeout(go, 220); // never wait forever on a stubborn decoder
    } else {
      go();
    }
  }

  /**
   * Starts playback and copes with the browser refusing unmuted autoplay
   * (Chromium blocks it without a user gesture). Instead of silently doing
   * nothing — which used to look exactly like "the play button is broken" —
   * we retry muted and keep the transport honest.
   */
  function startPlayback() {
    const attempt = video.play();
    if (!attempt || !attempt.catch) return;
    attempt.catch((err) => {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        video.muted = true;
        dom.btnMute.innerHTML = UI.icon('muted');
        dom.btnMute.setAttribute('aria-label', 'Unmute');
        const retry = video.play();
        if (retry && retry.catch) retry.catch(() => setStatus('Press play once more to start this clip.', 'warn'));
        return;
      }
      setStatus('This clip could not be played in the app. Try “Open in player”.', 'error');
    });
  }

  function togglePlay() {
    if (!video.src || state.missing.has(state.currentClipId)) return;
    stopAllMotion();
    if (video.ended || atEndOfClip()) {
      replayFromStart();
    } else if (video.paused) {
      video.playbackRate = 1;
      startPlayback();
    } else {
      video.pause();
    }
    renderTransport();
  }

  function toggleMute() {
    video.muted = !video.muted;
    dom.btnMute.innerHTML = UI.icon(video.muted ? 'muted' : 'volume');
    dom.btnMute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  }

  // ------------------------------------------------------- hover scrubbing --
  const scrub = {
    mode: 'idle', // idle | fwd | rev
    speed: 1,
    raf: null,
    lastTs: 0,
    stepAccum: 0,
    wasMuted: false,
    get active() {
      return this.mode !== 'idle';
    },
  };

  function scrubSpeedFor(clientX) {
    const rect = dom.stage.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const half = rect.width / 2;
    const dx = Math.abs(clientX - center);
    const dead = half * 0.12;
    const t = clamp((dx - dead) / Math.max(1, half - dead), 0, 1);
    const index = Math.min(SCRUB_STEPS.length - 1, Math.floor(t * SCRUB_STEPS.length));
    return { speed: SCRUB_STEPS[index], index };
  }

  function updateScrubFromPointer(clientX, clientY) {
    if (!video.src || !video.duration) return;
    const rect = dom.stage.getBoundingClientRect();
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    if (!inside) {
      endScrub();
      return;
    }
    const center = rect.left + rect.width / 2;
    const dir = clientX < center ? -1 : 1;
    const { speed, index } = scrubSpeedFor(clientX);
    // Require a small dead zone in the middle so hovering the centre is safe.
    const dead = rect.width * 0.06;
    if (Math.abs(clientX - center) < dead) {
      endScrub();
      return;
    }
    startScrub(dir, speed, index);
  }

  function startScrub(dir, speed, index) {
    if (typeof stopShuttle === 'function' && shuttle.dir) stopShuttle(true);
    const label = `${speed}×`;
    if (dir > 0) {
      dom.zoneFwd.classList.add('active');
      dom.zoneBack.classList.remove('active');
      dom.speedFwd.textContent = label;
    } else {
      dom.zoneBack.classList.add('active');
      dom.zoneFwd.classList.remove('active');
      dom.speedBack.textContent = label;
    }
    if (scrub.mode === 'idle') {
      scrub.wasMuted = video.muted;
      video.muted = true;
    }
    const changedDir = scrub.mode !== (dir > 0 ? 'fwd' : 'rev');
    scrub.mode = dir > 0 ? 'fwd' : 'rev';
    scrub.speed = speed;
    scrub.index = index;

    if (scrub.mode === 'fwd') {
      if (speed > 1) {
        if (atEndOfClip()) replayFromStart();
        video.playbackRate = Math.min(16, speed);
        if (video.paused) startPlayback();
      } else {
        video.pause();
        video.playbackRate = 1;
        startScrubLoop();
      }
    } else {
      video.pause();
      video.playbackRate = 1;
      startScrubLoop();
    }
    if (changedDir) {
      showOsd(`${scrub.mode === 'fwd' ? '▶▶ FORWARD' : '◀◀ BACKWARD'}  ${label}`);
    } else {
      updateOsd(`${label}`);
    }
  }

  function startScrubLoop() {
    if (scrub.raf) return;
    scrub.lastTs = performance.now();
    scrub.stepAccum = 0;
    const tick = (ts) => {
      scrub.raf = null;
      if (!scrub.active) return;
      const dt = Math.min(0.05, (ts - scrub.lastTs) / 1000);
      scrub.lastTs = ts;
      if (video.duration) {
        if (scrub.mode === 'rev') {
          // Reverse is stepped: browsers cannot play negative rates.
          const interval = scrub.speed <= 1 ? 1 / 30 : 1 / 15;
          scrub.stepAccum += dt;
          let steps = 0;
          while (scrub.stepAccum >= interval && steps < 4) {
            scrub.stepAccum -= interval;
            steps += 1;
          }
          if (steps) {
            video.currentTime = clamp(video.currentTime - scrub.speed * interval * steps, 0, video.duration - 0.05);
          }
        } else if (scrub.speed <= 1) {
          const next = video.currentTime + scrub.speed * dt;
          video.currentTime = clamp(next, 0, Math.max(0, video.duration - 0.03));
        }
      }
      scrub.raf = requestAnimationFrame(tick);
    };
    scrub.raf = requestAnimationFrame(tick);
  }

  function endScrub() {
    if (!scrub.active && scrub.raf === null) return;
    scrub.mode = 'idle';
    if (scrub.raf) cancelAnimationFrame(scrub.raf);
    scrub.raf = null;
    dom.zoneFwd.classList.remove('active');
    dom.zoneBack.classList.remove('active');
    dom.stage.classList.remove('zone-hint');
    if (video.playbackRate !== 1) video.playbackRate = 1;
    video.muted = scrub.wasMuted;
    hideOsdSoon();
  }

  let osdTimer = null;
  function showOsd(text) {
    dom.osd.hidden = false;
    dom.osd.textContent = text;
    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = null;
  }
  function updateOsd(text) {
    if (!dom.osd.hidden) dom.osd.textContent = text;
  }
  function hideOsdSoon() {
    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = setTimeout(() => {
      dom.osd.hidden = true;
    }, 800);
  }

  // ------------------------------------------------------ hover clip preview --
  // The floating preview that followed the mouse was removed in 1.2.0: hovering
  // a row still loads that clip into the big centre preview (settings.hoverPreroll),
  // which was the useful half of the feature.
  function stopHoverPreview() {
    state.hoverClipId = null;
    state.hoverTimerRow = null;
  }

  /** The transport button says whether hover-shuttle is on — and toggles it. */
  function shuttleEnabled() {
    return Boolean(state.settings && state.settings.hoverShuttle);
  }

  function paintShuttleHint() {
    const el = $('btnScrubHint');
    if (!el) return;
    const on = shuttleEnabled();
    // Whatever switched hover-shuttle off (transport button, Settings panel,
    // a fresh import of settings) must also stop a scrub that is in flight —
    // otherwise the clip keeps crawling even though the feature is "off".
    if (!on && scrub.mode !== 'idle') endScrub();
    el.textContent = on ? 'Hover-shuttle ON' : 'Hover-shuttle OFF';
    el.classList.toggle('on', on);
    el.title = on
      ? 'Hover-shuttle is ON: move the pointer to the left or right edge of the video to shuttle backwards or forwards. Click to switch it off.'
      : 'Hover-shuttle is OFF (default). Click to switch it on, or open Settings → Preview.';
  }

  function bindShuttleHint() {
    const el = $('btnScrubHint');
    if (!el) return;
    el.addEventListener('click', async () => {
      const next = !shuttleEnabled();
      state.settings = await FF.settings.set({ hoverShuttle: next });
      paintShuttleHint();
      if (!next) endScrub();
      UI.toast(
        next
          ? 'Hover-shuttle is on — move the pointer to the left or right of the video to shuttle.'
          : 'Hover-shuttle is off.',
        { type: 'info', timeout: 2600 }
      );
    });
  }

  // -------------------------------------------------------- pane resizing --
  /**
   * After Effects-style dividers. The workspace is a grid driven by CSS
   * variables, so dragging is a matter of writing pixels:
   *   --split-right → width of the clip list (the preview takes the rest)
   *   --console-h   → height of the renaming console
   * Both values live in the settings file, so your layout survives a restart.
   */
  const LAYOUT_LIMITS = { minLeft: 300, minRight: 300, splitter: 7, minConsole: 46, minStage: 190 };

  function storedLayout() {
    const l = (state.settings && state.settings.layout) || {};
    return { right: Number(l.right) || 0, consoleH: Number(l.consoleH) || 0 };
  }

  function applyLayout(prefs) {
    const ws = dom.workspace;
    if (!ws) return null;
    const width = ws.clientWidth || window.innerWidth;
    const height = ws.clientHeight || window.innerHeight;
    const { minLeft, minRight, splitter, minConsole, minStage } = LAYOUT_LIMITS;
    const maxRight = Math.max(minRight, width - splitter - minLeft);
    const right = clamp(Number(prefs.right) || Math.round(clamp(width * 0.28, 330, 470)), minRight, maxRight);
    const left = Math.max(minLeft, width - splitter - right);
    const consoleH = clamp(Number(prefs.consoleH) || 296, minConsole, Math.max(minConsole, height - minStage));
    ws.style.setProperty('--split-left', `${Math.round(left)}px`);
    ws.style.setProperty('--split-right', `${Math.round(right)}px`);
    ws.style.setProperty('--console-h', `${Math.round(consoleH)}px`);
    return { right, consoleH };
  }

  let layoutSaveTimer = null;
  function persistLayout(prefs) {
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      FF.settings
        .set({ layout: { right: Math.round(prefs.right), consoleH: Math.round(prefs.consoleH) } })
        .then((next) => {
          if (next) state.settings = next;
        })
        .catch(() => {});
    }, 260);
  }

  function bindSplitters() {
    const ws = dom.workspace;
    if (!ws) return;
    const initial = applyLayout(storedLayout()) || { right: 400, consoleH: 250 };
    let live = Object.assign({}, initial);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        live = applyLayout(live) || live;
        renderBrowser(true);
      }, 90);
    });

    const drag = (el, axis, compute) => {
      if (!el) return;
      el.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        el.classList.add('active');
        document.body.style.cursor = axis === 'v' ? 'col-resize' : 'row-resize';
        const move = (e) => {
          live = applyLayout(compute(e, ws)) || live;
          if (axis === 'v') renderBrowser(true);
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          el.classList.remove('active');
          document.body.style.cursor = '';
          persistLayout(live);
          renderBrowser(true);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });

      // Keyboard resizing (accessibility): arrows nudge, Home / double-click resets.
      el.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 40 : 12;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          if (axis === 'v') {
            const delta = event.key === 'ArrowRight' ? -step : event.key === 'ArrowLeft' ? step : 0;
            live = applyLayout({ right: live.right + delta, consoleH: live.consoleH }) || live;
          } else {
            const delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
            live = applyLayout({ right: live.right, consoleH: live.consoleH + delta }) || live;
          }
          persistLayout(live);
          renderBrowser(true);
        }
        if (event.key === 'Home') {
          event.preventDefault();
          live = applyLayout({ right: 0, consoleH: 0 }) || live;
          persistLayout(live);
        }
      });
      el.addEventListener('dblclick', () => {
        live = applyLayout({ right: 0, consoleH: 0 }) || live;
        persistLayout(live);
        renderBrowser(true);
      });
    };

    drag($('splitMain'), 'v', (e, wsEl) => {
      const rect = wsEl.getBoundingClientRect();
      return { right: Math.round(rect.right - e.clientX), consoleH: live.consoleH };
    });
    drag($('splitConsole'), 'h', (e, wsEl) => {
      const rect = wsEl.getBoundingClientRect();
      return { right: live.right, consoleH: Math.round(rect.bottom - e.clientY) };
    });
  }

  // ------------------------------------------------- J / K / L playback (DaVinci)
  // L plays forward, J plays backward, K stops; pressing J/L again steps the
  // speed up 1× 2× 4× 8×. Reverse playback is stepped, because browsers cannot
  // play a video element at a negative rate.
  const shuttle = { dir: 0, speed: 1, raf: null, lastTs: 0, wasMuted: false };

  function shuttleLabel() {
    const arrow = shuttle.dir > 0 ? '▶▶' : '◀◀';
    return `${arrow} ${shuttle.dir > 0 ? 'FORWARD' : 'BACKWARD'}  ${shuttle.speed}×`;
  }

  function shuttleSpeedUp(dir) {
    if (shuttle.dir === dir) {
      shuttle.speed = Math.min(8, shuttle.speed * 2);
    } else {
      shuttle.speed = 1;
    }
    shuttle.dir = dir;
  }

  function stopShuttle(silent) {
    if (shuttle.raf) cancelAnimationFrame(shuttle.raf);
    shuttle.raf = null;
    shuttle.dir = 0;
    shuttle.speed = 1;
    if (video.playbackRate !== 1) video.playbackRate = 1;
    if (!silent) video.muted = shuttle.wasMuted;
    playPauseUI(!video.paused);
    if (!silent) hideOsdSoon();
  }

  function shuttleLoop() {
    if (shuttle.raf) return;
    shuttle.lastTs = performance.now();
    const tick = (ts) => {
      shuttle.raf = null;
      if (!shuttle.dir) return;
      const dt = Math.min(0.1, (ts - shuttle.lastTs) / 1000);
      shuttle.lastTs = ts;
      const duration = video.duration || 0;
      if (duration) {
        if (shuttle.dir < 0) {
          const step = Math.max(1 / 30, (shuttle.speed / 30) * dt * 30);
          video.currentTime = clamp(video.currentTime - shuttle.speed * dt, 0, Math.max(0, duration - 0.05));
          void step;
        } else if (shuttle.speed <= 1) {
          video.currentTime = clamp(video.currentTime + shuttle.speed * dt, 0, Math.max(0, duration - 0.03));
        }
      }
      shuttle.raf = requestAnimationFrame(tick);
    };
    shuttle.raf = requestAnimationFrame(tick);
  }

  function playForward() {
    if (!video.src || state.missing.has(state.currentClipId)) return;
    endScrub();
    if (atEndOfClip()) {
      // "L after the clip finished" should replay it, like every NLE.
      replayFromStart();
      showOsd('▶▶ FORWARD  1×');
      setStatus('Playing from the start.');
      return;
    }
    if (!shuttle.dir) shuttle.wasMuted = video.muted;
    shuttleSpeedUp(1);
    if (shuttle.dir === 1 && shuttle.speed > 1) {
      // Fast forward: let the decoder do the work.
      if (shuttle.raf) {
        cancelAnimationFrame(shuttle.raf);
        shuttle.raf = null;
      }
      video.playbackRate = Math.min(16, shuttle.speed);
      if (video.paused) startPlayback();
    } else {
      video.playbackRate = 1;
      if (video.paused) startPlayback();
    }
    showOsd(shuttleLabel());
    setStatus(`Playback: ${shuttleLabel()}`);
  }

  function playReverse() {
    if (!video.src || !video.duration || state.missing.has(state.currentClipId)) return;
    endScrub();
    if (!shuttle.dir) shuttle.wasMuted = video.muted;
    shuttleSpeedUp(-1);
    video.pause();
    video.playbackRate = 1;
    shuttleLoop();
    showOsd(shuttleLabel());
    setStatus(`Playback: ${shuttleLabel()}`);
  }

  function stopPlayback() {
    const wasShuttling = Boolean(shuttle.dir);
    stopShuttle(false);
    video.pause();
    playPauseUI(false);
    if (wasShuttling) showOsd('■ STOP');
    setStatus('Stopped.');
  }

  /**
   * Read-only snapshot of what the player is doing. Used by the OSD / shortcut
   * layer and by the automated UI tests, so nothing has to reach into the
   * closure-bound shuttle object.
   */
  function playbackInfo() {
    return {
      direction: shuttle.dir,
      speed: shuttle.speed,
      rate: video.playbackRate || 1,
      playing: Boolean(video.src) && !video.paused,
      paused: !video.src || video.paused,
      muted: video.muted,
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      label: shuttle.dir ? shuttleLabel() : '',
      hoverShuttle: shuttleEnabled(),
      scrub: scrub.mode,
      scrubSpeed: scrub.speed,
      clipId: state.currentClipId,
      missing: state.missing.has(state.currentClipId),
      still: Boolean(state.previewStillBy && state.previewStillBy.id === state.currentClipId),
    };
  }

  async function toggleFullscreen() {
    const res = await FF.toggleFullscreen();
    if (res && res.ok) setStatus(res.fullscreen ? 'Full screen — Ctrl+F or Esc to leave.' : 'Back to the window.');
  }

  // ------------------------------------------------------------ info panel --
  function renderInfo() {
    const clip = current();
    const index = clip ? state.viewIds.indexOf(clip.id) : -1;

    dom.infoPosition.textContent = clip ? `Clip ${index + 1} of ${state.viewIds.length}` : '—';
    dom.infoFileName.textContent = clip ? clip.fileName : 'No clip selected';
    dom.infoFileName.title = clip ? clip.sourcePath : '';
    dom.infoFileMeta.innerHTML = clip
      ? [
          clip.meta && clip.meta.resolutionText ? clip.meta.resolutionText : null,
          clip.meta && clip.meta.fpsText ? `${clip.meta.fpsText} fps` : null,
          clip.meta && clip.meta.durationText ? clip.meta.durationText : null,
          clip.meta && clip.meta.timecode ? `TC ${clip.meta.timecode}` : null,
          clip.size ? bytes(clip.size) : null,
        ]
          .filter(Boolean)
          .map((t) => `<span>${escapeHtml(t)}</span>`)
          .join('<span class="muted">·</span>')
      : '';

    const enabled = Boolean(clip);
    for (const id of ['sceneOn', 'sceneInput', 'sceneNext', 'shotOn', 'shotInput', 'shotNext', 'takeOn', 'takeInput', 'takeNext', 'extraOn', 'customOn', 'customInput']) {
      const el = dom[id];
      if (el) el.disabled = !enabled;
    }
    $('btnApply').disabled = !enabled;
    $('btnApplyNext').disabled = !enabled;
    $('btnDelete').disabled = !enabled;
    $('copyName').disabled = !enabled;
    $('btnReveal').disabled = !enabled;

    if (!clip) {
      dom.sceneOn.checked = dom.shotOn.checked = dom.takeOn.checked = dom.extraOn.checked = dom.customOn.checked = false;
      dom.sceneInput.value = dom.shotInput.value = dom.takeInput.value = '1';
      dom.customInput.value = '';
      dom.finalName.textContent = '—';
      dom.finalPath.textContent = '';
      dom.finalTimeSource.textContent = '';
      dom.clipIssues.hidden = true;
      dom.mediaStatus.innerHTML = '';
      updateFieldAvailability();
      return;
    }

    // Fields the user is actively typing into are left alone; everything else is
    // repainted from the clip so undo/redo and clip switching stay in sync.
    const pending = state.pendingEdits;
    for (const field of ['scene', 'shot', 'take']) {
      if (pending[field]) continue;
      dom[`${field}On`].checked = Boolean(clip[`${field}On`]);
      const value = clip[field];
      dom[`${field}Input`].value = value === null || value === undefined ? '' : String(value);
    }
    if (!pending.custom) {
      dom.customOn.checked = Boolean(clip.customOn);
      dom.customInput.value = clip.custom || '';
    }
    dom.extraOn.checked = Boolean(clip.extra);

    updateFieldAvailability();
    updateNextButtons();
    updateFinalName();
    renderClipIssues(clip);
    renderMediaStatus(clip);
  }

  function bytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = b / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
  }

  function updateFieldAvailability() {
    for (const field of ['scene', 'shot', 'take']) {
      const on = dom[`${field}On`].checked;
      const group = dom[`${field}Input`].closest('.field-group');
      group.classList.toggle('accent-on', on);
      dom[`${field}Input`].disabled = !current() || !on;
      dom[`${field}Badge`].textContent = on ? `${field.toUpperCase()} ON` : '';
    }
    const customOn = dom.customOn.checked;
    dom.customInput.disabled = !current() || !customOn;
    dom.customInput.closest('.field-group').classList.toggle('accent-on', customOn);
  }

  /** Previous clip in import order — the reference for NEXT FROM PREVIOUS. */
  function previousClipFor(clip) {
    if (!clip) return null;
    const ordered = state.project.clips.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const index = ordered.findIndex((c) => c.id === clip.id);
    if (index <= 0) return null;
    return ordered[index - 1];
  }

  function updateNextButtons() {
    const clip = current();
    const prev = clip ? previousClipFor(clip) : null;
    for (const field of ['scene', 'shot', 'take']) {
      const btn = dom[`${field}Next`];
      const hint = dom[`${field}Hint`];
      const label = field.toUpperCase();
      if (!clip) {
        btn.disabled = true;
        hint.textContent = '';
        continue;
      }
      if (!prev) {
        btn.disabled = true;
        btn.title = 'The first clip in the project has no previous clip.';
        hint.textContent = 'First clip — no previous clip to continue from.';
        continue;
      }
      btn.disabled = false;
      const prevOn = Boolean(prev[`${field}On`]);
      const prevValue = prev[field];
      const usable = prevOn && prevValue !== null && prevValue !== undefined && prevValue !== '';
      const nextValue = usable ? Number(prevValue) + 1 : 1;
      btn.title = usable
        ? `Previous clip has ${label} ${prevValue} → this sets ${label} ${nextValue}. Affects ${label} only.`
        : `Previous clip has no ${label} set → this sets ${label} 1.`;
      hint.textContent = usable ? `Previous clip: ${label} ${prevValue} → ${nextValue}` : `Previous clip has no ${label}`;
    }
  }

  function renderClipIssues(clip) {
    const issues = (state.validation && state.validation.byClip[clip.id]) || [];
    if (!issues.length) {
      dom.clipIssues.hidden = true;
      dom.clipIssues.innerHTML = '';
      return;
    }
    dom.clipIssues.hidden = false;
    dom.clipIssues.innerHTML = issues
      .slice(0, 4)
      .map(
        (i) =>
          `<div class="issue ${i.level}"><span class="issue-icon">${i.level === 'error' ? '!' : i.level === 'warning' ? '⚠' : 'i'}</span><span>${escapeHtml(
            i.message
          )}</span></div>`
      )
      .join('');
  }

  function renderMediaStatus(clip) {
    const bits = [];
    if (state.missing.has(clip.id)) {
      bits.push('<span class="danger-text">Media Missing — the source file could not be found.</span>');
      bits.push('<button class="btn danger" id="btnRelink">RELINK CLIP</button>');
    } else {
      bits.push(`<span title="${escapeHtml(clip.sourcePath)}">Source: ${escapeHtml(clip.sourcePath)}</span>`);
      bits.push(
        `<span class="muted">Read-only — the original file is never renamed, moved or deleted.</span>`
      );
    }
    dom.mediaStatus.innerHTML = bits.join('');
    const relink = $('btnRelink');
    if (relink) relink.addEventListener('click', () => window.FFPanels.relinkClip(clip.id));
  }

  function updateFinalName() {
    const clip = current();
    if (!clip) {
      dom.finalName.textContent = '—';
      dom.finalPath.textContent = '';
      dom.finalTimeSource.textContent = '';
      return;
    }
    // Read the live panel values so the preview updates instantly while typing.
    const preview = Object.assign({}, clip, {
      sceneOn: dom.sceneOn.checked,
      scene: FFLib.toIntOrNull(dom.sceneInput.value),
      shotOn: dom.shotOn.checked,
      shot: FFLib.toIntOrNull(dom.shotInput.value),
      takeOn: dom.takeOn.checked,
      take: FFLib.toIntOrNull(dom.takeInput.value),
      extra: dom.extraOn.checked,
      customOn: dom.customOn.checked,
      custom: dom.customInput.value,
    });
    const name = FFLib.finalFileName(preview);
    dom.finalName.textContent = name;
    dom.finalPath.textContent = FFLib.finalRelativePath(preview);
    dom.finalName.title = FFLib.needsNaming(preview) ? 'Set Scene / Shot / Take or a Custom Name' : 'This is the name used on export';
    if (clip.meta && clip.meta.timecodeFromSource && clip.meta.timecode) {
      dom.finalTimeSource.textContent = `Time from source timecode ${clip.meta.timecode}`;
    } else {
      const mode = (state.settings && state.settings.timecodeFallback) || 'file-time';
      const label = mode === 'zero' ? '00-00-00 (fixed fallback)' : mode === 'index' ? 'project position (fallback)' : 'file timestamp (fallback)';
      dom.finalTimeSource.textContent = `No source timecode — using ${label}`;
    }
  }

  // ------------------------------------------------------------ mutations --
  function snapshot(label) {
    return {
      label,
      clips: state.project.clips.map((c) => ({
        id: c.id,
        order: c.order,
        sceneOn: c.sceneOn,
        scene: c.scene,
        shotOn: c.shotOn,
        shot: c.shot,
        takeOn: c.takeOn,
        take: c.take,
        extra: c.extra,
        customOn: c.customOn,
        custom: c.custom,
        status: c.status,
      })),
    };
  }

  function pushUndo(label) {
    state.undo.push(snapshot(label));
    if (state.undo.length > 120) state.undo.shift();
    state.redo = [];
  }

  function restoreSnapshot(snap) {
    for (const item of snap.clips) {
      const clip = clipById(item.id);
      if (!clip) continue;
      Object.assign(clip, {
        order: item.order,
        sceneOn: item.sceneOn,
        scene: item.scene,
        shotOn: item.shotOn,
        shot: item.shot,
        takeOn: item.takeOn,
        take: item.take,
        extra: item.extra,
        customOn: item.customOn,
        custom: item.custom,
        status: item.status,
      });
    }
  }

  function undo() {
    clearPendingEdits();
    if (!state.undo.length) {
      setStatus('Nothing to undo.');
      return;
    }
    const snap = state.undo.pop();
    state.redo.push(snapshot(snap.label));
    restoreSnapshot(snap);
    markDirty();
    refreshAll();
    setStatus(`Undo: ${snap.label}`);
  }

  function redo() {
    clearPendingEdits();
    if (!state.redo.length) {
      setStatus('Nothing to redo.');
      return;
    }
    const snap = state.redo.pop();
    state.undo.push(snapshot(snap.label));
    restoreSnapshot(snap);
    markDirty();
    refreshAll();
    setStatus(`Redo: ${snap.label}`);
  }

  /** Copies panel fields onto the current clip (no disk changes). */
  function commitFieldsToClip(clip, label) {
    clearPendingEdits();
    clip.sceneOn = dom.sceneOn.checked;
    clip.scene = dom.sceneOn.checked ? FFLib.toIntOrNull(dom.sceneInput.value) : null;
    clip.shotOn = dom.shotOn.checked;
    clip.shot = dom.shotOn.checked ? FFLib.toIntOrNull(dom.shotInput.value) : null;
    clip.takeOn = dom.takeOn.checked;
    clip.take = dom.takeOn.checked ? FFLib.toIntOrNull(dom.takeInput.value) : null;
    clip.extra = dom.extraOn.checked;
    clip.customOn = dom.customOn.checked;
    clip.custom = String(dom.customInput.value || '');
    // An empty custom name must never wipe the standard name — but the switch
    // stays where the user put it: flipping it back off on its own (and leaving
    // the text box disabled, so the name could not even be typed) was the most
    // confusing thing in the app. While the box is empty the live preview falls
    // back to the standard name, the clip counts as un-tagged and validation
    // raises "Custom name is enabled but empty." — all without fighting the user.
    if (clip.sceneOn && clip.scene === null) clip.scene = 1;
    if (clip.shotOn && clip.shot === null) clip.shot = 1;
    if (clip.takeOn && clip.take === null) clip.take = 1;
    clip.status = STATUS.APPLIED;
    return clip;
  }

  function applyCurrent(options) {
    const opts = options || {};
    const clip = current();
    if (!clip) return { ok: false, reason: 'No clip selected.' };

    pushUndo(`${opts.advance ? 'Apply & Next' : 'Apply'} on ${clip.fileName}`);
    commitFieldsToClip(clip);
    clearPendingEdits();
    markDirty();
    state.lastAppliedAt = Date.now();

    // Validate the clip after the change.
    scheduleValidation();

    if (opts.advance) {
      const index = state.viewIds.indexOf(clip.id);
      const nextId = index >= 0 ? state.viewIds[index + 1] : null;
      if (nextId) {
        selectClip(nextId, { scroll: true });
        setStatus(`Saved ${clip.fileName} — moved to the next clip.`);
      } else {
        renderInfo();
        renderBrowser(true);
        setStatus(`Saved ${clip.fileName} — this is the last clip.`);
        UI.toast('That was the last clip in this view.', { type: 'info', timeout: 2500 });
      }
    } else {
      renderInfo();
      renderBrowser(true);
      setStatus(`Saved metadata for ${clip.fileName}.`);
    }
    renderFooter();
    flashFooter();
    return { ok: true, finalName: FFLib.finalFileName(clip) };
  }

  function nextFromPrevious(field) {
    const clip = current();
    if (!clip) return;
    const prev = previousClipFor(clip);
    if (!prev) {
      setStatus('The first clip has no previous clip to continue from.', 'warn');
      return;
    }
    pushUndo(`Next ${field} from previous`);
    clearPendingEdits();
    const prevOn = Boolean(prev[`${field}On`]);
    const prevValue = prev[field];
    const usable = prevOn && prevValue !== null && prevValue !== undefined && prevValue !== '';
    const value = usable ? Number(prevValue) + 1 : 1;
    dom[`${field}On`].checked = true;
    dom[`${field}Input`].value = String(value);
    dom[`${field}Input`].disabled = false;
    clip[`${field}On`] = true;
    clip[field] = value;
    markDirty();
    updateFieldAvailability();
    updateNextButtons();
    updateFinalName();
    scheduleValidation();
    setStatus(`${field.toUpperCase()} ${value} set from the previous clip.`);
    renderBrowser(true);
  }

  function deleteClipFlow(id) {
    const clip = clipById(id || state.currentClipId);
    if (!clip) return;
    UI.modal({
      title: "You're about to delete this clip.",
      size: 'small',
      body: (() => {
        const wrap = document.createElement('div');
        wrap.className = 'modal-section';
        const p = document.createElement('div');
        p.style.fontSize = '13.5px';
        p.textContent = 'This will remove the clip from the current project. Your original source file will not be deleted.';
        const f = document.createElement('div');
        f.className = 'modal-note';
        f.textContent = clip.fileName;
        wrap.append(p, f);
        return wrap;
      })(),
      buttons: [
        { label: 'CANCEL', className: 'secondary', value: 'cancel', autofocus: true },
        { label: 'DELETE CLIP', className: 'danger', value: 'delete' },
      ],
      onClose: (value) => {
        if (value !== 'delete') return;
        pushUndo(`Delete ${clip.fileName}`);
        const index = state.project.clips.findIndex((c) => c.id === clip.id);
        state.project.clips.splice(index, 1);
        state.project.clips.forEach((c, i) => {
          c.order = i;
        });
        state.viewIds = state.viewIds.filter((v) => v !== clip.id);
        if (state.currentClipId === clip.id) {
          const nextId = state.viewIds[Math.min(state.viewIds.length - 1, Math.max(0, Math.floor(index)))] || (state.project.clips[0] ? state.project.clips[0].id : null);
          state.currentClipId = nextId;
        }
        markDirty();
        computeView();
        renderBrowser(true);
        renderInfo();
        renderFooter();
        if (state.currentClipId) loadClipIntoPreview(clipById(state.currentClipId));
        else loadClipIntoPreview(null);
        setStatus(`Removed ${clip.fileName} from the project. The source file is untouched.`);
        UI.toast('Clip removed from the project. The original file was not deleted.', { type: 'success', timeout: 3000 });
      },
    });
  }

  // -------------------------------------------------------------- footer --
  function renderFooter() {
    const clips = state.project.clips;
    const userFacing = clips.filter((c) => c.status === STATUS.APPLIED || c.status === STATUS.EXPORTED).length;
    const sceneSet = new Set();
    clips.forEach((c) => {
      if (c.sceneOn && c.scene !== null && c.scene !== undefined && c.scene !== '') sceneSet.add(Number(c.scene));
    });
    const extras = clips.filter((c) => c.extra).length;
    const warnings = state.validation ? state.validation.warningCount : 0;
    const errors = state.validation ? state.validation.errorCount : 0;

    const index = state.currentClipId ? state.viewIds.indexOf(state.currentClipId) : -1;
    dom.statusClip.textContent = `Clip ${index >= 0 ? index + 1 : 0} / ${state.viewIds.length}`;

    dom.statusCounts.textContent = clips.length
      ? `${clips.length} total · ${userFacing} applied · ${sceneSet.size} scene${sceneSet.size === 1 ? '' : 's'} · ${extras} extra${extras === 1 ? '' : 's'}${
          errors || warnings ? ` · ${errors ? `${errors} error${errors === 1 ? '' : 's'}` : ''}${errors && warnings ? ', ' : ''}${warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''}` : ''
        }`
      : 'No clips in this project';

    dom.browserCount.textContent = `${state.viewIds.length}${state.viewIds.length !== clips.length ? ` of ${clips.length}` : ''} clip${clips.length === 1 ? '' : 's'}`;
    const filtered = state.viewIds.length !== clips.length;
    dom.browserFoot.textContent = filtered
      ? `Showing ${state.viewIds.length} of ${clips.length} clips (filters or search active)`
      : clips.length
      ? 'Click a clip to preview · hover a thumbnail for a quick look'
      : 'Drag clips or folders here, or use Import.';
  }

  function updateWelcome() {
    // The welcome panel is *only* for a truly empty workspace: it used to stay
    // on top of the player once clips were imported, which hid every preview.
    const has = state.project.clips.length > 0;
    const hasCurrent = Boolean(state.currentClipId && clipById(state.currentClipId));
    dom.welcome.hidden = has || hasCurrent;
    dom.previewPlaceholder.hidden = hasCurrent || (!has && Boolean(state.currentClipId));
    if (dom.previewCount && !hasCurrent) dom.previewCount.textContent = has ? `${state.project.clips.length} clips` : 'No clip selected';
  }

  // ------------------------------------------------------------- keyboard --
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /**
   * True only while a dialog that *blocks* the app is open. The floating
   * pop-ups (Settings, Export, Rename… ) deliberately leave the workspace live,
   * so they must not swallow keyboard shortcuts.
   */
  function modalOpen() {
    const root = $('modalRoot');
    if (!root || root.hidden) return false;
    if (UI.blockingOpen) return UI.blockingOpen();
    return true;
  }

  /** True when the pointer/keyboard is inside a free-text field. */
  function typingContext() {
    const el = document.activeElement;
    const tag = el && el.tagName;
    const isField = tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable);
    if (!isField) return { typingAny: false, typingText: false, modalOpen: modalOpen() };
    const type = String(el.type || '').toLowerCase();
    const isNumber = type === 'number' || type === 'range';
    return { typingAny: true, typingText: !isNumber, modalOpen: modalOpen() };
  }

  /** Panel values typed but not yet applied — hover must not overwrite them. */
  function hasPendingEdits() {
    const p = state.pendingEdits;
    return Boolean(p.scene || p.shot || p.take || p.custom);
  }

  /** Which Scene/Shot/Take box currently has focus, if any. */
  function focusedField() {
    const el = document.activeElement;
    if (el === dom.sceneInput) return 'scene';
    if (el === dom.shotInput) return 'shot';
    if (el === dom.takeInput) return 'take';
    return null;
  }

  /**
   * The F key: continues numbering from the previous clip.
   * Inside a Scene/Shot/Take box it affects that field only; with nothing
   * focused it carries all three forward — which is what you want when you are
   * moving down a scene without touching the mouse.
   */
  function nextFromPreviousSmart() {
    const field = focusedField();
    if (field) {
      nextFromPrevious(field);
      return;
    }
    const clip = current();
    if (!clip) return;
    const prev = previousClipFor(clip);
    if (!prev) {
      setStatus('The first clip has no previous clip to continue from.', 'warn');
      return;
    }
    pushUndo('Next from previous (Scene + Shot + Take)');
    clearPendingEdits();
    ['scene', 'shot', 'take'].forEach((key) => {
      const prevOn = Boolean(prev[`${key}On`]);
      const prevValue = prev[key];
      const usable = prevOn && prevValue !== null && prevValue !== undefined && prevValue !== '';
      const value = usable ? Number(prevValue) + 1 : 1;
      clip[`${key}On`] = true;
      clip[key] = value;
    });
    markDirty();
    renderInfo();
    updateNextButtons();
    renderBrowser(true);
    renderFooter();
    scheduleValidation();
    setStatus(`Carried forward: S-${clip.scene} · SH-${clip.shot} · T-${clip.take}`);
  }

  /**
   * Switches one tagging box on/off — used by the checkboxes AND by the
   * Shift+A / Shift+S / Shift+D / Shift+E / Shift+W shortcuts.
   *
   * Two behaviours the user asked for:
   *   • switching a box ON with nothing in it fills it from the previous clip
   *     + 1 (settings.autoFillFromPrevious), so ticking is all you need to do
   *   • switching Custom Name ON clears Scene / Shot / Take
   *     (settings.customNameClearsTagging) — the custom name replaces them
   */
  function toggleField(field, options) {
    const opts = options || {};
    const clip = current();
    if (!clip) return;
    const key = field === 'extra' ? 'extraOn' : `${field}On`;
    const checkbox = dom[key];
    if (!checkbox) return;
    const next = opts.force === undefined ? !checkbox.checked : Boolean(opts.force);
    checkbox.checked = next;

    if (field === 'custom' && next && state.settings && state.settings.customNameClearsTagging !== false) {
      let cleared = 0;
      for (const f of ['scene', 'shot', 'take']) {
        if (dom[`${f}On`].checked) {
          dom[`${f}On`].checked = false;
          dom[`${f}On`].dispatchEvent(new Event('change')); // each one repaints the panel
          cleared += 1;
        }
      }
      // Those repaints refresh the form from the clip's metadata, which would
      // snap the Custom switch back off (it is not committed yet). Put it back
      // where the user just put it — before the order-sensitive commit below.
      checkbox.checked = true;
      if (cleared) {
        UI.toast(
          `Custom Name switched on — Scene / Shot / Take were cleared for this clip.`,
          { type: 'info', timeout: 2600 }
        );
      }
    }

    if (['scene', 'shot', 'take'].includes(field) && next) {
      const input = dom[`${field}Input`];
      const empty = input.value === '' || input.value === null;
      if (empty && state.settings && state.settings.autoFillFromPrevious !== false) {
        const prev = previousClipFor(clip);
        const usable = prev && prev[`${field}On`] && prev[field] !== null && prev[field] !== undefined && prev[field] !== '';
        input.value = String(usable ? Number(prev[field]) + 1 : 1);
      } else if (empty) {
        input.value = '1';
      }
    }

    checkbox.dispatchEvent(new Event('change'));
    if (opts.focus !== false && next && field !== 'extra' && field !== 'custom') {
      const input = dom[`${field}Input`];
      if (input && !input.disabled) input.focus();
    }
    if (field === 'custom' && next && opts.focus !== false) dom.customInput.focus();
  }

  /**
   * Applies the result of a rename run: the files on disk have new names, so
   * every clip that moved is re-pointed at its new path. The from → to pairs go
   * into the project's rename log, which is what UNDO RENAME replays.
   */
  function applyRenameChanges(changes, options) {
    const list = Array.isArray(changes) ? changes : [];
    if (!list.length) return 0;
    const opts = options || {};
    let touched = 0;
    for (const change of list) {
      const clip = clipById(change.id);
      const target = opts.undo ? change.from : change.to;
      const source = opts.undo ? change.to : change.from;
      if (!clip) continue;
      clip.sourcePath = target;
      clip.fileName = target.split(/[\\/]/).pop();
      clip.status = STATUS.APPLIED;
      touched += 1;
      void source;
    }
    if (!opts.undo) {
      const log = Array.isArray(state.project.renameLog) ? state.project.renameLog : [];
      for (const change of list) log.push({ id: change.id, from: change.from, to: change.to, at: new Date().toISOString() });
      state.project.renameLog = log.slice(-500);
    } else {
      const undone = new Set(list.map((c) => c.from || c.to));
      state.project.renameLog = (state.project.renameLog || []).filter((c) => !undone.has(c.to) && !undone.has(c.from));
    }
    state.thumbs.clear();
    state.thumbRequested.clear();
    markDirty();
    refreshAll();
    const clip = current();
    if (clip) loadClipIntoPreview(clip);
    return touched;
  }

  function focusPanelField(field) {
    const clip = current();
    if (!clip) return;
    if (field === 'custom') {
      if (!dom.customOn.checked) {
        dom.customOn.checked = true;
        dom.customOn.dispatchEvent(new Event('change'));
      }
      dom.customInput.focus();
      dom.customInput.select();
      return;
    }
    const on = dom[`${field}On`];
    const input = dom[`${field}Input`];
    if (!on.checked) {
      on.checked = true;
      on.dispatchEvent(new Event('change'));
    }
    input.focus();
    input.select();
  }

  /** Every keyboard action, addressed by id from lib/shortcuts.js. */
  const ACTIONS = {
    playPause: () => togglePlay(),
    mute: () => toggleMute(),
    replayClip: () => {
      if (video.src) {
        video.currentTime = 0;
        dom.curTime.textContent = FFLib.formatClock(0);
      }
    },
    prevClip: () => stepClip(-1),
    nextClip: () => stepClip(1),
    firstClip: () => state.viewIds.length && selectClip(state.viewIds[0]),
    lastClip: () => state.viewIds.length && selectClip(state.viewIds[state.viewIds.length - 1]),
    focusSearch: () => {
      dom.search.focus();
      dom.search.select();
    },
    clearFilters: () => {
      $('chipClear').click();
      dom.search.blur();
      setStatus('Search and filters cleared.');
    },
    applyNext: () => applyCurrent({ advance: true }),
    apply: () => applyCurrent({ advance: false }),
    playForward,
    playReverse,
    stopPlayback,
    toggleFullscreen,
    openRename: () => window.FFPanels.openRename(),
    toggleScene: () => toggleField('scene'),
    toggleShot: () => toggleField('shot'),
    toggleTake: () => toggleField('take'),
    toggleCustom: () => toggleField('custom'),
    nextFromPrevious: nextFromPreviousSmart,
    nextScene: () => nextFromPrevious('scene'),
    nextShot: () => nextFromPrevious('shot'),
    nextTake: () => nextFromPrevious('take'),
    toggleExtra: () => {
      if (!current()) return;
      dom.extraOn.checked = !dom.extraOn.checked;
      dom.extraOn.dispatchEvent(new Event('change'));
    },
    focusScene: () => focusPanelField('scene'),
    focusShot: () => focusPanelField('shot'),
    focusTake: () => focusPanelField('take'),
    focusCustom: () => focusPanelField('custom'),
    deleteClip: () => deleteClipFlow(state.currentClipId),
    undo,
    redo,
    saveProject: () => window.FFPanels.saveProject(false),
    saveProjectAs: () => window.FFPanels.saveProject(true),
    openProject: () => window.FFPanels.openProject(),
    newProject: () => window.FFPanels.newProject(),
    importClips: () => window.FFPanels.importClips(),
    importFolder: () => window.FFPanels.importFolder(),
    openExport: () => window.FFPanels.openExport(),
    relink: () => window.FFPanels.relinkFlow(),
    toggleFocusMode,
    cycleTheme,
    openSettings: () => window.FFPanels.openSettings(),
    openHelp: () => window.FFPanels.openHelp(),
    cancel: () => {
      if (shuttle.dir) stopPlayback();
      endScrub();
      const el = document.activeElement;
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
    },
  };

  function bindKeyboard() {
    document.addEventListener(
      'keydown',
      (event) => {
        // The Settings shortcut editor is listening for a raw keystroke.
        if (state.capturingKey) return;
        const ctx = typingContext();
        const match = FFKeys.resolve(event, state.bindings, ctx);
        if (!match) return;
        const handler = ACTIONS[match.id];
        if (!handler) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          handler();
        } catch (err) {
          // A shortcut must never take the app down.
          setStatus('That shortcut could not be completed.', 'error');
          console.error('[fusion-flix] shortcut failed:', match.id, err && err.message);
        }
      },
      true
    );
  }

  /** Reloads bindings (called at start-up and after the Settings editor). */
  function reloadBindings(overrides) {
    const source = overrides || (state.settings && state.settings.shortcuts) || {};
    const merged = FFKeys.mergeBindings(source);
    state.bindings = merged.bindings;
    return merged;
  }

  // --------------------------------------------------------------- events --
  function bindEvents() {
    // -- project name
    dom.projectName.addEventListener('change', () => {
      const value = dom.projectName.value.trim() || 'Untitled Project';
      if (value === state.project.name) return;
      state.project.name = value;
      markDirty();
      UI.toast(`Project renamed to "${value}".`, { type: 'info', timeout: 2200 });
    });

    // -- search / sort / filters
    dom.search.addEventListener('input', () => {
      state.search = dom.search.value;
      computeView();
      renderBrowser();
      renderFooter();
    });
    dom.searchClear.addEventListener('click', () => {
      dom.search.value = '';
      state.search = '';
      computeView();
      renderBrowser();
      renderFooter();
      dom.search.focus();
    });
    dom.sortKey.addEventListener('change', () => {
      state.order = dom.sortKey.value;
      computeView();
      renderBrowser();
      renderFooter();
      setStatus(`Sorted by ${dom.sortKey.options[dom.sortKey.selectedIndex].text}.`);
    });
    dom.sortDir.addEventListener('click', () => {
      state.orderDir = state.orderDir === 1 ? -1 : 1;
      dom.sortDir.textContent = state.orderDir === 1 ? '↓' : '↑';
      computeView();
      renderBrowser();
    });

    document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.filter;
        state.filters[key] = !state.filters[key];
        chip.classList.toggle('on', state.filters[key]);
        computeView();
        renderBrowser();
        renderFooter();
      });
    });
    $('chipClear').addEventListener('click', () => {
      Object.keys(state.filters).forEach((k) => {
        state.filters[k] = false;
      });
      document.querySelectorAll('.chip[data-filter]').forEach((c) => c.classList.remove('on'));
      dom.search.value = '';
      state.search = '';
      computeView();
      renderBrowser();
      renderFooter();
    });
    $('listEmptyClear').addEventListener('click', () => $('chipClear').click());

    // -- clip list interactions (delegated: rows are recycled by the virtualiser)
    dom.list.addEventListener('scroll', () => {
      renderBrowser(true);
      if (state.hoverClipId) stopHoverPreview();
    });
    dom.list.addEventListener('click', (event) => {
      const row = event.target.closest('.clip-row');
      if (!row || !row.dataset.clipId) return;
      if (event.target.closest('.row-delete')) {
        deleteClipFlow(row.dataset.clipId);
        return;
      }
      selectClip(row.dataset.clipId);
    });
    dom.list.addEventListener('dblclick', (event) => {
      const row = event.target.closest('.clip-row');
      if (row && row.dataset.clipId) {
        selectClip(row.dataset.clipId, { scroll: false });
        togglePlay();
      }
    });
    dom.list.addEventListener('mouseover', (event) => {
      const row = event.target.closest('.clip-row');
      if (!row || !row.dataset.clipId) return;
      if (row._hoverActive) return;
      row._hoverActive = true;
      if (state.hoverPreviewTimer) clearTimeout(state.hoverPreviewTimer);
      state.hoverTimerRow = row.dataset.clipId;
      state.hoverPreviewTimer = setTimeout(() => {
        const clip = clipById(row.dataset.clipId);
        if (!clip) return;
        state.hoverClipId = clip.id;
        // Bring it up in the main preview ("preview on hover"), unless
        // the user turned that off or is in the middle of typing metadata.
        const prefs = state.settings || {};
        const canPreroll =
          prefs.hoverPreroll !== false &&
          !modalOpen() &&
          !hasPendingEdits() &&
          !isTypingTarget(document.activeElement) &&
          state.currentClipId !== clip.id;
        if (canPreroll) selectClip(clip.id, { scroll: false, keepHover: true });
      }, 180);
    });
    // The pointer leaving the browser entirely must never leave a floating preview stranded.
    dom.list.addEventListener('mouseleave', () => stopHoverPreview());
    dom.list.addEventListener('mouseout', (event) => {
      const row = event.target.closest('.clip-row');
      if (!row) return;
      const to = event.relatedTarget;
      if (to && row.contains(to)) return;
      row._hoverActive = false;
      // A stray mouseout from a *different* row (fast pointer moves, recycled
      // rows, synthetic events) must not cancel the hover the pointer just opened.
      if (state.hoverTimerRow === row.dataset.clipId || state.hoverClipId === row.dataset.clipId) {
        state.hoverTimerRow = null;
        if (state.hoverPreviewTimer) clearTimeout(state.hoverPreviewTimer);
        stopHoverPreview();
      }
    });
    dom.list.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const index = state.viewIds.indexOf(state.currentClipId);
        const next = clamp((index < 0 ? 0 : index + delta), 0, state.viewIds.length - 1);
        if (state.viewIds[next]) selectClip(state.viewIds[next], { scroll: true });
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        applyCurrent({ advance: true });
      }
    });

    // -- preview transport
    dom.btnPlay.addEventListener('click', togglePlay);
    dom.btnMute.addEventListener('click', toggleMute);
    $('btnPrevClip').addEventListener('click', () => stepClip(-1));
    $('btnNextClip').addEventListener('click', () => stepClip(1));
    $('btnReveal').addEventListener('click', () => {
      const clip = current();
      if (!clip) return;
      FF.shell.showItem({ path: clip.sourcePath });
    });

    video.addEventListener('loadedmetadata', () => {
      // This clip decodes after all — drop any still-frame fallback state.
      const clip = current();
      if (clip && state.previewStillBy && state.previewStillBy.id === clip.id) {
        state.previewStillBy = null;
        clearStill();
        hidePreviewNotice();
      }
      renderTransport();
      if (clip && clip.meta && !clip.meta.duration) {
        clip.meta.duration = video.duration;
        clip.meta.durationText = FFLib.formatDuration(video.duration);
        renderBrowser(true);
      }
    });
    video.addEventListener('loadeddata', () => {
      if (!video.error) {
        clearStill();
        hidePreviewNotice();
      }
    });
    video.addEventListener('timeupdate', () => {
      const duration = video.duration || 0;
      dom.curTime.textContent = FFLib.formatClock(video.currentTime);
      if (duration && !scrub.active) {
        dom.timeline.value = String(Math.round((video.currentTime / duration) * 1000));
        updateTimelineFill();
      }
    });
    video.addEventListener('play', () => playPauseUI(true));
    video.addEventListener('pause', () => playPauseUI(false));
    video.addEventListener('ended', () => {
      playPauseUI(false);
      stopAllMotion();
    });
    video.addEventListener('error', () => {
      if (!video.src) return;
      // Errors belonging to a src we have already replaced are stale: right
      // after a rename the old file name 404s for a moment, and that must never
      // paint an error banner over the freshly loaded, perfectly fine preview.
      // (`load()` clears video.error, so a null here means "not this load".)
      if (!video.error) return;
      const code = video.error.code;
      const clip = current();
      dom.previewVideo.dataset.empty = '1';
      // 2 = the file could not be read at all (moved, renamed, unplugged drive)
      // 3 = the data is there but the decoder stumbled (often 10-bit / 4:2:2)
      // 4 = nothing in the file can be decoded by this player (HEVC, ProRes …)
      const reason = code === 2 ? 'read' : code === 3 ? 'decode' : 'codec';
      if (reason === 'read') {
        setStatus('This clip could not be read — its file may have been moved, renamed or be on a drive that is not connected.', 'error');
      } else if (reason === 'codec') {
        setStatus('This clip cannot be played by the built-in player because of its codec — preparing a playable preview…', 'warn');
      } else {
        setStatus('This clip could not be decoded — preparing a playable preview…', 'warn');
      }
      onPreviewFailure(clip, reason);
    });
    video.addEventListener('ratechange', () => {
      // J / L shuttle on purpose — leave their rate alone.
      if (!scrub.active && !shuttle.dir && video.playbackRate !== 1) video.playbackRate = 1;
    });

    bindShuttleHint();
    bindSplitters();

    dom.timeline.addEventListener('input', () => {
      updateTimelineFill();
      const duration = video.duration || 0;
      if (duration) {
        video.currentTime = (Number(dom.timeline.value) / 1000) * duration;
        dom.curTime.textContent = FFLib.formatClock(video.currentTime);
      }
    });

    // -- hover scrubbing zones (Settings → Preview, OFF by default)
    const onPointerMove = (event) => {
      if (!shuttleEnabled() || state.missing.has(state.currentClipId)) {
        if (scrub.active) endScrub();
        return;
      }
      const rect = dom.stage.getBoundingClientRect();
      const insideStage = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!insideStage) {
        if (scrub.active) endScrub();
        dom.stage.classList.remove('zone-hint');
        return;
      }
      const center = rect.left + rect.width / 2;
      const edge = rect.width * 0.24;
      if (event.clientX < center - edge || event.clientX > center + edge) {
        dom.stage.classList.add('zone-hint');
        updateScrubFromPointer(event.clientX, event.clientY);
      } else {
        dom.stage.classList.remove('zone-hint');
        updateScrubFromPointer(event.clientX, event.clientY);
      }
    };
    window.addEventListener('mousemove', onPointerMove, { passive: true });
    dom.stage.addEventListener('mouseleave', () => {
      endScrub();
      dom.stage.classList.remove('zone-hint');
    });
    window.addEventListener('blur', endScrub);
    dom.previewMissing.addEventListener('click', () => window.FFPanels.relinkClip(state.currentClipId));

    // -- clip information fields
    const onFieldChange = (field) => {
      const clip = current();
      if (!clip) {
        renderInfo();
        return;
      }
      pushUndo(`${field} change`);
      if (field === 'custom' && dom.customInput.value.trim()) {
        // Typing a name implies you want to use it. Clearing the box must NOT
        // switch the feature off behind your back — validation says so instead.
        dom.customOn.checked = true;
      }
      commitFieldsToClip(clip);
      clip.status = STATUS.APPLIED;
      markDirty();
      updateFieldAvailability();
      updateFinalName();
      renderBrowser(true);
      renderFooter();
      scheduleValidation();
    };

    // Mouse clicks on the tagging switches go through the same code path as the
    // shortcuts (Shift+A / S / D / E / W), so both behave identically.
    for (const [el, field] of [[dom.sceneOn, 'scene'], [dom.shotOn, 'shot'], [dom.takeOn, 'take'], [dom.extraOn, 'extra'], [dom.customOn, 'custom']]) {
      el.addEventListener('click', (event) => {
        event.preventDefault();
        toggleField(field, { focus: true });
      });
    }

    dom.sceneOn.addEventListener('change', () => {
      if (dom.sceneOn.checked && (dom.sceneInput.value === '' || dom.sceneInput.value === null)) dom.sceneInput.value = '1';
      onFieldChange('scene');
      if (dom.sceneOn.checked) dom.sceneInput.focus();
    });
    dom.shotOn.addEventListener('change', () => {
      if (dom.shotOn.checked && (dom.shotInput.value === '' || dom.shotInput.value === null)) dom.shotInput.value = '1';
      onFieldChange('shot');
      if (dom.shotOn.checked) dom.shotInput.focus();
    });
    dom.takeOn.addEventListener('change', () => {
      if (dom.takeOn.checked && (dom.takeInput.value === '' || dom.takeInput.value === null)) dom.takeInput.value = '1';
      onFieldChange('take');
      if (dom.takeOn.checked) dom.takeInput.focus();
    });
    dom.customOn.addEventListener('change', () => {
      onFieldChange('custom');
      if (dom.customOn.checked && !dom.customInput.value.trim()) {
        dom.customInput.focus();
        setStatus('Custom name: type the name you want for this clip.', 'info');
      }
    });
    dom.extraOn.addEventListener('change', () => onFieldChange('extra'));

    for (const field of ['scene', 'shot', 'take']) {
      const input = dom[`${field}Input`];
      input.addEventListener('input', () => {
        // live filename preview only (no metadata commit until Apply)
        state.pendingEdits[field] = true;
        const clip = current();
        if (!clip) return;
        updateFinalName();
      });
      input.addEventListener('change', () => onFieldChange(field));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const delta = event.key === 'ArrowUp' ? 1 : -1;
          const value = clamp((FFLib.toIntOrNull(input.value) || 0) + delta, 0, 99999);
          input.value = String(value);
          updateFinalName();
          const clip = current();
          if (clip) {
            commitFieldsToClip(clip);
            markDirty();
            renderBrowser(true);
            scheduleValidation();
          }
        }
      });
      dom[`${field}Next`].addEventListener('click', () => nextFromPrevious(field));
    }

    dom.customInput.addEventListener('input', () => {
      state.pendingEdits.custom = true;
      if (dom.customInput.value.trim()) dom.customOn.checked = true;
      updateFieldAvailability();
      updateFinalName();
    });
    dom.customInput.addEventListener('change', () => onFieldChange('custom'));

    $('copyName').addEventListener('click', async () => {
      const text = dom.finalName.textContent;
      if (!text || text === '—') return;
      try {
        await navigator.clipboard.writeText(text);
        UI.toast('Filename copied to the clipboard.', { type: 'success', timeout: 1800 });
      } catch (_) {
        setStatus('Could not copy to the clipboard.', 'warn');
      }
    });

    // -- apply / delete
    $('btnApply').addEventListener('click', () => applyCurrent({ advance: false }));
    $('btnApplyNext').addEventListener('click', () => applyCurrent({ advance: true }));
    $('btnDelete').addEventListener('click', () => deleteClipFlow(state.currentClipId));

    // -- toolbar
    $('btnImportClips').addEventListener('click', () => window.FFPanels.importClips());
    $('btnImportFolder').addEventListener('click', () => window.FFPanels.importFolder());
    $('btnRename').addEventListener('click', () => window.FFPanels.openRename());
    $('btnExport').addEventListener('click', () => window.FFPanels.openExport());
    $('btnSave').addEventListener('click', () => window.FFPanels.saveProject(false));
    $('btnOpen').addEventListener('click', () => window.FFPanels.openProject());
    $('btnNew').addEventListener('click', () => window.FFPanels.newProject());
    $('btnSettings').addEventListener('click', () => window.FFPanels.openSettings());
    $('btnHelp').addEventListener('click', () => window.FFPanels.openHelp());
    $('btnSample').addEventListener('click', () => window.FFPanels.loadSample());
    const focusBtn = $('btnFocus');
    if (focusBtn) focusBtn.addEventListener('click', toggleFocusMode);
    const themeBtn = $('btnTheme');
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);
    $('welcomeImport').addEventListener('click', () => window.FFPanels.importClips());
    $('welcomeOpen').addEventListener('click', () => window.FFPanels.openProject());
    $('welcomeSample').addEventListener('click', () => window.FFPanels.loadSample());
    const engineCardBtn = $('welcomeEngineInstall');
    if (engineCardBtn) {
      engineCardBtn.addEventListener('click', () => {
        if (window.FFPanels.installEngine) window.FFPanels.installEngine();
      });
    }

    // -- volume
    dom.volume.addEventListener('input', () => {
      video.volume = Number(dom.volume.value);
      if (video.volume > 0 && video.muted) toggleMute();
    });

    // -- drag & drop import
    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer) return;
      const hasFiles = Array.from(event.dataTransfer.types || []).includes('Files');
      if (!hasFiles) return;
      event.preventDefault();
      dragDepth += 1;
      dom.dragOverlay.hidden = false;
    });
    window.addEventListener('dragover', (event) => {
      if (!event.dataTransfer) return;
      const hasFiles = Array.from(event.dataTransfer.types || []).includes('Files');
      if (hasFiles) event.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dom.dragOverlay.hidden = true;
    });
    window.addEventListener('drop', (event) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      dragDepth = 0;
      dom.dragOverlay.hidden = true;
      const paths = [];
      for (const file of Array.from(event.dataTransfer.files || [])) {
        const p = FF.pathForFile(file);
        if (p) paths.push(p);
      }
      if (!paths.length) {
        UI.toast('Those items could not be read. Try Import Clips or Import Folder instead.', { type: 'warning' });
        return;
      }
      window.FFPanels.importPaths(paths, { source: 'drop' });
    });

    // -- window/host events
    FF.on(FF.channels.AUTOSAVE_TICK, () => {
      if (state.dirty) autosaveNow();
    });
    FF.on(FF.channels.BEFORE_CLOSE, () => window.FFPanels.handleBeforeClose());
    FF.on(FF.channels.MENU_ACTION, (action) => {
      const map = {
        'new-project': () => window.FFPanels.newProject(),
        'open-project': () => window.FFPanels.openProject(),
        'save-project': () => window.FFPanels.saveProject(false),
        'save-project-as': () => window.FFPanels.saveProject(true),
        'import-clips': () => window.FFPanels.importClips(),
        'import-folder': () => window.FFPanels.importFolder(),
        'load-sample': () => window.FFPanels.loadSample(),
        'open-rename': () => window.FFPanels.openRename(),
        'open-export': () => window.FFPanels.openExport(),
        settings: () => window.FFPanels.openSettings(),
        shortcuts: () => window.FFPanels.openHelp(),
        about: () => window.FFPanels.openAbout(),
        'check-engines': () => window.FFPanels.checkEngines(),
        relink: () => window.FFPanels.relinkFlow(),
        undo,
        redo,
        apply: () => applyCurrent({ advance: false }),
        'apply-next': () => applyCurrent({ advance: true }),
      };
      if (map[action]) map[action]();
    });

    window.addEventListener('beforeunload', () => {
      if (state.dirty) {
        FF.autosave.write({ project: serializeProject(), filePath: state.projectPath, clean: false });
      }
    });
  }

  function serializeProject() {
    return {
      name: state.project.name,
      settings: Object.assign({}, state.project.settings || {}),
      exportSettings: Object.assign({}, state.project.exportSettings || {}),
      clips: state.project.clips,
    };
  }

  function autosaveNow() {
    if (!state.settings || !state.settings.autosaveEnabled) return;
    FF.autosave
      .write({ project: serializeProject(), filePath: state.projectPath, clean: false })
      .then(() => setStatus('Autosaved project metadata.'))
      .catch(() => {});
  }

  // ------------------------------------------------------------- clipboard --
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------------ init --
  async function init() {
    UI.drawBrandIcon(dom.brandCanvas);
    UI.drawBrandIcon(dom.welcomeIcon);
    UI.applyIcons();
    playPauseUI(false);

    state.info = await FF.appInfo();
    state.settings = await FF.settings.get();
    applyTheme(state.settings.theme, state.settings.accentColor);
    reloadBindings();
    paintShuttleHint();
    setFocusMode(Boolean(state.settings.focusMode), { persist: false, scroll: false });
    state.orderDir = 1;

    state.project = emptyProject('Untitled Project');
    dom.projectName.value = state.project.name;
    renderInfo();
    renderFooter();
    updateWelcome();
    FF.setTitle({ name: '', dirty: false });

    bindEvents();
    bindKeyboard();

    // Startup checks (never block the UI).
    if (window.FFPanels && window.FFPanels.checkRecovery) window.FFPanels.checkRecovery();
    FF.settings
      .checkEngines()
      .then((engines) => {
        state.engineReady = Boolean(engines && engines.ffmpeg && engines.ffmpeg.ok);
        if (!engines.ffmpeg.ok || !engines.ffprobe.ok) {
          const missing = [engines.ffmpeg.ok ? null : 'FFmpeg', engines.ffprobe.ok ? null : 'FFprobe'].filter(Boolean).join(' and ');
          setStatus(`${missing} not found — clips still import, rename and export.`, 'warn');
          // Camera footage (HEVC/H.265, ProRes, 10-bit) cannot be previewed
          // without the engine, so offer it on the first screen instead of
          // leaving the user with an empty player and no explanation.
          if (!engines.ffmpeg.ok) showEngineCard();
          UI.toast(`${missing} could not be found, so clip previews of camera codecs, durations, frame rates and reference timecodes are limited. Everything else works. You can install it in one click from the welcome panel or Settings → Media engine.`, {
            type: 'warning',
            title: 'Media engine not found',
            timeout: 14000,
          });
        }
      })
      .catch(() => {});

    window.FFApp.ready = true;
    document.dispatchEvent(new CustomEvent('ff-ready'));
  }

  /** Surfaces the one-click engine install on the welcome screen. */
  function showEngineCard() {
    const card = $('welcomeEngine');
    if (card) card.hidden = false;
  }

  function hideEngineCard() {
    const card = $('welcomeEngine');
    if (card) card.hidden = true;
  }

  const THEMES = ['cinema', 'midnight', 'daylight'];

  function hexToRgb(hex) {
    const clean = String(hex || '').replace('#', '').trim();
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }

  function rgbToHex(rgb) {
    return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  }

  /** Mixes towards white (amount > 0) or black (amount < 0). */
  function shade(rgb, amount) {
    const target = amount >= 0 ? 255 : 0;
    const k = Math.abs(amount);
    return rgb.map((v) => v + (target - v) * k);
  }

  function relativeLuminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Applies a theme and an accent colour.
   * The accent drives the translucent variants, the hover tint and the text
   * colour used on top of accent-filled buttons, so any colour stays readable.
   */
  function applyTheme(theme, accentColor) {
    const name = THEMES.includes(theme) ? theme : 'cinema';
    const root = document.documentElement;
    root.dataset.theme = name;

    const rgb = hexToRgb(accentColor || '') || hexToRgb('#f0562f');
    const hex = rgbToHex(rgb);
    // Dark themes want a lighter hover tone; the light theme a deeper one.
    const lift = name === 'daylight' ? -0.12 : 0.18;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-2', rgbToHex(shade(rgb, lift)));
    root.style.setProperty('--accent-rgb', rgb.join(', '));
    root.style.setProperty('--accent-ink', relativeLuminance(rgb) > 0.6 ? '#14171a' : '#ffffff');
    return { theme: name, accent: hex };
  }

  function currentTheme() {
    return document.documentElement.dataset.theme || 'cinema';
  }

  function cycleTheme() {
    const order = ['cinema', 'daylight', 'midnight'];
    const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
    applyTheme(next, state.settings ? state.settings.accentColor : '');
    if (state.settings) state.settings.theme = next;
    FF.settings.set({ theme: next });
    setStatus(`Theme: ${next === 'daylight' ? 'Daylight (white)' : next === 'midnight' ? 'Midnight' : 'Cinema'}`);
    UI.toast(`Theme switched to ${next}.`, { type: 'info', timeout: 1800 });
  }

  function setFocusMode(on, options) {
    const opts = options || {};
    state.focusMode = Boolean(on);
    document.querySelector('.app').classList.toggle('focus-mode', state.focusMode);
    document.querySelector('.workspace').classList.toggle('focus-mode', state.focusMode);
    if (opts.scroll !== false) {
      // row heights change with the viewport, so re-measure
      requestAnimationFrame(() => renderBrowser(true));
    }
    if (opts.persist !== false && state.settings) {
      state.settings.focusMode = state.focusMode;
      FF.settings.set({ focusMode: state.focusMode });
    }
    setStatus(state.focusMode ? 'Focus view — side panels hidden (P to bring them back).' : 'Standard view.');
  }

  function toggleFocusMode() {
    setFocusMode(!state.focusMode);
  }

  // ------------------------------------------------------------- public API --
  window.FFApp = {
    onProxyProgress,
    invalidateEngine,
    showEngineCard,
    hideEngineCard,
    ready: false,
    state,
    dom,
    applyTheme,
    cycleTheme,
    THEMES,
    setFocusMode,
    toggleFocusMode,
    toggleField,
    applyRenameChanges,
    playForward,
    playReverse,
    stopPlayback,
    playbackInfo,
    shuttleLabel,
    paintShuttleHint,
    bindSplitters,
    applyLayout,
    replayLayout: () => applyLayout(storedLayout()),
    reloadBindings,
    hexToRgb,
    rgbToHex,
    setProject,
    emptyProject,
    serializeProject,
    markDirty,
    markClean,
    refreshAll,
    computeView,
    renderBrowser,
    renderInfo,
    renderFooter,
    updateProjectMeta,
    updateWelcome,
    selectClip,
    stepClip,
    current,
    clipById,
    clipIndex,
    applyCurrent,
    deleteClipFlow,
    loadClipIntoPreview,
    checkMissingMedia,
    setStatus,
    toast: (m, o) => UI.toast(m, o),
    ui: UI,
    copyText,
    autosaveNow,
    updateNextButtons,
    stopHoverPreview,
    lib: FFLib,
    validate: FFValidate,
    sanitize: FFSanitize,
  };

  init().catch((err) => {
    setStatus('The application could not start correctly.', 'error');
    console.error('[fusion-flix] init failed:', err);
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,7,9,.9);z-index:5000;color:#eee;font:13px system-ui;text-align:center;padding:40px">
        <div><h2 style="letter-spacing:.1em">FUSION FLIX</h2><p>The application hit a problem while starting.</p>
        <p style="color:#a4abb5">${escapeHtml(err && err.message ? err.message : 'Unknown error')}</p>
        <p style="color:#6f7681">Your project metadata is safe. Close and reopen the app to try again.</p></div>
      </div>`
    );
  });
})();
