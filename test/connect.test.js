'use strict';
// "Connect a server": the trust and the tab in the model, POST /api/remote/connect, and
// `kolonka remote connect / disconnect` run as a program against a throwaway USERPROFILE,
// with and without a running Kolonka (the API over a model with fake sessions).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Model } = require('../src/main/model');
const { startApi } = require('../src/main/api');
const { FakeSession } = require('./helpers/fake-session');
const R = require('../src/main/remote');
const C = require('../bin/sshconfig');

const CLI = path.join(__dirname, '..', 'bin', 'kolonka.js');
const SHELLS = { cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [], env: {} } };
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeModel(t, dir = tmp(t, 'kolonka-connect-')) {
  const model = new Model({
    dataDir: dir, settings: { defaultShell: 'cmd' }, shells: SHELLS, Session: FakeSession,
    remoteDeps: { listProcesses: async () => [], sshExe: () => SSH, isAllowedSshExe: (p) => p === SSH },
  });
  t.after(() => clearTimeout(model._saveTimer));
  model.load();
  return { model, dir };
}

const openReq = (tab, host, token) => R.parseRemoteOsc(`open;host=${R.b64encode(host)}${token ? ';token=' + R.b64encode(token) : ''}`);

// ---------- the model ----------

test('connectServer: trusted like "Always", a tab ssh -t to it, marked rerun, in the current workspace, saved at once', (t) => {
  const { model, dir } = makeModel(t);
  const ws = model.createWorkspace({ name: 'servers' });
  model.createSession({ workspace: ws.id, cwd: dir });
  const r = model.connectServer({ destination: 'leo@203.0.113.10', options: ['-p', '2222'], name: 'prod' });
  assert.equal(r.host, 'leo@203.0.113.10:2222');
  assert.deepEqual(model.remoteAllowed, ['leo@203.0.113.10:2222']);
  const s = model.sessions.get(r.session);
  assert.equal(s.workspaceId, ws.id, 'the current workspace');
  assert.equal(s.name, 'prod');
  assert.equal(s.rerun, true);
  assert.equal(s.fromRemote, false, 'opened by the user, not by a server');
  assert.deepEqual(s.opts.shell.args, ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', '-o', 'SendEnv=KOLONKA_TOKEN', '-p', '2222', '--', 'leo@203.0.113.10']);
  assert.equal(s.opts.shell.commandLine, R.sshCommandLine(SSH, s.opts.shell.args));
  assert.equal(model.activeId, s.id);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.remote.allowedHosts, ['leo@203.0.113.10:2222'], 'on disk before the call returns');
  assert.equal(saved.workspaces.find((w) => w.id === ws.id).sessions.find((x) => x.id === s.id).rerun, true);
});

test('connectServer: no tab when not asked, a workspace by name (created if missing), a remote command, connecting twice keeps one entry', (t) => {
  const { model } = makeModel(t);
  const before = model.sessions.size;
  assert.deepEqual(model.connectServer({ destination: 'myserver', open: false }), { host: 'myserver', session: null });
  assert.equal(model.sessions.size, before);
  const r = model.connectServer({ destination: 'myserver', workspace: 'servers', cmd: 'htop' });
  const s = model.sessions.get(r.session);
  assert.equal(model.ws(s.workspaceId).name, 'servers');
  assert.equal(s.ssh.cmd, 'htop');
  assert.equal(s.opts.shell.args.at(-1), 'htop');
  assert.equal(s.name, 'myserver', 'named after the host');
  assert.deepEqual(model.remoteAllowed, ['myserver']);
});

test('connectServer: refuses what normalizeSsh refuses, and a command without a tab; nothing trusted then', (t) => {
  const { model } = makeModel(t);
  assert.throws(() => model.connectServer({ destination: '-oProxyCommand=calc' }), (e) => e.code === 400);
  assert.throws(() => model.connectServer({ destination: 'myserver', options: ['-o', 'ProxyCommand=calc'] }), (e) => e.code === 400);
  assert.throws(() => model.connectServer({ destination: 'myserver', cmd: 'a\nb' }), (e) => e.code === 400);
  assert.throws(() => model.connectServer({ destination: 'myserver', cmd: 'htop', open: false }), (e) => e.code === 400);
  assert.deepEqual(model.remoteAllowed, []);
});

test('the 0.2.0 rule holds for a connected server: silent only with the tab token and for that same host', async (t) => {
  const { model } = makeModel(t);
  const asked = [];
  model.askRemote = async (req) => { asked.push(req); return 'deny'; };
  const { session } = model.connectServer({ destination: 'myserver' });
  const tab = model.sessions.get(session);

  const silent = await model.handleRemote(tab, openReq(tab, '@same', tab.token));
  assert.ok(silent && silent.ssh.destination === 'myserver', 'token + same host: opened');
  assert.equal(asked.length, 0);

  await model.handleRemote(tab, openReq(tab, '@same', null));
  assert.equal(asked.length, 1, 'without the token: asked');
  assert.equal(asked[0].verified, false);

  const tab2 = model.sessions.get(model.connectServer({ destination: 'myserver' }).session);
  await model.handleRemote(tab2, openReq(tab2, '@same', 'not-the-token'));
  assert.equal(asked.length, 2, 'a wrong token: asked');

  const tab3 = model.sessions.get(model.connectServer({ destination: 'myserver' }).session);
  model.connectServer({ destination: 'other', open: false });
  await model.handleRemote(tab3, openReq(tab3, 'other', tab3.token));
  assert.equal(asked.length, 3, 'another host, even a connected one: asked');
  assert.equal(asked[2].host, 'other');
});

// ---------- the API ----------

async function startedApi(t) {
  const { model, dir } = makeModel(t);
  const api = await startApi({ model, dataDir: dir, port: 0, hooks: { version: 'test', focus() {}, notify() {} } });
  t.after(() => new Promise((r) => { api.server.closeAllConnections?.(); api.server.close(() => r()); }));
  return { model, dir, api };
}

function call(api, method, url, body) {
  return fetch(api.url + url, {
    method, headers: Object.assign({ authorization: 'Bearer ' + api.token }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('POST /api/remote/connect: trust and tab; bad input is a 400 and trusts nothing', async (t) => {
  const { model, api } = await startedApi(t);
  let r = await call(api, 'POST', '/api/remote/connect', { destination: 'myserver', options: [], name: 'box' });
  assert.equal(r.status, 200);
  assert.equal(r.body.host, 'myserver');
  assert.equal(model.sessions.get(r.body.session).name, 'box');
  r = await call(api, 'POST', '/api/remote/connect', { destination: 'other', open: false });
  assert.deepEqual(r.body, { host: 'other', session: null });
  r = await call(api, 'POST', '/api/remote/connect', { destination: 'x', options: ['-F', 'evil'] });
  assert.equal(r.status, 400);
  assert.deepEqual(model.remoteAllowed, ['myserver', 'other']);
});

// ---------- the CLI ----------

function cli(t, args, { home, data }) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { USERPROFILE: home, KOLONKA_DATA: data });
    delete env.KOLONKA_SESSION;
    execFile(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('kolonka remote connect / disconnect without a running Kolonka: ssh config and state.json', async (t) => {
  const home = tmp(t, 'kolonka-home-');
  const data = tmp(t, 'kolonka-data-');
  fs.mkdirSync(path.join(home, '.ssh'));
  const file = path.join(home, '.ssh', 'config');
  fs.writeFileSync(file, 'Host myserver\n  User leo\n');
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, workspaces: [{ id: 'w1', name: 'main', sessions: [] }], remote: { allowedHosts: ['old'] } }));

  let r = await cli(t, ['remote', 'connect', 'myserver', '--no-open'], { home, data });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ssh config: changed .*config — Kolonka's variables go to myserver \(copy of the old file: config\.bak-kolonka-\d{8}T\d{6}Z\)/);
  assert.match(r.stdout, /saved for the next start/);
  assert.doesNotMatch(r.stdout, /no tab was opened/, '--no-open asked for no tab');
  assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'Host myserver\n  User leo\n\n' + [
    '# >>> kolonka: myserver', 'Host myserver', '    SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN', '# <<< kolonka: myserver', ''].join('\n'));
  let st = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  assert.deepEqual(st.remote.allowedHosts, ['old', 'myserver']);
  assert.equal(st.workspaces[0].name, 'main', 'the rest of the state is kept');

  r = await cli(t, ['remote', 'connect', 'myserver'], { home, data });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already sends Kolonka's variables to myserver/);
  assert.match(r.stdout, /Kolonka is not running, so no tab was opened/);
  assert.equal(C.readKeys(file).length, 1, 'no second block');
  assert.equal(fs.readdirSync(path.join(home, '.ssh')).filter((f) => f.includes('.bak-kolonka-')).length, 1, 'no backup without a change');

  r = await cli(t, ['remote', 'disconnect', 'myserver'], { home, data });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Host myserver\n  User leo\n');
  st = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
  assert.deepEqual(st.remote.allowedHosts, ['old']);

  r = await cli(t, ['remote', 'disconnect', 'myserver'], { home, data });
  assert.equal(r.code, 1, 'nothing to remove');
  assert.match(r.stdout, /no block of Kolonka for myserver/);
});

test('kolonka remote connect: a bad address changes nothing; an unreadable state.json is left alone', async (t) => {
  const home = tmp(t, 'kolonka-home-');
  const data = tmp(t, 'kolonka-data-');
  let r = await cli(t, ['remote', 'connect', '-oProxyCommand=calc'], { home, data });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot start with -/);
  r = await cli(t, ['remote', 'connect', 'myserver', '--command', 'a\u202eb'], { home, data });
  assert.equal(r.code, 2);
  assert.equal(fs.existsSync(path.join(home, '.ssh')), false);
  fs.writeFileSync(path.join(data, 'state.json'), '{ not json');
  r = await cli(t, ['remote', 'connect', 'myserver', '--no-open'], { home, data });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /was not added to the trusted hosts/);
  assert.equal(fs.readFileSync(path.join(data, 'state.json'), 'utf8'), '{ not json');
});

test('kolonka remote connect / disconnect with a running Kolonka: ssh config by the CLI, trust and tab through the API', async (t) => {
  const { model, dir: data } = await startedApi(t);
  const home = tmp(t, 'kolonka-home-');
  let r = await cli(t, ['remote', 'connect', 'user@203.0.113.10:2222', '--name', 'prod', '--ws', 'servers', '--command', 'htop'], { home, data });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ssh config: created/);
  assert.match(r.stdout, /tab: s\d+/);
  assert.deepEqual(model.remoteAllowed, ['user@203.0.113.10:2222']);
  const id = /tab: (s\d+)/.exec(r.stdout)[1];
  const s = model.sessions.get(id);
  assert.deepEqual(s.ssh, { destination: 'user@203.0.113.10', options: ['-p', '2222'], cmd: 'htop' });
  assert.equal(s.name, 'prod');
  assert.equal(model.ws(s.workspaceId).name, 'servers');
  assert.equal(s.rerun, true);
  assert.match(fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8'), /# >>> kolonka: user@203\.0\.113\.10:2222\r?\nHost 203\.0\.113\.10\r?\n/);
  const stateFile = path.join(data, 'state.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).remote.allowedHosts, ['user@203.0.113.10:2222']);

  r = await cli(t, ['remote', 'disconnect', 'user@203.0.113.10:2222'], { home, data });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(model.remoteAllowed, []);
  assert.deepEqual(C.readKeys(path.join(home, '.ssh', 'config')), []);
  assert.ok(model.sessions.has(id), 'open tabs stay');
});
