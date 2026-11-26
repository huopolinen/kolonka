'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keyToSeq } = require('../src/main/keys');
const { ApiError } = require('../src/main/errors');

test('named keys map to their sequences', () => {
  assert.equal(keyToSeq('enter'), '\r');
  assert.equal(keyToSeq('return'), '\r');
  assert.equal(keyToSeq('tab'), '\t');
  assert.equal(keyToSeq('esc'), '\x1b');
  assert.equal(keyToSeq('backspace'), '\x7f');
  assert.equal(keyToSeq('up'), '\x1b[A');
  assert.equal(keyToSeq('pgdn'), '\x1b[6~');
});

test('key names are case-insensitive and trimmed', () => {
  assert.equal(keyToSeq('ENTER'), '\r');
  assert.equal(keyToSeq('  Tab '), '\t');
});

test('shift+tab is a back-tab', () => {
  assert.equal(keyToSeq('shift+tab'), '\x1b[Z');
});

test('function keys', () => {
  assert.equal(keyToSeq('f1'), '\x1bOP');
  assert.equal(keyToSeq('f4'), '\x1bOS');
  assert.equal(keyToSeq('f5'), '\x1b[15~');
  assert.equal(keyToSeq('F12'), '\x1b[24~');
});

test('ctrl combinations become control characters', () => {
  assert.equal(keyToSeq('ctrl+c'), '\x03');
  assert.equal(keyToSeq('Ctrl-D'), '\x04');
  assert.equal(keyToSeq('c-z'), '\x1a');
  assert.equal(keyToSeq('ctrl+['), '\x1b');
});

test('alt combinations are prefixed with ESC', () => {
  assert.equal(keyToSeq('alt+x'), '\x1bx');
  assert.equal(keyToSeq('meta+enter'), '\x1b\r');
});

test('a single character is sent as is', () => {
  assert.equal(keyToSeq('q'), 'q');
  assert.equal(keyToSeq('A'), 'A');
});

test('an unknown key is a 400 error', () => {
  assert.throws(() => keyToSeq('hyper+q'), (e) => e instanceof ApiError && e.code === 400 && /unknown key/.test(e.message));
  assert.throws(() => keyToSeq('nosuchkey'), (e) => e instanceof ApiError && e.code === 400);
});

test('alt + a key that is not one character or a known name is a 400 error', () => {
  for (const k of ['alt+ctrl+x', 'alt+nosuch', 'meta+shift+tab+x']) {
    assert.throws(() => keyToSeq(k), (e) => e instanceof ApiError && e.code === 400, k);
  }
});

test('alt + a character keeps its case', () => {
  assert.equal(keyToSeq('alt+X'), '\x1bX');
  assert.equal(keyToSeq('alt+tab'), '\x1b\t');
});
