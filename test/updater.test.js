'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Updater } = require('../src/main/updater');
const P = require('../src/shared/update-policy');

// A stand-in for electron-updater's autoUpdater: each call is recorded, results are set per test.
function fakeAutoUpdater() {
  const u = new EventEmitter();
  u.calls = [];
  u.feed = null;
  u.checkResult = () => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } });
  u.downloadResult = () => Promise.resolve(['C:\\cache\\Kolonka-Setup-0.3.0.exe']);
  u.setFeedURL = (f) => { u.feed = f; u.calls.push('feed'); };
  u.checkForUpdates = () => { u.calls.push('check'); return u.checkResult(); };
  u.downloadUpdate = () => { u.calls.push('download'); return u.downloadResult(); };
  u.quitAndInstall = (silent, runAfter) => { u.calls.push(`quitAndInstall(${silent},${runAfter})`); };
  return u;
}

// Timers the test fires by hand.
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    fire() { const h = pending.shift(); h.fn(); return h.ms; },
  };
}

function make(opts = {}) {
  const u = fakeAutoUpdater();
  const timers = fakeTimers();
  const logs = [];
  let loaded = 0;
  const up = new Updater(Object.assign({
    mode: 'auto', version: '0.2.0', isPackaged: true, env: {}, isolated: false, timers,
    log: (level, msg) => logs.push(`${level} ${msg}`),
    load: () => { loaded++; return u; },
  }, opts));
  const states = [];
  const failures = [];
  up.on('state', (s) => states.push(s.phase));
  up.on('download-failed', (f) => failures.push(f));
  return { up, u, timers, logs, states, failures, loaded: () => loaded };
}

const tick = () => new Promise((r) => setImmediate(r));

test('auto: the first check runs 30 s after start, then every 6 hours; the update is downloaded and installs on quit', async () => {
  const { up, u, timers, logs, states } = make();
  up.start();
  assert.deepEqual(u.feed, { provider: 'github', owner: 'huopolinen', repo: 'kolonka' });
  assert.equal(u.autoDownload, false);
  assert.equal(u.autoInstallOnAppQuit, true);
  assert.equal(u.allowPrerelease, false);
  assert.equal(u.allowDowngrade, false);
  assert.equal(u.verifyUpdateCodeSignature, undefined, 'no signature check until the installer is signed');
  assert.deepEqual(u.calls, ['feed'], 'nothing is fetched at start');
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.fire(), P.CHECK_DELAY_MS);
  await tick(); await tick(); await tick();
  assert.deepEqual(u.calls, ['feed', 'check', 'download']);
  assert.equal(up.state().phase, 'downloaded');
  assert.equal(up.state().version, '0.3.0');
  assert.deepEqual(states, ['checking', 'available', 'downloading', 'downloaded']);
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, P.CHECK_EVERY_MS);
  assert.ok(logs.some((l) => /updates: auto, current version 0\.2\.0, feed github\.com\/huopolinen\/kolonka/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /update check: 0\.3\.0 is available/.test(l)));
  assert.ok(logs.some((l) => /update 0\.3\.0 downloaded, sha512 matches/.test(l)));
});

test('notify: the new version is shown, downloaded only on request, and not installed on quit', async () => {
  const { up, u } = make({ mode: 'notify' });
  up.start();
  assert.equal(u.autoInstallOnAppQuit, false);
  const r = await up.check({ manual: true });
  assert.deepEqual(r, { ok: true, available: true, version: '0.3.0', phase: 'available' });
  assert.deepEqual(u.calls, ['feed', 'check'], 'no download without the button');
  assert.equal(P.bar(up.state()).kind, 'available');
  assert.deepEqual(await up.download({ manual: true }), { ok: true });
  assert.deepEqual(u.calls, ['feed', 'check', 'download']);
  assert.equal(P.bar(up.state()).kind, 'ready');
});

test('off, a dev build, KOLONKA_NO_UPDATE and an isolated instance never load electron-updater', async () => {
  for (const o of [{ mode: 'off' }, { isPackaged: false }, { env: { KOLONKA_NO_UPDATE: '1' } }, { isolated: true }]) {
    const { up, timers, loaded, logs } = make(o);
    up.start();
    assert.equal(loaded(), 0, JSON.stringify(o));
    assert.equal(timers.pending.length, 0);
    assert.equal(up.state().phase, 'off');
    const r = await up.check({ manual: true });
    assert.equal(r.ok, false);
    assert.ok(r.off);
    assert.ok(logs.some((l) => /^info updates: off \(/.test(l)));
  }
});

test('nothing new: idle, and the result says up to date rather than unknown', async () => {
  const { up, u } = make();
  up.start();
  u.checkResult = () => Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '0.2.0' } });
  assert.deepEqual(await up.check({ manual: true }), { ok: true, available: false, version: '0.2.0' });
  assert.equal(up.state().phase, 'idle');
  assert.ok(!u.calls.includes('download'));
});

test('a failed background check is only logged; the user gets the error when they asked', async () => {
  const { up, u, failures, logs } = make();
  up.start();
  u.checkResult = () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED\n  at stack'));
  const bg = await up.check({ manual: false });
  assert.deepEqual(bg, { ok: false, error: 'net::ERR_INTERNET_DISCONNECTED' });
  assert.equal(up.state().phase, 'idle');
  assert.deepEqual(failures, [], 'no toast for a check');
  assert.ok(logs.some((l) => /^warn update check failed \(background\): net::ERR_INTERNET_DISCONNECTED$/.test(l)));
  const manual = await up.check({ manual: true });
  assert.equal(manual.ok, false);
  assert.equal(manual.error, 'net::ERR_INTERNET_DISCONNECTED', 'the window shows it');
});

test('electron-updater answering null is a failed check, not "up to date"', async () => {
  const { up, u } = make();
  up.start();
  u.checkResult = () => Promise.resolve(null);
  const r = await up.check({ manual: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not check/);
});

test('a failed check keeps a version found earlier', async () => {
  const { up, u } = make({ mode: 'notify' });
  up.start();
  await up.check();
  u.checkResult = () => Promise.reject(new Error('offline'));
  await up.check();
  assert.equal(up.state().phase, 'available');
  assert.equal(up.state().version, '0.3.0');
});

test('a failed download or integrity check is reported and the update can be downloaded again', async () => {
  const { up, u, failures, logs } = make({ mode: 'notify' });
  up.start();
  await up.check();
  u.downloadResult = () => Promise.reject(Object.assign(new Error('sha512 checksum mismatch, expected abc, got def'), { code: 'ERR_CHECKSUM_MISMATCH' }));
  const r = await up.download({ manual: true });
  assert.equal(r.ok, false);
  assert.equal(r.checksum, true);
  assert.deepEqual(failures, [{ message: 'sha512 checksum mismatch, expected abc, got def', checksum: true }]);
  assert.equal(up.state().phase, 'available', 'the Download button is back');
  assert.ok(logs.some((l) => /^error update 0\.3\.0 download failed \(integrity check\)/.test(l)));
  u.downloadResult = () => Promise.reject(new Error('socket hang up'));
  await up.download();
  assert.deepEqual(failures[1], { message: 'socket hang up', checksum: false });
  u.downloadResult = () => Promise.resolve(['x.exe']);
  assert.deepEqual(await up.download(), { ok: true });
  assert.equal(up.state().phase, 'downloaded');
});

test('a background download in auto mode that fails is reported too', async () => {
  const { up, u, timers, failures } = make();
  up.start();
  u.downloadResult = () => Promise.reject(new Error('ECONNRESET'));
  timers.fire();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(failures.length, 1);
  assert.equal(up.state().phase, 'available');
});

test('repeated clicks: one check, one download, one installer', async () => {
  const { up, u } = make({ mode: 'notify' });
  up.start();
  let release;
  u.checkResult = () => new Promise((r) => { release = () => r({ isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }); });
  const a = up.check({ manual: true });
  const b = up.check({ manual: true });
  assert.equal(a, b, 'the same check');
  release();
  await a;
  let done;
  u.downloadResult = () => new Promise((r) => { done = () => r(['x.exe']); });
  const d1 = up.download();
  const d2 = up.download();
  assert.equal(d1, d2);
  await tick();
  done();
  await d1;
  assert.deepEqual(u.calls.filter((c) => c === 'check').length, 1);
  assert.deepEqual(u.calls.filter((c) => c === 'download').length, 1);
  // a check while the update waits for a restart does not fetch again
  assert.equal((await up.check({ manual: true })).phase, 'downloaded');
  assert.equal(u.calls.filter((c) => c === 'check').length, 1);
  let saved = 0;
  assert.equal(up.installNow({ beforeQuit: () => saved++ }), true);
  assert.equal(up.installNow({ beforeQuit: () => saved++ }), false);
  assert.equal(saved, 1);
  assert.deepEqual(u.calls.filter((c) => c.startsWith('quitAndInstall')), ['quitAndInstall(true,true)']);
});

test('installNow: the state is saved and the shells stopped before the installer starts, silently and with a restart', async () => {
  const { up, u, timers } = make();
  up.start();
  const order = [];
  u.quitAndInstall = (silent, runAfter) => order.push(`install silent=${silent} runAfter=${runAfter}`);
  assert.equal(up.installNow({ beforeQuit: () => order.push('shutdown') }), false, 'nothing downloaded yet');
  await up.check();
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(up.state().phase, 'downloaded');
  assert.equal(up.installNow({ beforeQuit: () => order.push('shutdown') }), true);
  assert.deepEqual(order, ['shutdown', 'install silent=true runAfter=true']);
  assert.equal(timers.pending.length, 0, 'no more checks once installing');
});

test('an error event from electron-updater is logged, not thrown', () => {
  const { up, u, logs } = make();
  up.start();
  u.emit('error', new Error('boom'));
  assert.ok(logs.some((l) => /updater error: boom/.test(l)));
});

test('the test feed replaces GitHub only on loopback', () => {
  const ok = make({ env: { KOLONKA_UPDATE_TEST_FEED: 'http://127.0.0.1:5555' } });
  ok.up.start();
  assert.deepEqual(ok.u.feed, { provider: 'generic', url: 'http://127.0.0.1:5555/' });
  const bad = make({ env: { KOLONKA_UPDATE_TEST_FEED: 'http://evil.example/' } });
  bad.up.start();
  assert.deepEqual(bad.u.feed, P.FEED);
  assert.ok(bad.logs.some((l) => /^warn KOLONKA_UPDATE_TEST_FEED ignored/.test(l)));
});

test('download progress reaches the window in whole percents', async () => {
  const { up, u } = make({ mode: 'notify' });
  up.start();
  await up.check();
  const seen = [];
  up.on('state', (s) => seen.push(s.percent));
  let done;
  u.downloadResult = () => new Promise((r) => { done = r; });
  const d = up.download();
  await tick();
  u.emit('download-progress', { percent: 10.2 });
  u.emit('download-progress', { percent: 10.9 });
  u.emit('download-progress', { percent: 55.5 });
  done(['x.exe']);
  await d;
  assert.deepEqual(seen, [0, 10, 55, 100]);
});
