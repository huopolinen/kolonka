'use strict';
// Restart, persistence and wait: the model with a fake Session.
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

function makeModel(t, { dir, settings } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-model-'));
  const model = new Model({ dataDir: dir, settings: Object.assign({ defaultShell: 'cmd' }, settings), shells: SHELLS, Session: FakeSession });
  t.after(() => {
    clearTimeout(model._saveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { model, dir };
}

const apiError = (code) => (e) => e instanceof ApiError && e.code === code;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- restart ----------

test('restart: a late exit of the old process does not mark the new session exited', async (t) => {
  const { model, dir } = makeModel(t);
  const old = model.createSession({ cwd: dir });
  const exits = []; const events = []; const data = [];
  model.on('exit', (id, code) => exits.push([id, code]));
  model.on('event', (ev) => events.push(ev.type));
  model.on('data', (id, d) => data.push([id, d]));

  const fresh = model.restartSession(old.id);
  assert.notEqual(fresh, old);
  assert.equal(fresh.id, old.id);
  assert.ok(old.killed);

  // the killed ConPTY reports its exit (and a last bit of output) after the restart
  old.emitData('bye');
  old.emitExit(1);
  await tick(80); // past the closeOnExit delay
  assert.deepEqual(exits, [], 'no exit for the restarted id');
  assert.ok(!events.includes('session.exited'));
  assert.deepEqual(data, []);
  assert.equal(model.sessions.get(old.id), fresh);
  assert.equal(fresh.exited, false);

  // the new session is wired normally
  fresh.emitData('hello');
  assert.deepEqual(data, [[fresh.id, 'hello']]);
});

test('restart with closeOnExit: the old process exiting with 0 does not close the new session', async (t) => {
  const { model, dir } = makeModel(t, { settings: { closeOnExit: true } });
  const old = model.createSession({ cwd: dir });
  model.restartSession(old.id);
  old.emitExit(0);
  await tick(80);
  assert.ok(model.sessions.has(old.id));
});

test('restart runs the session command again', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir, command: 'npm run dev' });
  assert.equal(s.opts.runCommand, true);
  const fresh = model.restartSession(s.id);
  assert.equal(fresh.command, 'npm run dev');
  assert.equal(fresh.opts.runCommand, true);
});

// ---------- persistence ----------

test('the command is saved, restored, and not run on its own at startup', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir, command: 'npm run dev' });
  model.createSession({ cwd: dir });
  model.saveNow();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const sessions = saved.workspaces[0].sessions;
  assert.equal(sessions[0].command, 'npm run dev');
  assert.equal(sessions[1].command, undefined);

  const again = new Model({ dataDir: dir, settings: { defaultShell: 'cmd' }, shells: SHELLS, Session: FakeSession });
  again.load();
  t.after(() => clearTimeout(again._saveTimer));
  const restored = again.sessions.get(s.id);
  assert.equal(restored.command, 'npm run dev');
  assert.equal(restored.opts.runCommand, false, 'restored sessions do not start their command');
  assert.equal(again.restartSession(s.id).opts.runCommand, true, 'Restart does');
});

test('a broken state.json is moved aside, not overwritten', (t) => {
  const { model, dir } = makeModel(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"workspaces": [ {"id": "w1", "sess');
  model.load();
  model.saveNow();
  const bad = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.bad-'));
  assert.equal(bad.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, bad[0]), 'utf8'), '{"workspaces": [ {"id": "w1", "sess');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8')).workspaces), 'a fresh state is written');
  assert.equal(model.workspaces.length, 1);
});

test('state.json that is valid JSON but not a state is moved aside too', (t) => {
  const { model, dir } = makeModel(t);
  fs.writeFileSync(path.join(dir, 'state.json'), '[1, 2, 3]');
  model.load();
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('state.json.bad-')).length, 1);
});

test('counters are taken from the restored ids, not only from the saved counters', (t) => {
  const { model, dir } = makeModel(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, counters: { w: 1, s: 1 },
    workspaces: [{ id: 'w3', name: 'dev', sessions: [{ id: 's7', name: 'a', cwd: dir, shell: 'cmd' }] }],
  }));
  model.load();
  assert.equal(model.createSession({ cwd: dir }).id, 's8');
  assert.equal(model.createWorkspace({ name: 'x' }).id, 'w4');
});

test('a title change does not schedule a save; a cwd change does', (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  model.saveNow();
  s.emit('meta', 'title');
  assert.equal(model._saveTimer, null, 'title: nothing to save');
  s.emit('meta');
  assert.notEqual(model._saveTimer, null, 'cwd: saved');
});

test('a stream of changes does not postpone the save past the max wait', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { model } = makeModel(t);
  let saves = 0;
  const real = model.saveNow.bind(model);
  model.saveNow = () => { saves++; real(); };
  // a change every 300 ms: a plain 500 ms debounce would never fire
  for (let i = 0; i < 10; i++) { model.changed(); t.mock.timers.tick(300); }
  assert.ok(saves >= 1, `saved ${saves} times in 3 s of constant changes`);
});

// ---------- status ----------

test('selecting a done session sets it idle with a session.status event', (t) => {
  const { model, dir } = makeModel(t);
  const a = model.createSession({ cwd: dir });
  model.createSession({ cwd: dir });
  model.updateSession(a.id, { status: 'done' });
  const events = [];
  model.on('event', (ev) => { if (ev.type === 'session.status') events.push(ev); });
  model.selectSession(a.id);
  assert.equal(a.status, 'idle');
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'idle');
  assert.equal(events[0].prev, 'done');
});

// ---------- wait ----------

test('wait since: output that came before the wait call is found', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  const seq = model.type(s.id, 'make\r').seq;
  s.emitData('make\r\nbuild ok\r\n'); // arrives before the client calls wait
  const r = await model.wait(s.id, { pattern: 'build ok', since: seq, timeout: 200 });
  assert.equal(r.matched, 'build ok');
  // without since the same wait only sees new output
  await assert.rejects(model.wait(s.id, { pattern: 'build ok', timeout: 100 }), apiError(408));
});

test('wait skipEcho: the echoed command line does not match', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  const seq = s.seq;
  s.emitData('$ echo kolonka-ok\r\n');
  await assert.rejects(model.wait(s.id, { pattern: 'kolonka-ok', since: seq, skipEcho: true, timeout: 100 }), apiError(408));
  const p = model.wait(s.id, { pattern: 'kolonka-ok', since: seq, skipEcho: true, timeout: 500 });
  s.emitData('kolonka-ok\r\n');
  assert.equal((await p).matched, 'kolonka-ok');
});

test('wait --screen checks the screen while output keeps flowing (throttle, not debounce)', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  s.screen = 'working';
  const flow = setInterval(() => s.emitData('.'), 20);
  t.after(() => clearInterval(flow));
  setTimeout(() => { s.screen = 'working\nREADY'; }, 100);
  const started = Date.now();
  const r = await model.wait(s.id, { pattern: 'READY', screen: true, timeout: 2000 });
  assert.equal(r.matched, 'READY');
  assert.ok(Date.now() - started < 1000, 'matched while the output was still flowing');
});

test('wait: a bad timeout is 400; 0 means no limit', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  for (const timeout of [NaN, -1, 'soon', 1e12, Infinity]) {
    assert.throws(() => model.wait(s.id, { pattern: 'x', timeout }), apiError(400), String(timeout));
  }
  assert.throws(() => model.wait(s.id, { idle: -5 }), apiError(400));
  assert.throws(() => model.wait(s.id, {}), apiError(400));
  const p = model.wait(s.id, { pattern: 'late', timeout: 0 });
  await tick(50);
  s.emitData('late');
  assert.equal((await p).matched, 'late');
});

test('wait: aborting drops the listeners', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  const base = s.listenerCount('data');
  const ac = new AbortController();
  const p = model.wait(s.id, { pattern: 'never', timeout: 0, signal: ac.signal });
  assert.equal(s.listenerCount('data'), base + 1);
  ac.abort();
  await assert.rejects(p, apiError(499));
  assert.equal(s.listenerCount('data'), base);
  assert.equal(s.listenerCount('exit'), 1);
});

test('wait ends with 409 when the session is closed or restarted', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  const p = model.wait(s.id, { pattern: 'never', timeout: 0 });
  model.restartSession(s.id);
  await assert.rejects(p, apiError(409));
});

test('wait results carry the current seq', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  const p = model.wait(s.id, { pattern: 'x' });
  s.emitData('x');
  assert.equal((await p).seq, 1);
});

test('wait: a pattern spanning more than the quick-search window matches soon after the output', async (t) => {
  const { model, dir } = makeModel(t);
  const s = model.createSession({ cwd: dir });
  const p = model.wait(s.id, { pattern: 'BEGIN[\\s\\S]*END', timeout: 2000 });
  s.emitData('BEGIN');
  for (let i = 0; i < 10; i++) s.emitData('x'.repeat(1000)); // a full search runs here: nothing yet
  s.emitData('END'); // too soon for another one: the timer finds it
  const started = Date.now();
  const r = await p;
  assert.match(r.matched, /^BEGINx+END$/);
  assert.ok(Date.now() - started < 1000);
});

// ---------- a shell that does not start ----------

test('a shell that fails to start is an exited session, and Restart starts it again', (t) => {
  const { model, dir } = makeModel(t);
  FakeSession.failNextStart = true;
  const s = model.createSession({ cwd: dir });
  assert.equal(s.exited, true);
  assert.equal(s.exitCode, -1);
  const row = model.tree().workspaces[0].sessions[0];
  assert.equal(row.exited, true, 'the window learns it from the state (also after a reload)');
  assert.equal(row.exitCode, -1);
  // Enter in an exited tab sends session.restart
  const fresh = model.restartSession(s.id);
  assert.equal(fresh.exited, false);
  assert.equal(model.tree().workspaces[0].sessions[0].exited, false);
});

// ---------- state.json that cannot be read ----------

test('state.json that cannot be read (EBUSY) is not overwritten until it can be read; then a copy is kept', (t) => {
  const { model, dir } = makeModel(t);
  const file = path.join(dir, 'state.json');
  const saved = JSON.stringify({ version: 1, counters: { w: 1, s: 1 }, workspaces: [{ id: 'w1', name: 'mine', sessions: [] }] });
  fs.writeFileSync(file, saved);
  let busy = true;
  let reads = 0;
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (p === file && busy) { reads++; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }
    return real.call(this, p, ...rest);
  });
  model.load();
  assert.ok(reads >= 2, 'the read is retried');
  assert.equal(model.workspaces[0].name, 'main', 'starts with a fresh layout');
  model.saveNow();
  assert.equal(real(file, 'utf8'), saved, 'the unreadable file is left alone');
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('state.json.bad-')), false, 'not treated as broken');

  busy = false;
  model.saveNow();
  const copies = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.unread-'));
  assert.equal(copies.length, 1);
  assert.equal(real(path.join(dir, copies[0]), 'utf8'), saved, 'the old layout is kept');
  assert.equal(JSON.parse(real(file, 'utf8')).workspaces[0].name, 'main', 'saving works again');
});

// ---------- shutdown ----------

test('shutdown: the saved tabs stay as they were, even when the killed shells close themselves (closeOnExit)', async (t) => {
  const { model, dir } = makeModel(t, { settings: { closeOnExit: true } });
  const a = model.createSession({ cwd: dir, name: 'keep-a' });
  const b = model.createSession({ cwd: dir, name: 'keep-b', command: 'ssh host', rerun: true });
  model.shutdown(); // a quit or "Restart to update"
  const names = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).workspaces.flatMap((w) => w.sessions.map((s) => [s.name, !!s.rerun]));
  assert.deepEqual(names(), [['keep-a', false], ['keep-b', true]]);
  // the killed shells report exit 0 while the process is still quitting
  a.emitExit(0);
  b.emitExit(0);
  await tick(700); // past the closeOnExit delay and the save debounce
  assert.deepEqual(names(), [['keep-a', false], ['keep-b', true]], 'the tabs (and rerun) come back on the next start');
});
