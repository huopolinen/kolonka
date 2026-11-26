'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/shared/update-policy');
const pkg = require('../package.json');
const { DEFAULT_SETTINGS, TEMPLATE } = require('../src/main/settings');

test('"updates" defaults to auto; an unknown value is read as notify, with a warning', () => {
  assert.deepEqual(P.parseMode(undefined), { mode: 'auto', warning: null });
  assert.equal(P.parseMode(DEFAULT_SETTINGS.updates).mode, 'auto');
  for (const m of ['auto', 'notify', 'off']) assert.deepEqual(P.parseMode(m), { mode: m, warning: null });
  const odd = P.parseMode('of');
  assert.equal(odd.mode, 'notify', 'a typo never installs anything on its own');
  assert.match(odd.warning, /"updates" must be one of auto, notify, off/);
  assert.equal(P.parseMode(false).mode, 'notify');
  assert.match(TEMPLATE, /\/\/ "updates": "auto",/, 'the settings.json template mentions the option');
});

test('only a packaged build of the main instance checks, and KOLONKA_NO_UPDATE turns it off', () => {
  const run = (o) => P.shouldRun(Object.assign({ isPackaged: true, mode: 'auto', env: {}, isolated: false }, o));
  assert.deepEqual(run({}), { on: true, reason: null });
  assert.deepEqual(run({ mode: 'notify' }), { on: true, reason: null });
  assert.deepEqual(run({ isPackaged: false }), { on: false, reason: 'dev' });
  assert.deepEqual(run({ mode: 'off' }), { on: false, reason: 'setting' });
  assert.deepEqual(run({ env: { KOLONKA_NO_UPDATE: '1' } }), { on: false, reason: 'env' });
  assert.deepEqual(run({ env: { KOLONKA_NO_UPDATE: '0' } }), { on: true, reason: null });
  assert.deepEqual(run({ isolated: true }), { on: false, reason: 'isolated' });
  assert.deepEqual(run({ isolated: true, testFeed: { provider: 'generic' } }), { on: true, reason: null });
  assert.deepEqual(run({ isPackaged: false, testFeed: { provider: 'generic' } }), { on: false, reason: 'dev' }, 'never in development');
});

test('the feed is this repository on GitHub, as in package.json', () => {
  assert.deepEqual({ ...P.FEED }, { provider: 'github', owner: 'huopolinen', repo: 'kolonka' });
  assert.ok(Object.isFrozen(P.FEED));
  assert.equal(pkg.repository.url, `https://github.com/${P.FEED.owner}/${P.FEED.repo}.git`);
  assert.deepEqual(pkg.build.publish.map((p) => p.provider), ['github'], 'latest.yml and app-update.yml come from the GitHub publisher');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater is a runtime dependency, packaged with the app');
});

test('the test feed accepts only a loopback address', () => {
  assert.deepEqual(P.testFeed(''), { feed: null, error: null });
  assert.deepEqual(P.testFeed(undefined), { feed: null, error: null });
  assert.deepEqual(P.testFeed('http://127.0.0.1:8123'), { feed: { provider: 'generic', url: 'http://127.0.0.1:8123/' }, error: null });
  assert.equal(P.testFeed('http://localhost:9/feed/').feed.url, 'http://localhost:9/feed/');
  assert.equal(P.testFeed('http://[::1]:9/').feed.provider, 'generic');
  for (const bad of ['http://example.com/', 'https://127.0.0.1.evil.com/', 'file:///C:/feed/', 'ftp://127.0.0.1/', 'not a url']) {
    const r = P.testFeed(bad);
    assert.equal(r.feed, null, bad);
    assert.ok(r.error, bad);
  }
});

test('a new version is downloaded in auto mode and only shown in notify mode; only auto installs on quit', () => {
  assert.equal(P.onAvailable('auto'), 'download');
  assert.equal(P.onAvailable('notify'), 'show');
  assert.equal(P.installOnQuit('auto'), true);
  assert.equal(P.installOnQuit('notify'), false);
  assert.equal(P.installOnQuit('off'), false);
});

test('the sidebar bar: available → progress → restart; a background download in auto mode stays hidden', () => {
  const st = (o) => Object.assign({ mode: 'notify', version: '0.3.0', percent: 0, manual: false }, o);
  assert.equal(P.bar(null), null);
  for (const phase of ['off', 'idle', 'checking']) assert.equal(P.bar(st({ phase })), null, phase);
  assert.deepEqual(P.bar(st({ phase: 'available' })), { kind: 'available', version: '0.3.0' });
  assert.deepEqual(P.bar(st({ phase: 'downloading', percent: 41.7 })), { kind: 'downloading', version: '0.3.0', percent: 41 });
  assert.equal(P.bar(st({ phase: 'downloading', percent: 140 })).percent, 100);
  assert.equal(P.bar(st({ phase: 'downloading', mode: 'auto' })), null, 'auto downloads quietly');
  assert.equal(P.bar(st({ phase: 'downloading', mode: 'auto', manual: true })).kind, 'downloading', 'unless the user asked');
  assert.deepEqual(P.bar(st({ phase: 'downloaded', mode: 'auto' })), { kind: 'ready', version: '0.3.0' });
  assert.equal(P.bar(st({ phase: 'available', mode: 'auto' })).kind, 'available', 'after a failed background download the user can retry');
});

test('"Restart to update" asks first when sessions are working or waiting for the user', () => {
  const ready = { phase: 'downloaded', mode: 'auto', version: '0.3.0' };
  const s = (status, exited = false) => ({ status, exited });
  assert.deepEqual(P.restartPlan(ready, []), { action: 'install', busy: 0 });
  assert.deepEqual(P.restartPlan(ready, [s('idle'), s('done')]), { action: 'install', busy: 0 });
  assert.deepEqual(P.restartPlan(ready, [s('active')]), { action: 'confirm', busy: 1 });
  assert.deepEqual(P.restartPlan(ready, [s('blocked'), s('active'), s('idle')]), { action: 'confirm', busy: 2 });
  assert.deepEqual(P.restartPlan(ready, [s('active', true), s('blocked', true)]), { action: 'install', busy: 0 }, 'an exited shell has nothing to lose');
  assert.deepEqual(P.restartPlan(Object.assign({}, ready, { mode: 'notify' }), [s('active')]), { action: 'confirm', busy: 1 });
  for (const phase of ['off', 'idle', 'checking', 'available', 'downloading']) {
    assert.deepEqual(P.restartPlan({ phase, mode: 'auto' }, [s('active')]), { action: 'none', busy: 0 }, phase);
  }
  assert.deepEqual(P.restartPlan(null, []), { action: 'none', busy: 0 });
});

test('checks run 30 s after start and every 6 hours', () => {
  assert.equal(P.CHECK_DELAY_MS, 30000);
  assert.equal(P.CHECK_EVERY_MS, 6 * 3600 * 1000);
});
