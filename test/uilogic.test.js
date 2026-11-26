'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const UiLogic = require('../src/renderer/uilogic');

const key = (over) => Object.assign({ type: 'keydown', key: '', code: '', keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false }, over);

test('Ctrl+C / Ctrl+V work by physical key on the Russian layout', () => {
  // Russian layout: the C key gives "с", the V key gives "м"
  const ctrlC = key({ key: 'с', code: 'KeyC', keyCode: 67, ctrlKey: true });
  const ctrlV = key({ key: 'м', code: 'KeyV', keyCode: 86, ctrlKey: true });
  assert.equal(UiLogic.clipboardAction(ctrlC, true), 'copy-clear');
  assert.equal(UiLogic.clipboardAction(ctrlC, false), null, 'without a selection Ctrl+C goes to the shell');
  assert.equal(UiLogic.clipboardAction(ctrlV, false), 'paste');
  assert.equal(UiLogic.clipboardAction(key({ key: 'С', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true }), false), 'copy');
});

test('on a Latin layout the letter decides, not the position (Dvorak, Colemak)', () => {
  // Dvorak: the key where QWERTY has I types "c", the QWERTY C key types "j"
  assert.equal(UiLogic.clipboardAction(key({ key: 'c', code: 'KeyI', keyCode: 67, ctrlKey: true }), true), 'copy-clear');
  assert.equal(UiLogic.clipboardAction(key({ key: 'j', code: 'KeyC', keyCode: 74, ctrlKey: true }), true), null);
  // Dvorak V is on QWERTY period; Colemak V stays on KeyV
  assert.equal(UiLogic.clipboardAction(key({ key: 'v', code: 'Period', keyCode: 86, ctrlKey: true }), false), 'paste');
  assert.equal(UiLogic.clipboardAction(key({ key: 'k', code: 'KeyV', keyCode: 75, ctrlKey: true }), false), null);
});

test('keyCode alone is enough when code is missing', () => {
  assert.equal(UiLogic.clipboardAction(key({ keyCode: 86, ctrlKey: true }), false), 'paste');
});

test('AltGr (Ctrl+Alt) and keyup are not clipboard shortcuts', () => {
  assert.equal(UiLogic.clipboardAction(key({ code: 'KeyV', keyCode: 86, ctrlKey: true, altKey: true }), false), null);
  assert.equal(UiLogic.clipboardAction(key({ type: 'keyup', code: 'KeyV', keyCode: 86, ctrlKey: true }), false), null);
  assert.equal(UiLogic.clipboardAction(key({ code: 'KeyV', keyCode: 86 }), false), null);
});

test('IME composition is detected by isComposing or keyCode 229', () => {
  assert.equal(UiLogic.isComposing(key({ isComposing: true, code: 'Space' })), true);
  assert.equal(UiLogic.isComposing(key({ keyCode: 229 })), true);
  assert.equal(UiLogic.isComposing(key({ keyCode: 32, code: 'Space' })), false);
});

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('a zoom picked in the window is kept while settings.json still has the same fontSize', () => {
  const st = memoryStorage();
  UiLogic.storeSize(st, 'fontSize', 17, 14);
  assert.equal(UiLogic.storedSize(st, 'fontSize', 14, 14), 17);
});

test('settings.json wins once its fontSize changes', () => {
  const st = memoryStorage();
  UiLogic.storeSize(st, 'fontSize', 17, 14);
  assert.equal(UiLogic.storedSize(st, 'fontSize', 20, 14), null);
  assert.equal(st.getItem('fontSize'), null, 'the stale value is dropped');
});

test('a plain number from an older version applies only if settings.json keeps the default', () => {
  assert.equal(UiLogic.storedSize(memoryStorage({ fontSize: '17' }), 'fontSize', 14, 14), 17);
  assert.equal(UiLogic.storedSize(memoryStorage({ fontSize: '17' }), 'fontSize', 20, 14), null);
  assert.equal(UiLogic.storedSize(memoryStorage({ fontSize: 'garbage' }), 'fontSize', 14, 14), null);
});
