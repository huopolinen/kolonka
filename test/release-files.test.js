'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const yaml = require('js-yaml');
const { checkRelease } = require('./smoke/release-files');

const V = '0.3.0';
const EXE = `Kolonka-Setup-${V}.exe`;

// A dist folder shaped like electron-builder's output: a fake installer with an NSIS-style manifest,
// its blockmap, latest.yml and win-unpacked/resources/app-update.yml.
function fakeDist(t, { level = 'asInvoker', tweak = () => {}, blockSizes = null, appUpdate = {} } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-release-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const exe = Buffer.concat([Buffer.from('MZ stub '), Buffer.from(`<trustInfo><requestedExecutionLevel level="${level}" uiAccess="false"/></trustInfo>`), crypto.randomBytes(5000)]);
  fs.writeFileSync(path.join(dist, EXE), exe);
  const sizes = blockSizes || [3000, exe.length - 3000];
  fs.writeFileSync(path.join(dist, EXE + '.blockmap'), zlib.gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: sizes.map(() => 'x'), sizes }] })));
  const sha512 = crypto.createHash('sha512').update(exe).digest('base64');
  const latest = { version: V, files: [{ url: EXE, sha512, size: exe.length }], path: EXE, sha512, releaseDate: '2026-11-26T00:00:00.000Z' };
  tweak(latest);
  fs.writeFileSync(path.join(dist, 'latest.yml'), yaml.dump(latest));
  fs.mkdirSync(path.join(dist, 'win-unpacked', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'win-unpacked', 'resources', 'app-update.yml'),
    yaml.dump(Object.assign({ owner: 'huopolinen', repo: 'kolonka', provider: 'github', releaseType: 'draft', updaterCacheDirName: 'kolonka-updater' }, appUpdate)));
  return dist;
}

test('a consistent build passes', (t) => {
  const ok = checkRelease({ dist: fakeDist(t), version: V });
  assert.equal(ok.length, 4);
  assert.match(ok.join('\n'), /sha512 matches/);
  assert.match(ok.join('\n'), /asInvoker/);
});

test('latest.yml pointing at another file, or with a stale sha512 or size, fails', (t) => {
  const cases = [
    [(l) => { l.files[0].url = 'Kolonka Setup 0.3.0.exe'; }, /files\[0\]\.url is Kolonka Setup/],
    [(l) => { l.path = 'old.exe'; }, /path is old\.exe/],
    [(l) => { l.files[0].sha512 = 'AAAA'; }, /files\[0\]\.sha512 does not match/],
    [(l) => { l.sha512 = 'AAAA'; }, /latest\.yml sha512 does not match/],
    [(l) => { l.files[0].size += 1; }, /files\[0\]\.size/],
    [(l) => { l.version = '0.2.9'; }, /version 0\.2\.9, expected 0\.3\.0/],
    [(l) => { l.files[0].isAdminRightsRequired = true; }, /admin rights/],
  ];
  for (const [tweak, re] of cases) assert.throws(() => checkRelease({ dist: fakeDist(t, { tweak }), version: V }), re);
});

test('a missing or partial blockmap fails', (t) => {
  const dist = fakeDist(t, { blockSizes: [10, 20] });
  assert.throws(() => checkRelease({ dist, version: V }), /blockmap covers 30 bytes/);
  const d2 = fakeDist(t);
  fs.unlinkSync(path.join(d2, EXE + '.blockmap'));
  assert.throws(() => checkRelease({ dist: d2, version: V }), /blockmap was not built/);
});

test('an installer that asks for admin rights fails', (t) => {
  assert.throws(() => checkRelease({ dist: fakeDist(t, { level: 'requireAdministrator' }), version: V }), /requireAdministrator, expected asInvoker/);
});

test('app-update.yml pointing at another repository fails', (t) => {
  assert.throws(() => checkRelease({ dist: fakeDist(t, { appUpdate: { repo: 'fork' } }), version: V }), /huopolinen\/fork/);
  const d = fakeDist(t);
  fs.unlinkSync(path.join(d, 'win-unpacked', 'resources', 'app-update.yml'));
  assert.throws(() => checkRelease({ dist: d, version: V }), /app-update\.yml/);
});
