'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { msysToWin, parseOsc7 } = require('../src/main/shells');

test('msysToWin converts msys drive paths', () => {
  assert.equal(msysToWin('/c/Users/x'), 'C:\\Users\\x');
  assert.equal(msysToWin('/d/work/repo'), 'D:\\work\\repo');
  assert.equal(msysToWin('/c'), 'C:\\');
});

test('msysToWin normalizes Windows paths with forward slashes', () => {
  assert.equal(msysToWin('C:/Users/x'), 'C:\\Users\\x');
  assert.equal(msysToWin('C:\\Users\\x'), 'C:\\Users\\x');
});

test('msysToWin returns null for paths that are not on a drive', () => {
  assert.equal(msysToWin('/home/u'), null);
  assert.equal(msysToWin('/usr/bin'), null);
  assert.equal(msysToWin(''), null);
  assert.equal(msysToWin(null), null);
});

test('parseOsc7 reads msys paths with or without a host', () => {
  assert.equal(parseOsc7('file://HOST/c/Users/x'), 'C:\\Users\\x');
  assert.equal(parseOsc7('file:///c/Users/x'), 'C:\\Users\\x');
});

test('parseOsc7 reads file:///C:/ URLs', () => {
  assert.equal(parseOsc7('file:///C:/x'), 'C:\\x');
  assert.equal(parseOsc7('file://host/C:/Users/x/y'), 'C:\\Users\\x\\y');
});

test('parseOsc7 decodes percent-escapes', () => {
  assert.equal(parseOsc7('file:///c/My%20Documents'), 'C:\\My Documents');
});

test('parseOsc7 does not throw on a broken escape', () => {
  assert.doesNotThrow(() => parseOsc7('file:///c/bad%E0name'));
  assert.equal(parseOsc7('file:///c/bad%E0name'), 'C:\\bad%E0name');
});

test('parseOsc7 returns null for non-Windows paths and other data', () => {
  assert.equal(parseOsc7('file://host/home/u'), null);
  assert.equal(parseOsc7('/c/Users/x'), null);
  assert.equal(parseOsc7('http://example.com/c/x'), null);
});
