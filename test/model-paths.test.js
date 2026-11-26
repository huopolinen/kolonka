'use strict';
// The model never touches a UNC path: not from the API, not from state.json, not on restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Model, ApiError } = require('../src/main/model');
const { homeDir } = require('../src/main/shells');
const { FakeSession } = require('./helpers/fake-session');

const SHELLS = { cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [], env: {} } };
const UNC = '\\\\attacker.example\\share';

function makeModel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-model-'));
  const model = new Model({ dataDir: dir, settings: { defaultShell: 'cmd' }, shells: SHELLS, Session: FakeSession });
  t.after(() => {
    clearTimeout(model._saveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { model, dir };
}

// Record every path fs.statSync is asked about during the test.
function statSpy(t) {
  const calls = [];
  const orig = fs.statSync;
  fs.statSync = (p, ...a) => { calls.push(String(p)); return orig(p, ...a); };
  t.after(() => { fs.statSync = orig; });
  return calls;
}
const touchedUnc = (calls) => calls.filter((p) => p.startsWith('\\\\') || p.startsWith('//'));

test('createSession with a UNC cwd is 400 and never stats it', (t) => {
  const { model } = makeModel(t);
  const calls = statSpy(t);
  assert.throws(() => model.createSession({ cwd: UNC }), (e) => e instanceof ApiError && e.code === 400);
  assert.deepEqual(touchedUnc(calls), []);
});

test('load drops a UNC cwd from state.json without touching it', (t) => {
  const { model, dir } = makeModel(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, counters: { w: 1, s: 2 }, activeId: 's1',
    workspaces: [{ id: 'w1', name: 'main', sessions: [{ id: 's1', name: 'a', cwd: UNC, shell: 'cmd' }, { id: 's2', name: 'b', cwd: dir, shell: 'cmd' }] }],
  }));
  const calls = statSpy(t);
  model.load();
  assert.equal(model.sessions.get('s1').cwd, homeDir);
  assert.equal(model.sessions.get('s2').cwd, dir);
  assert.deepEqual(touchedUnc(calls), []);
});

test('a new session does not inherit a UNC cwd from the active one', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  s.cwd = UNC; // as if set from terminal output by an older version
  const calls = statSpy(t);
  const next = model.createSession({ workspace: s.workspaceId });
  assert.notEqual(next.cwd, UNC);
  assert.deepEqual(touchedUnc(calls), []);
});

test('restart falls back to home for a UNC cwd without touching it', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  s.cwd = UNC;
  const calls = statSpy(t);
  const r = model.restartSession(s.id);
  assert.equal(r.cwd, homeDir);
  assert.deepEqual(touchedUnc(calls), []);
});
