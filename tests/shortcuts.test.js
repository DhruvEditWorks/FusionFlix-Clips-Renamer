'use strict';
/**
 * Fusion Flix — keyboard shortcut engine tests.
 */
const test = require('node:test');
const assert = require('node:assert');

const K = require('../lib/shortcuts');

/** Builds a fake KeyboardEvent-ish object. */
function key(keyName, mods) {
  const m = mods || {};
  return { key: keyName, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta };
}

const NO_TYPING = { typingAny: false, typingText: false, modalOpen: false };
const IN_NUMBER_FIELD = { typingAny: true, typingText: false, modalOpen: false };
const IN_TEXT_FIELD = { typingAny: true, typingText: true, modalOpen: false };

test('every definition has a unique id and a valid combo', () => {
  const ids = new Set();
  for (const def of K.DEFINITIONS) {
    assert.ok(def.id && !ids.has(def.id), `duplicate id ${def.id}`);
    ids.add(def.id);
    assert.strictEqual(K.normalizeCombo(def.keys), K.defaultBindings()[def.id], `${def.id} normalises consistently`);
    assert.ok(['no', 'text', 'yes'].includes(def.typing), `${def.id} declares a typing rule`);
  }
  assert.ok(K.DEFINITIONS.length >= 30, 'a full shortcut set is published');
});

test('no two default shortcuts collide', () => {
  const conflicts = K.findConflicts(K.defaultBindings());
  assert.deepStrictEqual(conflicts, {}, `defaults must be conflict-free, found: ${JSON.stringify(conflicts)}`);
});

test('combos normalise regardless of order or case', () => {
  assert.strictEqual(K.normalizeCombo('shift+ctrl+z'), 'Ctrl+Shift+Z');
  assert.strictEqual(K.normalizeCombo('CTRL + SHIFT + Z'), 'Ctrl+Shift+Z');
  assert.strictEqual(K.normalizeCombo('space'), 'Space');
  assert.strictEqual(K.normalizeCombo(' '), 'Space');
  assert.strictEqual(K.normalizeCombo('esc'), 'Escape');
  assert.strictEqual(K.normalizeCombo('f'), 'F');
  assert.strictEqual(K.normalizeCombo('F1'), 'F1');
  assert.strictEqual(K.normalizeCombo(''), '');
  assert.strictEqual(K.normalizeCombo('shift'), '');
});

test('keyboard events turn into the same combos', () => {
  assert.strictEqual(K.comboFromEvent(key(' ')), 'Space');
  assert.strictEqual(K.comboFromEvent(key('z', { ctrl: true, shift: true })), 'Ctrl+Shift+Z');
  assert.strictEqual(K.comboFromEvent(key('ArrowLeft')), 'ArrowLeft');
  assert.strictEqual(K.comboFromEvent(key('F')), 'F');
  assert.strictEqual(K.comboFromEvent(key('f', { shift: true })), 'Shift+F');
  assert.strictEqual(K.comboFromEvent(key('Enter', { ctrl: true })), 'Ctrl+Enter');
  assert.strictEqual(K.comboFromEvent(key(',', { ctrl: true })), 'Ctrl+,');
});

test('the F family works exactly as requested', () => {
  const bindings = K.defaultBindings();

  // F = smart "next from previous"
  const f = K.resolve(key('f'), bindings, NO_TYPING);
  assert.strictEqual(f.id, 'nextFromPrevious');

  // ...and it still works while a Scene/Shot/Take box has focus
  assert.strictEqual(K.resolve(key('f'), bindings, IN_NUMBER_FIELD).id, 'nextFromPrevious');
  // ...but never while writing a custom name
  assert.strictEqual(K.resolve(key('f'), bindings, IN_TEXT_FIELD), null);

  assert.strictEqual(K.resolve(key('F', { shift: true }), bindings, NO_TYPING).id, 'nextScene');
  assert.strictEqual(K.resolve(key('g'), bindings, NO_TYPING).id, 'nextShot');
  assert.strictEqual(K.resolve(key('h'), bindings, NO_TYPING).id, 'nextTake');
});

test('Space plays the clip about, but yields to text entry', () => {
  const bindings = K.defaultBindings();
  assert.strictEqual(K.resolve(key(' '), bindings, NO_TYPING).id, 'playPause');
  assert.strictEqual(K.resolve(key(' '), bindings, IN_NUMBER_FIELD).id, 'playPause', 'space still plays while a number field has focus');
  assert.strictEqual(K.resolve(key(' '), bindings, IN_TEXT_FIELD), null, 'space types a space in the custom name');
});

test('plain letters are blocked while typing, Ctrl-combos are not', () => {
  const bindings = K.defaultBindings();
  assert.strictEqual(K.resolve(key('e'), bindings, IN_TEXT_FIELD), null, 'E must not toggle EXTRA while typing');
  assert.strictEqual(K.resolve(key('z', { ctrl: true }), bindings, IN_TEXT_FIELD).id, 'undo');
  assert.strictEqual(K.resolve(key('s', { ctrl: true }), bindings, IN_TEXT_FIELD).id, 'saveProject');
  assert.strictEqual(K.resolve(key('Enter'), bindings, IN_NUMBER_FIELD).id, 'applyNext', 'Enter still flows inside number fields');
  assert.strictEqual(K.resolve(key('Escape'), bindings, IN_TEXT_FIELD).id, 'cancel', 'Escape always works');
});

test('a modal owns the keyboard except for Escape', () => {
  const bindings = K.defaultBindings();
  const modalCtx = { typingAny: false, typingText: false, modalOpen: true };
  assert.strictEqual(K.resolve(key(' '), bindings, modalCtx), null);
  assert.strictEqual(K.resolve(key('f'), bindings, modalCtx), null);
  assert.strictEqual(K.resolve(key('Escape'), bindings, modalCtx).id, 'cancel');
});

test('user overrides replace defaults and can unbind', () => {
  const { bindings, overrides } = K.mergeBindings({ nextTake: 'Shift+H', mute: '', nextClip: 'Shift+N' });
  assert.strictEqual(bindings.nextTake, 'Shift+H');
  assert.strictEqual(bindings.mute, '', 'an empty string means unbound');
  assert.strictEqual(bindings.nextClip, 'Shift+N');
  assert.strictEqual(bindings.playPause, 'Space', 'untouched actions keep their default');
  assert.deepStrictEqual(overrides, { nextTake: 'Shift+H', mute: '', nextClip: 'Shift+N' });

  // unknown keys are ignored rather than stored
  const cleaned = K.mergeBindings({ notARealAction: 'Q' });
  assert.strictEqual(cleaned.bindings.notARealAction, undefined);
});

test('remapped shortcuts resolve and report conflicts', () => {
  const { bindings } = K.mergeBindings({ nextTake: 'H', nextShot: 'H' });
  const conflicts = K.findConflicts(bindings);
  assert.ok(conflicts.H, 'the clash is detected');
  assert.deepStrictEqual(conflicts.H.sort(), ['nextShot', 'nextTake']);
  // the first matching definition in the list wins, deterministically
  assert.strictEqual(K.resolve(key('h'), bindings, NO_TYPING).id, 'nextShot');
});

test('bindings survive a save/load round trip through JSON', () => {
  const { overrides } = K.mergeBindings({ applyNext: 'Ctrl+Space', focusShot: 'q' });
  const restored = K.mergeBindings(JSON.parse(JSON.stringify(overrides)));
  assert.strictEqual(restored.bindings.applyNext, 'Ctrl+Space');
  assert.strictEqual(restored.bindings.focusShot, 'Q');
});

test('display formatting is human friendly', () => {
  assert.strictEqual(K.formatCombo('Ctrl+Shift+Z'), 'Ctrl + Shift + Z');
  assert.strictEqual(K.formatCombo('ArrowLeft'), '←');
  assert.strictEqual(K.formatCombo('ArrowRight'), '→');
  assert.strictEqual(K.formatCombo('Escape'), 'Esc');
  assert.strictEqual(K.formatCombo('Space'), 'Space');
  assert.strictEqual(K.formatCombo(''), 'Not set');
});

test('groups are published in a stable order for the help window', () => {
  const groups = K.grouped();
  assert.deepStrictEqual(groups.map((g) => g.name), ['Playback', 'Navigation', 'Tagging', 'Project', 'View']);
  for (const group of groups) assert.ok(group.items.length > 0);
});

test('the keys the user asked for are the defaults', () => {
  const b = K.defaultBindings();
  assert.strictEqual(b.toggleScene, 'Shift+A', 'Shift+A toggles Scene');
  assert.strictEqual(b.toggleShot, 'Shift+S', 'Shift+S toggles Shot');
  assert.strictEqual(b.toggleTake, 'Shift+D', 'Shift+D toggles Take');
  assert.strictEqual(b.toggleExtra, 'Shift+E', 'Shift+E toggles EXTRA');
  assert.strictEqual(b.toggleCustom, 'Shift+W', 'Shift+W toggles Custom Name');
  assert.strictEqual(b.playForward, 'L', 'L plays forward');
  assert.strictEqual(b.playReverse, 'J', 'J plays backward');
  assert.strictEqual(b.stopPlayback, 'K', 'K stops');
  assert.strictEqual(b.toggleFullscreen, 'Ctrl+F', 'Ctrl+F is full screen');
  assert.strictEqual(b.openRename, 'Ctrl+Shift+R', 'Ctrl+Shift+R renames the files');
  assert.strictEqual(b.playPause, 'Space', 'Space still plays / pauses');
});

test('the tagging switches work even while a number box has focus', () => {
  const b = K.defaultBindings();
  for (const id of ['toggleScene', 'toggleShot', 'toggleTake', 'toggleExtra', 'toggleCustom']) {
    const def = K.definitionById(id);
    const hit = K.resolve({ key: def.keys.replace('Shift+', ''), shiftKey: true }, b, IN_NUMBER_FIELD);
    assert.ok(hit && hit.id === id, `${id} must fire with a number field focused`);
    const inText = K.resolve({ key: def.keys.replace('Shift+', ''), shiftKey: true }, b, IN_TEXT_FIELD);
    assert.strictEqual(inText, null, `${id} must not fire while typing free text`);
  }
});

test('J / K / L and Ctrl+F behave like playback keys, not text keys', () => {
  const b = K.defaultBindings();
  assert.strictEqual(K.resolve({ key: 'l' }, b, NO_TYPING).id, 'playForward');
  assert.strictEqual(K.resolve({ key: 'j' }, b, NO_TYPING).id, 'playReverse');
  assert.strictEqual(K.resolve({ key: 'k' }, b, NO_TYPING).id, 'stopPlayback');
  assert.strictEqual(K.resolve({ key: 'f', ctrlKey: true }, b, IN_TEXT_FIELD).id, 'toggleFullscreen');
  // …but the letters must stay letters while typing a custom name.
  assert.strictEqual(K.resolve({ key: 'l' }, b, IN_TEXT_FIELD), null);
});

test('every action the renderer wires has a definition (no dead keys)', () => {
  const b = K.defaultBindings();
  const ids = Object.keys(b);
  assert.ok(ids.length >= 44, `expected the full set, found ${ids.length}`);
  for (const id of ['playForward', 'playReverse', 'stopPlayback', 'toggleScene', 'toggleShot', 'toggleTake', 'toggleCustom', 'toggleFullscreen', 'openRename']) {
    assert.ok(ids.includes(id), `${id} is bound by default`);
  }
});
