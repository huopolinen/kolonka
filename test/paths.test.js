'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSafeLocalPath, dirOk, openableDir } = require('../src/main/paths');

test('isSafeLocalPath accepts drive paths on Windows', () => {
  for (const p of ['C:\\', 'C:\\Users\\x', 'd:/work/repo', 'Z:\\mapped\\drive']) assert.equal(isSafeLocalPath(p, 'win32'), true, p);
});

test('isSafeLocalPath rejects UNC, device and network paths on Windows', () => {
  const bad = [
    '\\\\attacker\\share', '\\\\attacker.example.com@SSL\\x', '//attacker/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x',
    '\\\\?\\UNC\\host\\share', 'C:\\\\host\\share', 'C://host/share', '/\\host\\share', '\\/host/share',
  ];
  for (const p of bad) assert.equal(isSafeLocalPath(p, 'win32'), false, p);
});

test('isSafeLocalPath rejects relative paths, schemes and junk', () => {
  const bad = ['', null, undefined, 42, 'relative\\dir', 'C:', 'C:relative', 'file://host/share', 'http://x/y', '\\Windows', '/c/Users/x', 'C:\\x\ny', 'C:\\x\x00'];
  for (const p of bad) assert.equal(isSafeLocalPath(p, 'win32'), false, String(p));
});

test('isSafeLocalPath on other platforms: absolute paths, but not //host', () => {
  assert.equal(isSafeLocalPath('/home/u', 'linux'), true);
  assert.equal(isSafeLocalPath('//host/share', 'linux'), false);
  assert.equal(isSafeLocalPath('relative', 'darwin'), false);
});

test('dirOk never stats a UNC path', (t) => {
  const calls = [];
  const orig = fs.statSync;
  fs.statSync = (p, ...a) => { calls.push(p); return orig(p, ...a); };
  t.after(() => { fs.statSync = orig; });
  assert.equal(dirOk('\\\\attacker\\share', 'win32'), false);
  assert.equal(dirOk('//attacker/share', 'win32'), false);
  assert.deepEqual(calls, []);
});

test('dirOk is true only for an existing directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(dirOk(dir), true);
  assert.equal(dirOk(file), false);
  assert.equal(dirOk(path.join(dir, 'missing')), false);
});

test('openableDir opens only the session\'s own local folder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'evil.exe');
  fs.writeFileSync(file, 'x');
  const model = { sessions: new Map([['s1', { cwd: dir }], ['s2', { cwd: file }], ['s3', { cwd: '\\\\attacker\\share' }]]) };
  assert.equal(openableDir(model, 's1'), path.resolve(dir));
  assert.equal(openableDir(model, 's2'), null, 'a file is never opened');
  assert.equal(openableDir(model, 's3', 'win32'), null, 'a UNC path is never opened');
  assert.equal(openableDir(model, 'nope'), null);
  assert.equal(openableDir(model, undefined), null);
});
