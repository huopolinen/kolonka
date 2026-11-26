'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Model, ApiError } = require('../src/main/model');
const { FakeSession } = require('./helpers/fake-session');

const SHELLS = {
  cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [], env: {} },
  powershell: { label: 'Windows PowerShell', file: 'powershell.exe', args: [], env: {} },
};

// A model with a fake Session class and its own data directory; closed after the test.
function makeModel(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-model-'));
  const model = new Model({ dataDir: dir, settings: { defaultShell: 'cmd' }, shells: SHELLS, Session: FakeSession });
  t.after(() => {
    clearTimeout(model._saveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { model, dir };
}

const apiError = (code) => (e) => e instanceof ApiError && e.code === code;

// Two workspaces: dev (s1 "api", s2 "web") and ops (s3 "api", s4 "logs").
function populate(model, cwd) {
  const dev = model.createWorkspace({ name: 'dev' });
  const ops = model.createWorkspace({ name: 'ops' });
  model.createSession({ workspace: dev.id, name: 'api', cwd });
  model.createSession({ workspace: dev.id, name: 'web', cwd });
  model.createSession({ workspace: ops.id, name: 'api', cwd });
  model.createSession({ workspace: ops.id, name: 'logs', cwd, select: false });
  return { dev, ops };
}

test('the model uses the injected Session class', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ name: 'one', cwd: dir });
  assert.ok(s instanceof FakeSession);
  assert.equal(s.opts.shell, SHELLS.cmd);
  assert.equal(s.shellKey, 'cmd');
  assert.equal(model.workspaces.length, 1, 'a workspace is created on demand');
  assert.equal(model.activeId, s.id);
});

test('resolveSession by id', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  assert.equal(model.resolveSession('s2').name, 'web');
});

test('resolveSession by a unique name, case-insensitive', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  assert.equal(model.resolveSession('web').id, 's2');
  assert.equal(model.resolveSession('LOGS').id, 's4');
});

test('resolveSession by workspace/name', (t) => {
  const { model, dir } = makeModel(t);
  const { ops } = populate(model, dir);
  assert.equal(model.resolveSession('dev/api').id, 's1');
  assert.equal(model.resolveSession('ops/api').id, 's3');
  assert.equal(model.resolveSession(`${ops.id}/api`).id, 's3');
});

test('resolveSession by 1-based position across workspaces', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  assert.equal(model.resolveSession('1').id, 's1');
  assert.equal(model.resolveSession('3').id, 's3');
  assert.equal(model.resolveSession(4).id, 's4');
});

test('resolveSession "current" is the active session', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  assert.equal(model.activeId, 's3', 'the last created session with select is active');
  for (const target of ['current', '.', '', undefined, null]) assert.equal(model.resolveSession(target).id, 's3');
  model.selectSession('s1');
  assert.equal(model.resolveSession('current').id, 's1');
});

test('resolveSession: an ambiguous name is 409', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  assert.throws(() => model.resolveSession('api'), apiError(409));
});

test('resolveSession: unknown targets are 404', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  assert.throws(() => model.resolveSession('nope'), apiError(404));
  assert.throws(() => model.resolveSession('s99'), apiError(404));
  assert.throws(() => model.resolveSession('9'), apiError(404));
  assert.throws(() => model.resolveSession('dev/logs'), apiError(404));
});

test('resolveSession: no active session is 404', (t) => {
  const { model } = makeModel(t);
  assert.throws(() => model.resolveSession('current'), apiError(404));
});

test('resolveWorkspace by id, name and position; ambiguity is 409', (t) => {
  const { model, dir } = makeModel(t);
  const { dev, ops } = populate(model, dir);
  assert.equal(model.resolveWorkspace(dev.id), dev);
  assert.equal(model.resolveWorkspace('OPS'), ops);
  assert.equal(model.resolveWorkspace('2'), ops);
  assert.throws(() => model.resolveWorkspace('nope'), apiError(404));
  model.createWorkspace({ name: 'dev' });
  assert.throws(() => model.resolveWorkspace('dev'), apiError(409));
});

test('createSession with a missing directory is 400', (t) => {
  const { model, dir } = makeModel(t);
  assert.throws(() => model.createSession({ cwd: path.join(dir, 'does-not-exist') }), apiError(400));
  assert.equal(model.sessions.size, 0);
});

test('createSession with an unknown shell is 400', (t) => {
  const { model, dir } = makeModel(t);
  assert.throws(() => model.createSession({ cwd: dir, shell: 'zsh' }), apiError(400));
});

test('createSession places the session after another one', (t) => {
  const { model, dir } = makeModel(t);
  const { dev } = populate(model, dir);
  const s = model.createSession({ workspace: 'dev', name: 'mid', cwd: dir, after: 's1' });
  assert.deepEqual(dev.sessionIds, ['s1', s.id, 's2']);
});

test('createSession names sessions automatically', (t) => {
  const { model, dir } = makeModel(t);
  assert.equal(model.createSession({ cwd: dir }).name, 'shell 1');
  assert.equal(model.createSession({ cwd: dir }).name, 'shell 2');
  assert.equal(model.createSession({ cwd: dir, command: 'C:\\tools\\htop.exe -d 5' }).name, 'htop.exe');
});

test('deleteWorkspace with sessions needs force', (t) => {
  const { model, dir } = makeModel(t);
  const { dev } = populate(model, dir);
  assert.throws(() => model.deleteWorkspace('dev'), apiError(409));
  assert.ok(model.ws(dev.id), 'the workspace is still there');
  assert.equal(model.sessions.size, 4);
});

test('deleteWorkspace with force closes its sessions', (t) => {
  const { model, dir } = makeModel(t);
  const { dev } = populate(model, dir);
  const s1 = model.sessions.get('s1');
  assert.deepEqual(model.deleteWorkspace('dev', { force: true }), { ok: true });
  assert.equal(model.ws(dev.id), undefined);
  assert.ok(s1.killed);
  assert.deepEqual([...model.sessions.keys()], ['s3', 's4']);
});

test('deleteWorkspace of an empty workspace needs no force', (t) => {
  const { model } = makeModel(t);
  const ws = model.createWorkspace({ name: 'empty' });
  model.createWorkspace({ name: 'other' });
  assert.deepEqual(model.deleteWorkspace(ws.id), { ok: true });
  assert.deepEqual(model.workspaces.map((w) => w.name), ['other']);
});

test('updateSession validates the status', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  model.updateSession('s1', { status: 'blocked' });
  assert.equal(model.sessions.get('s1').status, 'blocked');
  assert.throws(() => model.updateSession('s1', { status: 'sleeping' }), apiError(400));
});

test('closeSession moves the selection to a neighbour', (t) => {
  const { model, dir } = makeModel(t);
  populate(model, dir);
  model.selectSession('s2');
  model.closeSession('s2');
  assert.equal(model.sessions.has('s2'), false);
  assert.equal(model.activeId, 's3');
});

test('type into an exited session is 409', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  model.type(s.id, 'dir\r');
  assert.deepEqual(s.written, ['dir\r']);
  s.exited = true;
  assert.throws(() => model.type(s.id, 'x'), apiError(409));
});
