'use strict';
// The HTTP API over a model with fake sessions: port fallback, errors, seq/since, cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startApi } = require('../src/main/api');
const { Model } = require('../src/main/model');
const { FakeSession } = require('./helpers/fake-session');

const SHELLS = { cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [], env: {} } };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-api-'));
  const model = new Model({ dataDir: dir, settings: { defaultShell: 'cmd' }, shells: SHELLS, Session: FakeSession });
  t.after(() => { clearTimeout(model._saveTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, model };
}

async function start(t, opts) {
  const { dir, model } = setup(t);
  const api = await startApi(Object.assign({ model, dataDir: dir, port: 0, hooks: { version: 'test', focus() {}, notify() {} } }, opts));
  t.after(() => new Promise((r) => { api.server.closeAllConnections?.(); api.server.close(() => r()); }));
  return { api, model, dir };
}

function call(api, method, url, body, { raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(api.url + url, {
      method,
      headers: Object.assign({ authorization: 'Bearer ' + api.token }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    }, (res) => {
      if (raw) return resolve({ req, res });
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
    if (raw === 'req') resolve({ req });
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- listening ----------

test('a busy port falls back to a random one', async (t) => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => blocker.close());
  const busy = blocker.address().port;
  const { api } = await start(t, { port: busy });
  assert.notEqual(api.port, busy);
  assert.ok(api.port > 0);
});

test('any listen error on the configured port (EACCES) falls back to a random port', { timeout: 5000 }, async (t) => {
  const orig = http.Server.prototype.listen;
  t.after(() => { http.Server.prototype.listen = orig; });
  http.Server.prototype.listen = function (port, ...rest) {
    if (port !== 0) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
      return this;
    }
    return orig.call(this, port, ...rest);
  };
  const { api } = await start(t, { port: 1 });
  assert.ok(api.port > 1);
  const control = JSON.parse(fs.readFileSync(api.controlFile, 'utf8'));
  assert.equal(control.port, api.port);
});

test('when the random port fails too, startApi rejects instead of hanging', { timeout: 5000 }, async (t) => {
  const orig = http.Server.prototype.listen;
  t.after(() => { http.Server.prototype.listen = orig; });
  http.Server.prototype.listen = function () {
    process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
    return this;
  };
  const { dir, model } = setup(t);
  await assert.rejects(startApi({ model, dataDir: dir, port: 47000, hooks: {} }), /EACCES/);
});

test('an invalid configured port falls back to a random one', { timeout: 5000 }, async (t) => {
  const { api } = await start(t, { port: 99999 });
  assert.ok(api.port > 0 && api.port < 65536);
});

// ---------- errors ----------

test('a malformed %-escape in the path is 400, not 500', async (t) => {
  const { api } = await start(t);
  const r = await call(api, 'GET', '/api/sessions/%E0%A4%A');
  assert.equal(r.status, 400);
});

test('alt+ctrl+x is an unknown key: 400', async (t) => {
  const { api, model, dir } = await start(t);
  model.createSession({ cwd: dir });
  const r = await call(api, 'POST', '/api/sessions/current/keys', { keys: ['alt+ctrl+x'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown key/);
});

// ---------- type / wait ----------

test('type returns the seq; wait since that seq sees output that came in between', async (t) => {
  const { api, model, dir } = await start(t);
  const s = model.createSession({ cwd: dir });
  s.emitData('$ ');
  const typed = await call(api, 'POST', `/api/sessions/${s.id}/type`, { text: 'echo hi', enter: true });
  assert.equal(typed.status, 200);
  assert.equal(typed.body.seq, 1);
  s.emitData('echo hi\r\nhi\r\n'); // before the wait request
  const r = await call(api, 'POST', `/api/sessions/${s.id}/wait`, { pattern: '^hi', since: typed.body.seq, skipEcho: true, timeout: 1000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.matched, 'hi');
});

test('keys returns the seq', async (t) => {
  const { api, model, dir } = await start(t);
  const s = model.createSession({ cwd: dir });
  s.emitData('x'); s.emitData('y');
  const r = await call(api, 'POST', `/api/sessions/${s.id}/keys`, { keys: ['ctrl+c'] });
  assert.equal(r.body.seq, 2);
});

test('wait with timeout NaN-like values is 400', async (t) => {
  const { api, model, dir } = await start(t);
  const s = model.createSession({ cwd: dir });
  const r = await call(api, 'POST', `/api/sessions/${s.id}/wait`, { pattern: 'x', timeout: 'soon' });
  assert.equal(r.status, 400);
});

test('a client that disconnects during wait leaves no listeners behind', async (t) => {
  const { api, model, dir } = await start(t);
  const s = model.createSession({ cwd: dir });
  const base = s.listenerCount('data');
  const { req } = await call(api, 'POST', `/api/sessions/${s.id}/wait`, { pattern: 'never', timeout: 0 }, { raw: 'req' });
  req.on('error', () => {});
  for (let i = 0; i < 50 && s.listenerCount('data') === base; i++) await tick(10);
  assert.equal(s.listenerCount('data'), base + 1, 'the wait is listening');
  req.destroy();
  for (let i = 0; i < 50 && s.listenerCount('data') !== base; i++) await tick(10);
  assert.equal(s.listenerCount('data'), base);
});

// ---------- streams ----------

test('the output stream of a session ends when the session is closed', { timeout: 5000 }, async (t) => {
  const { api, model, dir } = await start(t);
  const s = model.createSession({ cwd: dir });
  model.createSession({ cwd: dir });
  const { res } = await call(api, 'GET', `/api/sessions/${s.id}/stream`, undefined, { raw: true });
  let got = '';
  res.setEncoding('utf8');
  res.on('data', (d) => { got += d; });
  const ended = new Promise((r) => res.on('end', r));
  s.emitData('hello');
  await tick(20);
  model.closeSession(s.id);
  await ended;
  assert.match(got, /data: "hello"/);
});

test('the output stream survives a restart of the session', async (t) => {
  const { api, model, dir } = await start(t);
  const s = model.createSession({ cwd: dir });
  const { res, req } = await call(api, 'GET', `/api/sessions/${s.id}/stream`, undefined, { raw: true });
  let got = ''; let ended = false;
  res.setEncoding('utf8');
  res.on('data', (d) => { got += d; });
  res.on('end', () => { ended = true; });
  const fresh = model.restartSession(s.id);
  fresh.emitData('after restart');
  await tick(30);
  assert.equal(ended, false);
  assert.match(got, /after restart/);
  req.destroy();
});
