'use strict';
/**
 * FUSION FLIX — small UI kit: toasts and accessible modals.
 * Exposed as window.FFUI (no Node access here, by design).
 */
(function () {
  const toastRoot = document.getElementById('toastRoot');
  const modalRoot = document.getElementById('modalRoot');

  const openModals = [];
  let lastFocused = null;

  // ---------------------------------------------------------------- toasts --
  function toast(message, options) {
    const opts = Object.assign({ type: 'info', title: '', timeout: 4200 }, options || {});
    const el = document.createElement('div');
    el.className = `toast ${opts.type}`;
    el.setAttribute('role', opts.type === 'error' ? 'alert' : 'status');

    const text = document.createElement('div');
    if (opts.title) {
      const t = document.createElement('div');
      t.className = 'toast-title';
      t.textContent = opts.title;
      text.appendChild(t);
    }
    const b = document.createElement('div');
    b.className = 'toast-body';
    b.textContent = message || '';
    text.appendChild(b);
    el.appendChild(text);
    toastRoot.appendChild(el);

    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    if (opts.timeout > 0) setTimeout(remove, opts.timeout);
    el.addEventListener('click', remove);
    return { close: remove, el };
  }

  // ---------------------------------------------------------------- modals --
  //
  // Two flavours:
  //   * scrim  — dimmed, centred dialog for "are you sure?" decisions.
  //   * window — a real floating pop-up: draggable by its title bar, resizable
  //     from the bottom-right grip, remembers where you left it, always stays
  //     inside the app window. The rest of the app stays usable behind it.
  let zCounter = 900;

  // Where the user last parked each pop-up (survives restarts).
  const winStore = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('ff.windowRects') || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (_) {
      return {};
    }
  })();
  function rememberRect(key, rect) {
    if (!key) return;
    winStore[key] = { width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) };
    try {
      localStorage.setItem('ff.windowRects', JSON.stringify(winStore));
    } catch (_) {}
  }

  function viewportSize() {
    return { w: Math.max(320, window.innerWidth), h: Math.max(240, window.innerHeight) };
  }

  /**
   * Keeps a floating window fully inside the app window. A height of 0 means
   * "size to content" — the window then only carries a max-height.
   */
  function clampRect(rect) {
    const vp = viewportSize();
    const width = Math.min(Math.max(300, rect.width), vp.w - 16);
    const wantedHeight = Number(rect.height) || 0;
    const height = wantedHeight ? Math.min(Math.max(160, wantedHeight), vp.h - 16) : 0;
    const x = Math.max(8, Math.min(rect.x, vp.w - width - 8));
    const y = Math.max(8, Math.min(rect.y, vp.h - height - 8));
    return { x, y, width, height };
  }

  const floatingWindows = new Set();
  window.addEventListener('resize', () => {
    floatingWindows.forEach((entry) => {
      entry.place({
        x: parseFloat(entry.el.style.left) || 0,
        y: parseFloat(entry.el.style.top) || 0,
        width: entry.el.offsetWidth,
        height: entry.el.offsetHeight,
      });
    });
    openModals.forEach((m) => {
      if (!m.floating) m.el.style.maxHeight = `${Math.max(200, viewportSize().h - 48)}px`;
    });
  });

  /**
   * Creates a dialog.
   * @param {object} config
   *   title, subtitle, size ('small'|''|'wide'|'xwide'), body (Node|string),
   *   buttons [{label, className, value, onClick, autofocus, keepOpen, disabled}],
   *   onOpen(handle), onClose(value), closable (bool),
   *   window (bool)  — floating pop-up instead of a centred dialog,
   *   winKey (string)— remembers size/position for this pop-up,
   *   blocking (bool)— when false (default for floating) the rest of the UI stays live,
   *   closeOnBackdrop (bool)
   */
  function modal(config) {
    const cfg = Object.assign({ closable: true, closeOnBackdrop: false, size: '' }, config || {});
    const isWindow = cfg.window !== false ? cfg.window === true : false;
    lastFocused = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = isWindow ? 'overlay-layer floating' : 'overlay-layer scrim';
    const modalEl = document.createElement('div');
    modalEl.className = `modal ${isWindow ? 'modal-window' : ''} ${cfg.size ? `size-${cfg.size}` : ''}`.trim();
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', isWindow ? 'false' : 'true');
    if (isWindow) modalEl.dataset.floating = '1';
    if (cfg.title) modalEl.setAttribute('aria-label', cfg.title);
    modalEl.style.zIndex = String(++zCounter);

    const head = document.createElement('div');
    head.className = 'modal-head';
    const titleWrap = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = cfg.title || '';
    titleWrap.appendChild(h);
    if (cfg.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'modal-sub';
      sub.textContent = cfg.subtitle;
      titleWrap.appendChild(sub);
    }
    head.appendChild(titleWrap);

    const headActions = document.createElement('div');
    headActions.className = 'modal-head-actions';
    if (isWindow) {
      const minBtn = document.createElement('button');
      // Deliberately NOT `.modal-close`: that class means "this closes the
      // dialog" to the app and to the automated tests.
      minBtn.className = 'modal-min';
      minBtn.type = 'button';
      minBtn.title = 'Collapse / expand this window';
      minBtn.setAttribute('aria-label', 'Collapse');
      minBtn.textContent = '–';
      minBtn.addEventListener('click', () => modalEl.classList.toggle('is-collapsed'));
      headActions.appendChild(minBtn);
    }
    if (cfg.closable) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'modal-close';
      closeBtn.type = 'button';
      closeBtn.textContent = '✕';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.addEventListener('click', () => handle.close(null));
      headActions.appendChild(closeBtn);
    }
    head.appendChild(headActions);
    modalEl.appendChild(head);

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (cfg.body instanceof Node) body.appendChild(cfg.body);
    else if (typeof cfg.body === 'string') body.innerHTML = cfg.body;
    modalEl.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    modalEl.appendChild(foot);

    if (isWindow) {
      const grip = document.createElement('div');
      grip.className = 'modal-grip';
      grip.setAttribute('aria-hidden', 'true');
      modalEl.appendChild(grip);
    }

    const handle = {
      el: modalEl,
      head,
      body,
      foot,
      backdrop,
      floating: isWindow,
      get closed() {
        return !modalEl.isConnected;
      },
      setBody(node) {
        body.innerHTML = '';
        if (node instanceof Node) body.appendChild(node);
        else if (typeof node === 'string') body.innerHTML = node;
      },
      setSubtitle(text) {
        let sub = head.querySelector('.modal-sub');
        if (!sub) {
          sub = document.createElement('div');
          sub.className = 'modal-sub';
          head.firstChild.appendChild(sub);
        }
        sub.textContent = text || '';
      },
      setButtons(buttons) {
        foot.innerHTML = '';
        (buttons || []).forEach((b, i) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `btn ${b.className || ''}`.trim();
          btn.textContent = b.label;
          if (b.title) btn.title = b.title;
          if (b.disabled) btn.disabled = true;
          if (b.id) btn.id = b.id;
          btn.addEventListener('click', async () => {
            if (b.onClick) {
              const result = await b.onClick(handle);
              if (result === false || b.keepOpen) return;
            }
            if (b.close !== false) handle.close(b.value === undefined ? b.label : b.value);
          });
          if (b.autofocus || (i === 0 && !b.noAutofocus)) setTimeout(() => btn.focus(), 0);
          foot.appendChild(btn);
        });
      },
      bringToFront() {
        modalEl.style.zIndex = String(++zCounter);
      },
      place(rect) {
        const r = clampRect(rect);
        modalEl.style.left = `${r.x}px`;
        modalEl.style.top = `${r.y}px`;
        modalEl.style.width = `${r.width}px`;
        modalEl.style.height = r.height ? `${r.height}px` : '';
        modalEl.style.maxHeight = `${Math.max(200, viewportSize().h - 16)}px`;
      },
      close(value) {
        if (!modalEl.isConnected) return;
        const index = openModals.indexOf(handle);
        if (index >= 0) openModals.splice(index, 1);
        backdrop.remove();
        floatingWindows.delete(entry);
        syncLayerState();
        if (lastFocused && lastFocused.isConnected && typeof lastFocused.focus === 'function') {
          try {
            lastFocused.focus();
          } catch (_) {}
        }
        if (cfg.onClose) cfg.onClose(value);
      },
    };

    // buttons + spacers
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    let spacerUsed = false;
    const buttons = cfg.buttons || [{ label: 'Close', className: 'secondary' }];
    const normalised = buttons.map((b, i) => {
      const item = Object.assign({}, b);
      if ((item.align === 'left' || item.spacerBefore) && !spacerUsed) {
        foot.appendChild(spacer);
        spacerUsed = true;
      }
      return Object.assign({}, item, { autofocus: item.autofocus === undefined ? i === buttons.length - 1 : item.autofocus });
    });
    // Buttons are created synchronously so the footer is never briefly empty;
    // only the focus move is deferred until the dialog is in the DOM.
    handle.setButtons(normalised);

    backdrop.appendChild(modalEl);
    modalRoot.appendChild(backdrop);

    // ---- floating-window geometry, dragging and resizing -------------------
    const entry = { el: modalEl, place: handle.place };
    if (isWindow) {
      floatingWindows.add(entry);
      const remembered = cfg.winKey ? winStore[cfg.winKey] : null;
      const vp = viewportSize();
      const defaultWidth = Math.min(cfg.defaultWidth || 620, Math.max(300, vp.w - 40));
      const rect = clampRect(
        remembered && remembered.width
          ? remembered
          : {
              // Cascade a little so stacked pop-ups never hide each other.
              x: Math.round((vp.w - defaultWidth) / 2) + floatingWindows.size * 14,
              y: Math.round(vp.h * 0.14) + floatingWindows.size * 14,
              width: defaultWidth,
              height: 0,
            }
      );
      handle.place(rect);
      if (remembered && remembered.height) modalEl.style.maxHeight = `${rect.height}px`;
      // A long panel (Settings, Help) should feel like a window, not a wall:
      // cap the auto height and let the body scroll inside.
      setTimeout(() => {
        if (!modalEl.isConnected) return;
        const vp = viewportSize();
        const capHeight = Math.round(vp.h * 0.78);
        const wanted = rect.height || modalEl.offsetHeight;
        if (wanted > capHeight) handle.place({ x: rect.x, y: rect.y, width: rect.width, height: capHeight });
      }, 0);

      const state = { dragging: false, resizing: false, startX: 0, startY: 0, startRect: null };

      const onDown = (event, mode) => {
        if (event.button !== 0) return;
        if (mode === 'drag' && event.target.closest('button, input, select, textarea, .modal-close, .modal-head-actions')) return;
        state.mode = mode;
        state.startX = event.screenX;
        state.startY = event.screenY;
        state.startRect = {
          x: parseFloat(modalEl.style.left) || 0,
          y: parseFloat(modalEl.style.top) || 0,
          width: modalEl.offsetWidth,
          height: modalEl.offsetHeight,
        };
        if (mode === 'resize') {
          modalEl.style.height = `${state.startRect.height}px`;
          modalEl.style.maxHeight = `${Math.max(200, viewportSize().h - 16)}px`;
        }
        handle.bringToFront();
        document.body.classList.add(mode === 'resize' ? 'is-resizing-window' : 'is-dragging-window');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        event.preventDefault();
      };

      const onMove = (event) => {
        if (!state.startRect) return;
        const dx = event.screenX - state.startX;
        const dy = event.screenY - state.startY;
        if (state.mode === 'drag') {
          handle.place({
            x: state.startRect.x + dx,
            y: state.startRect.y + dy,
            width: state.startRect.width,
            height: state.startRect.height,
          });
        } else {
          handle.place({
            x: state.startRect.x,
            y: state.startRect.y,
            width: Math.max(300, state.startRect.width + dx),
            height: Math.max(180, state.startRect.height + dy),
          });
        }
      };

      const onUp = () => {
        state.startRect = null;
        document.body.classList.remove('is-dragging-window', 'is-resizing-window');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (cfg.winKey) {
          rememberRect(cfg.winKey, {
            x: parseFloat(modalEl.style.left) || 0,
            y: parseFloat(modalEl.style.top) || 0,
            width: modalEl.offsetWidth,
            // Collapsed windows must not remember a shrunken height.
            height: modalEl.classList.contains('is-collapsed') ? 0 : modalEl.offsetHeight,
          });
        }
      };

      head.addEventListener('mousedown', (e) => onDown(e, 'drag'));
      head.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        modalEl.classList.toggle('is-collapsed');
      });
      const grip = modalEl.querySelector('.modal-grip');
      if (grip) grip.addEventListener('mousedown', (e) => onDown(e, 'resize'));
      modalEl.addEventListener('mousedown', () => handle.bringToFront(), true);
    } else {
      if (cfg.closeOnBackdrop) {
        backdrop.addEventListener('mousedown', (e) => {
          if (e.target === backdrop) handle.close(null);
        });
      }
      // Centred dialogs sit in the middle of the app window, always.
      const centre = () => {
        if (!modalEl.isConnected) return;
        const vp = viewportSize();
        modalEl.style.maxHeight = `${Math.max(200, vp.h - 48)}px`;
      };
      centre();
    }

    openModals.push(handle);
    syncLayerState();

    // Keyboard: Escape closes (when allowed), Tab stays inside scrim dialogs.
    modalEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cfg.closable) {
        e.stopPropagation();
        e.preventDefault();
        handle.close(null);
      }
      if (e.key === 'Tab' && !isWindow) {
        const focusables = modalEl.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      }
    });

    if (cfg.onOpen) setTimeout(() => cfg.onOpen(handle), 0);
    return handle;
  }

  /** True while a dialog that blocks the app (a scrim dialog) is open. */
  function blockingOpen() {
    return openModals.some((m) => !m.floating);
  }

  /** Shows/hides the dark scrim depending on what is on screen. */
  function syncLayerState() {
    const any = openModals.length > 0;
    const scrim = openModals.some((m) => !m.floating);
    modalRoot.hidden = !any;
    modalRoot.classList.toggle('has-scrim', scrim);
    const scrimEl = modalRoot.querySelector('.overlay-layer.scrim');
    modalRoot.style.pointerEvents = any ? 'auto' : 'none';
    if (scrimEl) scrimEl.style.pointerEvents = '';
  }


  /** Promise-based confirmation dialog. */
  function confirm(config) {
    const cfg = Object.assign({}, config || {});
    return new Promise((resolve) => {
      modal({
        title: cfg.title || 'Are you sure?',
        size: cfg.size || 'small',
        closable: true,
        body: (() => {
          const wrap = document.createElement('div');
          wrap.className = 'modal-section';
          const p = document.createElement('div');
          p.textContent = cfg.message || '';
          p.style.fontSize = '13.5px';
          wrap.appendChild(p);
          if (cfg.detail) {
            const d = document.createElement('div');
            d.className = 'modal-note';
            d.textContent = cfg.detail;
            wrap.appendChild(d);
          }
          return wrap;
        })(),
        buttons: [
          { label: cfg.cancelLabel || 'CANCEL', className: 'secondary', value: false },
          { label: cfg.confirmLabel || 'CONFIRM', className: cfg.danger ? 'danger' : 'primary', value: true, autofocus: true },
        ],
        onClose: (value) => resolve(value === true),
      });
    });
  }

  /** Non-blocking busy dialog with progress support. */
  function busy(config) {
    const cfg = Object.assign({ title: 'Working…', message: '', cancellable: false, cancelLabel: 'Cancel' }, config || {});
    const wrap = document.createElement('div');
    wrap.className = 'modal-section';

    const msg = document.createElement('div');
    msg.className = 'progress-now';
    msg.textContent = cfg.message || '';
    wrap.appendChild(msg);

    const outer = document.createElement('div');
    outer.className = 'progress-outer';
    const inner = document.createElement('div');
    inner.className = 'progress-inner';
    outer.appendChild(inner);
    wrap.appendChild(outer);

    const meta = document.createElement('div');
    meta.className = 'progress-meta';
    const left = document.createElement('span');
    const right = document.createElement('span');
    meta.append(left, right);
    wrap.appendChild(meta);

    const handle = modal({
      title: cfg.title,
      size: 'small',
      window: true,
      winKey: cfg.winKey || 'progress',
      defaultWidth: 460,
      closable: Boolean(cfg.cancellable),
      body: wrap,
      buttons: cfg.cancellable
        ? [
            {
              label: 'HIDE',
              className: 'subtle',
              keepOpen: false,
              onClick: (h) => {
                h.close(null);
                if (cfg.onHide) cfg.onHide();
              },
            },
            {
              label: cfg.cancelLabel,
              className: 'danger',
              autofocus: true,
              onClick: () => {
                if (cfg.onCancel) cfg.onCancel();
                return false;
              },
            },
          ]
        : [],
      onClose: null,
    });

    return {
      el: handle.el,
      setMessage(text) {
        msg.textContent = text || '';
      },
      setProgress(percent, metaText) {
        const pct = Math.max(0, Math.min(100, Number(percent) || 0));
        inner.style.width = `${pct}%`;
        left.textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
        right.textContent = metaText || '';
      },
      close() {
        handle.close(null);
      },
    };
  }

  // Load the app mark onto any <canvas data-icon> elements (drawn procedurally
  // so the icon is crisp at every size with no external image needed).
  function drawBrandIcon(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const s = size / 1024; // same 1024-space the icon generator uses

    const brand = ctx.createLinearGradient(size * 0.1, 0, size * 0.9, size);
    brand.addColorStop(0, '#f25630');
    brand.addColorStop(1, '#cf2b1b');

    function roundRect(x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    ctx.clearRect(0, 0, size, size);
    // tile
    roundRect(0, 0, size, size, 238 * s);
    ctx.fillStyle = brand;
    ctx.fill();

    // minimal FF monogram — three bars per letter, flat and geometric
    ctx.fillStyle = '#ffffff';
    const drawF = (x0) => {
      roundRect((x0 + 0) * s, 324 * s, 80 * s, 384 * s, 18 * s); // stem
      ctx.fill();
      roundRect(x0 * s, 322 * s, 268 * s, 80 * s, 18 * s); // top arm
      ctx.fill();
      roundRect(x0 * s, 462 * s, 208 * s, 72 * s, 16 * s); // middle arm
      ctx.fill();
    };
    drawF(224);
    drawF(528);

    canvas.style.borderRadius = `${238 * s}px`;
  }

  // ---------------------------------------------------------------------
  // Inline SVG icon set. Drawn as vectors so the toolbar looks identical on
  // every Windows machine (no reliance on emoji fonts).
  // ---------------------------------------------------------------------
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2c0-.9 1-1.4 1.7-1l9 6.3c.6.4.6 1.3 0 1.7l-9 6.3c-.7.4-1.7 0-1.7-1V5.2z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.1"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4.6" y="5" width="2.2" height="14" rx="1"/><path d="M20 6.4c0-1-1.1-1.5-1.8-1L9.6 11c-.6.4-.6 1.4 0 1.8l8.6 5.7c.7.5 1.8 0 1.8-1V6.4z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="17.2" y="5" width="2.2" height="14" rx="1"/><path d="M4 6.4c0-1 1.1-1.5 1.8-1l8.6 5.7c.6.4.6 1.4 0 1.8L5.8 18.6c-.7.5-1.8 0-1.8-1V6.4z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3l4.2-3.6v12.2L7 14.5H4z"/><path d="M15.2 8.6a5 5 0 0 1 0 6.8"/><path d="M17.9 6a8.6 8.6 0 0 1 0 12"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3l4.2-3.6v12.2L7 14.5H4z"/><path d="M15.5 9.5l5 5"/><path d="M20.5 9.5l-5 5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.2c0-.8.6-1.4 1.4-1.4h3.3c.5 0 .9.2 1.2.5l1.1 1.2h7.6c.8 0 1.4.6 1.4 1.4v7.7c0 .8-.6 1.4-1.4 1.4H4.9c-.8 0-1.4-.6-1.4-1.4V7.2z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.1"/><path d="M12 3.4v2.3M12 18.3v2.3M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M3.4 12h2.3M18.3 12h2.3M5.9 18.1l1.6-1.6M16.5 7.5l1.6-1.6"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6.1"/><path d="M15.2 15.2l4.3 4.3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    focus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5.6C4 4.7 4.7 4 5.6 4H9M15 4h3.4c.9 0 1.6.7 1.6 1.6V9M20 15v3.4c0 .9-.7 1.6-1.6 1.6H15M9 20H5.6C4.7 20 4 19.3 4 18.4V15"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.4"/></svg>',
    contrast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none"/></svg>',
  };

  function icon(name) {
    return ICONS[name] || '';
  }

  /** Fills every [data-icon] element with its vector icon. */
  function applyIcons(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      const svg = ICONS[el.dataset.icon];
      if (svg) el.innerHTML = svg;
    });
    scope.querySelectorAll('.btn.icon svg, .btn svg').forEach((svg) => {
      if (!svg.getAttribute('width')) {
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
      }
    });
  }

  window.FFUI = { toast, modal, confirm, busy, drawBrandIcon, icon, applyIcons, ICONS, blockingOpen, openModals };
})();
