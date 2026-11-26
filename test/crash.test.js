'use strict';
// crash.js runs in Electron; here `electron` is replaced with a stub that records what it is asked to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const calls = [];
const electron = {
  app: { isReady: () => true, isPackaged: true, exit: (code) => calls.push(['exit', code]), getLocale: () => 'en', on: () => {}, getPath: () => os.tmpdir() },
  dialog: { showMessageBoxSync: () => 2, showMessageBox: async () => ({ response: 2 }) }, // "Quit"
  shell: { openExternal: (url) => calls.push(['openExternal', url]), openPath: () => {} },
  crashReporter: { start: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : origLoad.call(this, request, ...rest); };
const { Crash } = require('../src/main/crash');
Module._load = origLoad;

function makeCrash(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  calls.length = 0;
  return new Crash(Object.assign({ dataDir: dir, pkg: { name: 'kolonka', version: '0.0.0' }, t: (k) => k, getWin: () => null }, opts));
}

test('a problem report never contains the API token or API keys', (t) => {
  const token = 'Zx9-localApiToken_123456';
  const key = 'my-groq-key-without-prefix-0123';
  const crash = makeCrash(t, { secrets: () => [token, key] });
  crash.log('error', `request failed with ${token}; dictation key ${key}`);
  const url = crash.report({ title: 'x', error: `boom ${token} ${key}` });
  const body = decodeURIComponent(url.replace(/\+/g, ' '));
  assert.doesNotMatch(body, new RegExp(token));
  assert.doesNotMatch(body, new RegExp(key));
  assert.match(body, /<redacted>/);
});

test('a failing secrets callback does not stop the report', (t) => {
  const crash = makeCrash(t, { secrets: () => { throw new Error('not ready'); } });
  assert.doesNotThrow(() => crash.report({ title: 'x' }));
});

test('quitting after a fatal error runs beforeExit first', (t) => {
  const crash = makeCrash(t, { beforeExit: () => calls.push(['beforeExit']) });
  crash.fatal(new Error('boom'));
  assert.deepEqual(calls, [['beforeExit'], ['exit', 1]]);
});

test('a throwing beforeExit still lets the app exit', (t) => {
  const crash = makeCrash(t, { beforeExit: () => { throw new Error('nope'); } });
  crash.fatal(new Error('boom'));
  assert.deepEqual(calls, [['exit', 1]]);
});
