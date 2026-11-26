'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDataDir, samePath } = require('../src/main/datadir');

const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';

test('no KOLONKA_DATA: the default folder, the normal instance', () => {
  assert.deepEqual(resolveDataDir({}, APPDATA, 'win32'), { dir: 'C:\\Users\\me\\AppData\\Roaming\\Kolonka', isolated: false });
});

test('KOLONKA_DATA equal to the default (as inherited by a Kolonka tab) is not a separate instance', () => {
  for (const v of ['C:\\Users\\me\\AppData\\Roaming\\Kolonka', 'c:\\users\\ME\\appdata\\roaming\\kolonka\\', 'C:/Users/me/AppData/Roaming/Kolonka']) {
    assert.equal(resolveDataDir({ KOLONKA_DATA: v }, APPDATA, 'win32').isolated, false, v);
  }
});

test('KOLONKA_DATA pointing elsewhere is an isolated instance', () => {
  assert.deepEqual(resolveDataDir({ KOLONKA_DATA: 'D:\\kolonka-test' }, APPDATA, 'win32'), { dir: 'D:\\kolonka-test', isolated: true });
});

test('samePath ignores case and trailing separators on Windows only', () => {
  assert.equal(samePath('C:\\A\\b\\', 'c:\\a\\B', 'win32'), true);
  assert.equal(samePath('/home/A', '/home/a', 'linux'), false);
  assert.equal(samePath('/home/a/', '/home/a', 'linux'), true);
});
