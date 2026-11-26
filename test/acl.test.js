'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { needsPrivateAcl, icaclsArgs, restrictToUser } = require('../src/main/acl');

const HOME = path.resolve('/profiles/alice');

test('a data folder inside the profile keeps the inherited ACL', () => {
  assert.equal(needsPrivateAcl(path.join(HOME, 'AppData', 'Roaming', 'Kolonka'), HOME), false);
  assert.equal(needsPrivateAcl(HOME, HOME), false);
});

test('a data folder outside the profile needs its own ACL', () => {
  assert.equal(needsPrivateAcl(path.resolve('/shared/kolonka'), HOME), true);
  assert.equal(needsPrivateAcl(path.resolve('/profiles/alice2/x'), HOME), true, 'a sibling profile with a longer name is outside');
});

test('icacls removes inheritance and grants only DOMAIN\\user', () => {
  assert.deepEqual(icaclsArgs('D:\\share\\control.json', { user: 'alice', domain: 'CORP' }),
    ['D:\\share\\control.json', '/inheritance:r', '/grant:r', 'CORP\\alice:F']);
  assert.deepEqual(icaclsArgs('x', { user: 'alice' }).slice(-1), ['alice:F']);
  assert.throws(() => icaclsArgs('x', {}));
});

test('restrictToUser runs icacls from System32 on Windows', async () => {
  const calls = [];
  const run = (exe, args, _o, cb) => { calls.push([exe, args]); cb(null, '', ''); };
  const ok = await restrictToUser('D:\\share\\control.json', { platform: 'win32', env: { USERNAME: 'alice', USERDOMAIN: 'CORP', SystemRoot: 'C:\\Windows' }, run });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /System32[\\/]icacls\.exe$/);
  assert.deepEqual(calls[0][1], ['D:\\share\\control.json', '/inheritance:r', '/grant:r', 'CORP\\alice:F']);
});

test('restrictToUser reports an icacls failure', async () => {
  const run = (_e, _a, _o, cb) => cb(new Error('exit 5'), '', 'Access is denied.');
  await assert.rejects(restrictToUser('x', { platform: 'win32', env: { USERNAME: 'a' }, run }), /Access is denied/);
});

test('restrictToUser does nothing on other platforms', async () => {
  assert.equal(await restrictToUser('x', { platform: 'linux', run: () => assert.fail('must not run') }), false);
});
