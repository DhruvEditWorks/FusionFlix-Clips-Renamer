/*
 * FUSION FLIX — keyboard shortcut engine (works in Node and in the browser).
 *
 * Single source of truth for: the shortcut list, how a key press is matched to
 * an action, how bindings are displayed, and conflict detection.
 * Tests: tests/shortcuts.test.js
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FFKeys = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * `typing` decides when a shortcut is allowed while an input has focus:
   *   'no'   – only when nothing is focused (plain letters/digits)
   *   'text' – also inside number fields, but never while writing free text
   *   'yes'  – always, even in a text box (used for Ctrl-combos and Escape)
   * `locked` marks shortcuts the interface depends on and that must stay unique.
   */
  const DEFINITIONS = [
    // --- playback ---------------------------------------------------------
    { id: 'playPause', label: 'Play / Pause', group: 'Playback', keys: 'Space', typing: 'text', hint: 'Works wherever the pointer is — even while a Scene/Shot/Take box has focus.' },
    { id: 'playForward', label: 'Play forward (press again for speed)', group: 'Playback', keys: 'L', typing: 'text', hint: 'DaVinci style — tap L repeatedly to shuttle 1× 2× 4× 8×.' },
    { id: 'playReverse', label: 'Play backward (press again for speed)', group: 'Playback', keys: 'J', typing: 'text', hint: 'Reverse shuttle: 1× 2× 4× 8×, tap K or Space to stop.' },
    { id: 'stopPlayback', label: 'Stop playback', group: 'Playback', keys: 'K', typing: 'text' },
    { id: 'mute', label: 'Mute / Unmute', group: 'Playback', keys: 'M', typing: 'text' },
    { id: 'replayClip', label: 'Jump to clip start', group: 'Playback', keys: 'Shift+Space', typing: 'text' },

    // --- moving around ----------------------------------------------------
    { id: 'prevClip', label: 'Previous clip', group: 'Navigation', keys: 'ArrowLeft', typing: 'no' },
    { id: 'nextClip', label: 'Next clip', group: 'Navigation', keys: 'ArrowRight', typing: 'no' },
    { id: 'firstClip', label: 'First clip in view', group: 'Navigation', keys: 'Home', typing: 'no' },
    { id: 'lastClip', label: 'Last clip in view', group: 'Navigation', keys: 'End', typing: 'no' },
    { id: 'focusSearch', label: 'Search clips', group: 'Navigation', keys: '/', typing: 'no' },
    { id: 'clearFilters', label: 'Clear search and filters', group: 'Navigation', keys: 'Shift+Escape', typing: 'yes' },

    // --- tagging: the rapid flow -----------------------------------------
    { id: 'applyNext', label: 'Apply & Next clip', group: 'Tagging', keys: 'Enter', typing: 'text', hint: 'Typed inside a Scene/Shot/Take box it saves and jumps on — the fastest way through a card.' },
    { id: 'apply', label: 'Apply to clip', group: 'Tagging', keys: 'Ctrl+Enter', typing: 'yes' },
    { id: 'nextFromPrevious', label: 'Next From Previous (smart)', group: 'Tagging', keys: 'F', typing: 'text', hint: 'Applies to the Scene/Shot/Take box you are in. With nothing focused it carries all three forward.' },
    { id: 'nextScene', label: 'Next Scene from previous', group: 'Tagging', keys: 'Shift+F', typing: 'text' },
    { id: 'nextShot', label: 'Next Shot from previous', group: 'Tagging', keys: 'G', typing: 'text' },
    { id: 'nextTake', label: 'Next Take from previous', group: 'Tagging', keys: 'H', typing: 'text' },
    { id: 'toggleScene', label: 'Scene switch on / off', group: 'Tagging', keys: 'Shift+A', typing: 'text', hint: 'Switching it on fills it from the previous clip + 1 (Settings → Tagging).' },
    { id: 'toggleShot', label: 'Shot switch on / off', group: 'Tagging', keys: 'Shift+S', typing: 'text' },
    { id: 'toggleTake', label: 'Take switch on / off', group: 'Tagging', keys: 'Shift+D', typing: 'text' },
    { id: 'toggleExtra', label: 'Toggle EXTRA', group: 'Tagging', keys: 'Shift+E', typing: 'text' },
    { id: 'toggleCustom', label: 'Custom Name switch on / off', group: 'Tagging', keys: 'Shift+W', typing: 'text', hint: 'Switching it on clears Scene / Shot / Take so the custom name is the whole name.' },
    { id: 'focusScene', label: 'Focus Scene box', group: 'Tagging', keys: '1', typing: 'no' },
    { id: 'focusShot', label: 'Focus Shot box', group: 'Tagging', keys: '2', typing: 'no' },
    { id: 'focusTake', label: 'Focus Take box', group: 'Tagging', keys: '3', typing: 'no' },
    { id: 'focusCustom', label: 'Focus Custom Name', group: 'Tagging', keys: 'C', typing: 'no' },
    { id: 'deleteClip', label: 'Delete clip (asks first)', group: 'Tagging', keys: 'Delete', typing: 'no' },

    // --- project ----------------------------------------------------------
    { id: 'undo', label: 'Undo', group: 'Project', keys: 'Ctrl+Z', typing: 'yes' },
    { id: 'redo', label: 'Redo', group: 'Project', keys: 'Ctrl+Shift+Z', typing: 'yes' },
    { id: 'saveProject', label: 'Save project', group: 'Project', keys: 'Ctrl+S', typing: 'yes' },
    { id: 'saveProjectAs', label: 'Save project as…', group: 'Project', keys: 'Ctrl+Shift+S', typing: 'yes' },
    { id: 'openProject', label: 'Open project', group: 'Project', keys: 'Ctrl+O', typing: 'yes' },
    { id: 'newProject', label: 'New project', group: 'Project', keys: 'Ctrl+N', typing: 'yes' },
    { id: 'importClips', label: 'Import clips', group: 'Project', keys: 'Ctrl+Shift+O', typing: 'yes' },
    { id: 'importFolder', label: 'Import folder', group: 'Project', keys: 'Ctrl+Shift+D', typing: 'yes' },
    { id: 'openExport', label: 'Export', group: 'Project', keys: 'Ctrl+E', typing: 'yes' },
    { id: 'relink', label: 'Relink missing media', group: 'Project', keys: 'Ctrl+R', typing: 'yes' },
    { id: 'openRename', label: 'Rename files (in place)', group: 'Project', keys: 'Ctrl+Shift+R', typing: 'yes' },

    // --- view -------------------------------------------------------------
    { id: 'toggleFullscreen', label: 'Full screen', group: 'View', keys: 'Ctrl+F', typing: 'yes' },
    { id: 'toggleFocusMode', label: 'Focus preview (hide side panels)', group: 'View', keys: 'P', typing: 'no' },
    { id: 'cycleTheme', label: 'Cycle theme (Cinema / Midnight / Daylight)', group: 'View', keys: 'Shift+T', typing: 'text' },
    { id: 'openSettings', label: 'Settings', group: 'View', keys: 'Ctrl+,', typing: 'yes' },
    { id: 'openHelp', label: 'Keyboard shortcuts', group: 'View', keys: 'F1', typing: 'yes' },
    { id: 'cancel', label: 'Stop scrub / clear focus', group: 'View', keys: 'Escape', typing: 'yes' },
  ];

  /** Canonical modifier order and key labels. */
  const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
  const KEY_LABELS = {
    ' ': 'Space',
    space: 'Space',
    spacebar: 'Space',
    esc: 'Escape',
    escape: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    del: 'Delete',
    delete: 'Delete',
    backspace: 'Backspace',
    arrowleft: 'ArrowLeft',
    left: 'ArrowLeft',
    arrowright: 'ArrowRight',
    right: 'ArrowRight',
    arrowup: 'ArrowUp',
    up: 'ArrowUp',
    arrowdown: 'ArrowDown',
    down: 'ArrowDown',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    home: 'Home',
    end: 'End',
    tab: 'Tab',
    plus: '+',
  };

  function canonicalKey(raw) {
    if (raw === undefined || raw === null) return '';
    // A lone space is a real key, so look it up before trimming anything away.
    if (KEY_LABELS[String(raw).toLowerCase()]) return KEY_LABELS[String(raw).toLowerCase()];
    const value = String(raw).trim();
    if (!value) return '';
    const lower = value.toLowerCase();
    if (KEY_LABELS[lower]) return KEY_LABELS[lower];
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
    if (value.length === 1) return value.toUpperCase();
    if (/^[a-z]/i.test(value)) return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    return value;
  }

  /** "shift + ctrl+z" → "Ctrl+Shift+Z" */
  function normalizeCombo(raw) {
    if (!raw) return '';
    // " " or "space" alone is the spacebar, not an empty binding.
    const rawLiteral = String(raw);
    if (rawLiteral === ' ') return 'Space';

    const parts = rawLiteral
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return '';

    // A trailing "+" key ("Ctrl++") arrives as an empty part — restore it.
    const trailingPlus = /\+\s*$/.test(String(raw)) && !String(raw).trim().endsWith('+');

    const modifiers = new Set();
    let key = '';
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'command' || lower === 'meta') modifiers.add('Ctrl');
      else if (lower === 'alt' || lower === 'option') modifiers.add('Alt');
      else if (lower === 'shift') modifiers.add('Shift');
      else key = canonicalKey(part);
    }
    if (trailingPlus && !key) key = '+';
    if (!key) return '';
    return [...MODIFIERS.filter((m) => modifiers.has(m)), key].join('+');
  }

  /** Builds a canonical combo from a keyboard event. */
  function comboFromEvent(event) {
    if (!event) return '';
    const modifiers = [];
    if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    const key = canonicalKey(event.key === undefined ? event.code : event.key);
    if (!key) return '';
    return [...modifiers, key].join('+');
  }

  /** "Ctrl+Shift+Z" → "Ctrl + Shift + Z" for display. */
  function formatCombo(combo) {
    if (!combo) return 'Not set';
    return String(combo)
      .split('+')
      .map((part) => {
        if (part === 'Ctrl' || part === 'Alt' || part === 'Shift') return part;
        if (part === 'ArrowLeft') return '←';
        if (part === 'ArrowRight') return '→';
        if (part === 'ArrowUp') return '↑';
        if (part === 'ArrowDown') return '↓';
        if (part === 'Space') return 'Space';
        if (part === 'Escape') return 'Esc';
        if (part === 'Delete') return 'Del';
        return part;
      })
      .join(' + ');
  }

  /** Default binding map: { actionId: combo } */
  function defaultBindings() {
    const map = {};
    for (const def of DEFINITIONS) map[def.id] = normalizeCombo(def.keys);
    return map;
  }

  /** Merges stored overrides onto the defaults, dropping unknown/invalid entries. */
  function mergeBindings(overrides) {
    const map = defaultBindings();
    const cleaned = {};
    if (overrides && typeof overrides === 'object') {
      for (const [id, value] of Object.entries(overrides)) {
        if (!(id in map)) continue;
        const combo = value === '' || value === null ? '' : normalizeCombo(value);
        if (combo === '') {
          map[id] = ''; // explicitly unbound
          cleaned[id] = '';
          continue;
        }
        map[id] = combo;
        cleaned[id] = combo;
      }
    }
    return { bindings: map, overrides: cleaned };
  }

  /** Actions that share the same combo. Returns { combo: [actionId, ...] }. */
  function findConflicts(bindings) {
    const byCombo = new Map();
    for (const [id, combo] of Object.entries(bindings || {})) {
      if (!combo) continue;
      if (!byCombo.has(combo)) byCombo.set(combo, []);
      byCombo.get(combo).push(id);
    }
    const conflicts = {};
    for (const [combo, ids] of byCombo) {
      if (ids.length > 1) conflicts[combo] = ids;
    }
    return conflicts;
  }

  /**
   * Decides whether an action may run in the current focus context.
   * `ctx` = { typingAny, typingText, modalOpen, exporting }
   */
  function allowedInContext(def, ctx) {
    if (!def) return false;
    const context = ctx || {};
    if (context.modalOpen) return def.typing === 'yes';
    if (!context.typingAny) return true;
    if (def.typing === 'yes') return true;
    if (def.typing === 'text') return !context.typingText;
    return false;
  }

  /**
   * Finds the action bound to a keyboard event.
   * @returns {{ id: string, def: object }|null}
   */
  function resolve(event, bindings, ctx) {
    const combo = comboFromEvent(event);
    if (!combo) return null;
    const map = bindings || defaultBindings();
    for (const def of DEFINITIONS) {
      if (map[def.id] !== combo) continue;
      if (!allowedInContext(def, ctx)) continue;
      return { id: def.id, def };
    }
    return null;
  }

  function definitionById(id) {
    return DEFINITIONS.find((d) => d.id === id) || null;
  }

  /** Groups definitions by their `group` field, preserving order. */
  function grouped() {
    const order = [];
    const groups = {};
    for (const def of DEFINITIONS) {
      if (!groups[def.group]) {
        groups[def.group] = [];
        order.push(def.group);
      }
      groups[def.group].push(def);
    }
    return order.map((name) => ({ name, items: groups[name] }));
  }

  const LOCKED = new Set(['cancel']);

  return {
    DEFINITIONS,
    LOCKED,
    canonicalKey,
    normalizeCombo,
    comboFromEvent,
    formatCombo,
    defaultBindings,
    mergeBindings,
    findConflicts,
    allowedInContext,
    resolve,
    definitionById,
    grouped,
  };
});
