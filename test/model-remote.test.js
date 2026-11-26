'use strict';
// Remote control over ssh in the model: who may open tabs, what gets started, limits, rerun on load.
// A fake Session and a fake process list; no pty, no PowerShell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Model } = require('../src/main/model');
const { FakeSession } = require('./helpers/fake-session');
const R = require('../src/main/remote');

const SHELLS = {
  cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [], env: {} },
  bash: { label: 'Git Bash', file: 'bash.exe', args: [], env: {} },
};
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SEND_ENV = ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION'];
const b = R.b64encode;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// procs(model) -> the fake process list; by default the given tab has `ssh -p 2222 leo@myserver` under it
function makeModel(t, { dir, settings, procs, sshExe = () => SSH } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-remote-'));
  const calls = { list: 0 };
  const model = new Model({
    dataDir: dir, settings: Object.assign({ defaultShell: 'cmd' }, settings), shells: SHELLS, Session: FakeSession,
    remoteDeps: { listProcesses: async () => { calls.list++; return procs ? procs() : []; }, sshExe },
  });
  const logs = []; const notices = []; const events = []; const notes = [];
  model.on('log', (level, msg) => logs.push(msg));
  model.on('remote-notice', (n) => notices.push(n));
  model.on('event', (e) => events.push(e));
  model.on('notify', (n) => notes.push(n));
  t.after(() => { clearTimeout(model._saveTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { model, dir, calls, logs, notices, events, notes };
}

const sshUnder = (pid, line = '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -p 2222 -o ProxyCommand=calc leo@myserver') => [
  { pid, ppid: 1, name: 'bash.exe', started: 10 },
  { pid: pid + 1, ppid: pid, name: 'ssh.exe', cmd: line, started: 20 },
];

const open = (fields) => R.parseRemoteOsc('open;' + Object.entries(fields).map(([k, v]) => `${k}=${k === 'select' ? v : b(v)}`).join(';'));
const newest = (model) => [...model.sessions.values()].pop();

// ---------- open ----------

test('open @same from a tab running ssh, host in allowHosts: a tab connected the same way, no question', async (t) => {
  let tab;
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, procs: () => sshUnder(tab.pid) });
  const { model } = env;
  tab = model.createSession({ cwd: env.dir, shell: 'bash' });
  let asked = 0;
  model.askRemote = async () => { asked++; return 'deny'; };
  const before = model.sessions.size;
  const s = await model.handleRemote(tab, open({ host: '@same', cmd: 'cd ~/app && claude', name: 'agent' }));
  assert.equal(asked, 0);
  assert.equal(model.sessions.size, before + 1);
  assert.equal(s.shellKey, 'ssh');
  assert.equal(s.opts.shell.file, SSH, 'ssh.exe directly, no shell in between');
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '-p', '2222', '--', 'leo@myserver', 'cd ~/app && claude'], '-o ProxyCommand was not carried over');
  assert.equal(s.opts.runCommand, false, 'the command is an ssh argument, it is not typed');
  assert.equal(s.command, null);
  assert.equal(s.name, 'agent');
  assert.equal(s.workspaceId, tab.workspaceId);
  assert.equal(s.rerun, true);
  assert.deepEqual(s.info().remote, { host: 'leo@myserver', cmd: 'cd ~/app && claude' });
  assert.equal(model.activeId, s.id, 'select=1 by default');
  assert.ok(env.events.some((e) => e.type === 'remote.opened' && e.session === tab.id && e.created === s.id));
});

test('open from a local tab (no ssh under it) is refused, with a notice; nothing is asked', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, procs: () => [{ pid: 1, ppid: 0, name: 'x' }] });
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir });
  let asked = 0;
  model.askRemote = async () => { asked++; return 'once'; };
  const before = model.sessions.size;
  await model.handleRemote(tab, open({ host: '@same', cmd: 'ls' }));
  await model.handleRemote(tab, open({ host: 'myserver', cmd: 'ls' }));
  assert.equal(model.sessions.size, before);
  assert.equal(asked, 0);
  assert.deepEqual(env.notices.map((n) => n.reason), ['no-ssh', 'not-ssh']);
  assert.deepEqual(env.events.filter((e) => e.type === 'remote.denied').map((e) => e.reason), ['no-ssh', 'not-ssh']);
});

test('open from a local tab is allowed only with remote.fromLocalTabs, and only for a named host', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'], fromLocalTabs: true } } });
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir });
  await model.handleRemote(tab, open({ host: '@same', cmd: 'ls' }));
  assert.equal(env.notices.pop().reason, 'no-ssh', '@same still needs an ssh connection');
  const s = await model.handleRemote(tab, open({ host: 'myserver', cmd: 'ls' }));
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '--', 'myserver', 'ls']);
});

test('a host that is not allowed: the dialog decides (deny, once, always)', async (t) => {
  let tab;
  const env = makeModel(t, { procs: () => sshUnder(tab.pid, 'ssh 100.64.1.2') });
  const { model } = env;
  tab = model.createSession({ cwd: env.dir, shell: 'bash' });
  const asked = [];
  let answer = 'deny';
  model.askRemote = async (req) => { asked.push(req); return answer; };
  const n0 = model.sessions.size;

  assert.equal(await model.handleRemote(tab, open({ host: '@same', cmd: 'htop' })), undefined);
  assert.equal(model.sessions.size, n0, 'denied');
  assert.deepEqual({ host: asked[0].host, cmd: asked[0].cmd, from: asked[0].from, same: asked[0].same, name: asked[0].name },
    { host: '100.64.1.2', cmd: 'htop', from: '100.64.1.2', same: true, name: tab.name });

  answer = 'once';
  await model.handleRemote(tab, open({ host: '@same', cmd: 'htop' }));
  assert.equal(model.sessions.size, n0 + 1);
  assert.equal(asked.length, 2);
  assert.deepEqual(model.remoteAllowed, [], 'once is not remembered');

  answer = 'always';
  await model.handleRemote(tab, open({ host: '@same', cmd: 'htop' }));
  assert.deepEqual(model.remoteAllowed, ['100.64.1.2']);
  await model.handleRemote(tab, open({ host: '@same', cmd: 'top' }));
  assert.equal(asked.length, 3, 'not asked again for that host');
  assert.equal(model.sessions.size, n0 + 3);

  // remembered across a restart of Kolonka, in state.json
  model.saveNow();
  const again = makeModel(t, { dir: env.dir });
  again.model.load();
  assert.deepEqual(again.model.remoteAllowed, ['100.64.1.2']);
});

test('without a window to ask in, an unknown host is refused', async (t) => {
  let tab;
  const env = makeModel(t, { procs: () => sshUnder(tab.pid) });
  tab = env.model.createSession({ cwd: env.dir });
  const n0 = env.model.sessions.size;
  await env.model.handleRemote(tab, open({ host: '@same', cmd: 'ls' }));
  assert.equal(env.model.sessions.size, n0);
  assert.equal(env.events.find((e) => e.type === 'remote.denied').reason, 'denied');
});

test('a named host from an ssh tab is asked about with both hosts, and opened without carried options', async (t) => {
  let tab;
  const env = makeModel(t, { procs: () => sshUnder(tab.pid) });
  const { model } = env;
  tab = model.createSession({ cwd: env.dir });
  let req = null;
  model.askRemote = async (r) => { req = r; return 'once'; };
  const s = await model.handleRemote(tab, open({ host: 'otherbox', cmd: 'uptime', ws: 'Today', select: '0' }));
  assert.equal(req.from, 'leo@myserver');
  assert.equal(req.host, 'otherbox');
  assert.equal(req.same, false);
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '--', 'otherbox', 'uptime']);
  assert.equal(model.ws(s.workspaceId).name, 'Today', 'a new workspace by name');
  assert.notEqual(model.activeId, s.id, 'select=0');
  const s2 = await model.handleRemote(tab, open({ host: 'otherbox', cmd: 'w', ws: 'today' }));
  assert.equal(s2.workspaceId, s.workspaceId, 'an existing workspace, by name in any case');
});

test('a tab opened over ssh asks for @same: its own connection is used, the process list is not read', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['leo@myserver'] } } });
  const { model, calls } = env;
  const first = model.createSession({ cwd: env.dir, ssh: { destination: 'leo@myserver', options: ['-i', 'C:\\k\\id'], cmd: 'tmux' } });
  const s = await model.handleRemote(first, open({ host: '@same', cmd: 'htop' }));
  assert.equal(calls.list, 0);
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '-i', 'C:\\k\\id', '--', 'leo@myserver', 'htop']);
});

test('more than 10 opens a minute from a tab are dropped with one log line', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', options: [], cmd: '' } });
  const n0 = model.sessions.size;
  for (let i = 0; i < 13; i++) await model.handleRemote(tab, open({ host: '@same', cmd: 'echo ' + i }));
  assert.equal(model.sessions.size, n0 + 10);
  const dropped = env.logs.filter((l) => /remote open from .* dropped: more than 10 a minute/.test(l));
  assert.equal(dropped.length, 3, 'one line per dropped request');
  // a flood is not logged line by line: at most 5 lines a minute per tab
  for (let i = 0; i < 50; i++) await model.handleRemote(tab, open({ host: '@same', cmd: 'x' }));
  assert.equal(env.logs.filter((l) => /dropped/.test(l)).length, 5);
  // another tab has its own limit
  const other = model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', options: [], cmd: '' } });
  assert.ok(await model.handleRemote(other, open({ host: '@same', cmd: 'x' })));
});

test('remote.enabled: false ignores everything', async (t) => {
  const env = makeModel(t, { settings: { remote: { enabled: false, allowHosts: ['myserver'] } } });
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', options: [], cmd: '' } });
  const n0 = model.sessions.size;
  await model.handleRemote(tab, open({ host: '@same', cmd: 'x' }));
  await model.handleRemote(tab, R.parseRemoteOsc('status;state=blocked'));
  await model.handleRemote(tab, R.parseRemoteOsc(`notify;text=${b('hi')}`));
  assert.equal(model.sessions.size, n0);
  assert.equal(tab.status, 'idle');
  assert.deepEqual(env.notes, []);
});

test('no ssh.exe: refused with a notice', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, sshExe: () => null });
  const tab = env.model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', options: [], cmd: '' } });
  await env.model.handleRemote(tab, open({ host: '@same' }));
  assert.equal(env.notices.pop().reason, 'no-ssh-exe');
});

test('the OSC reaches the model through the session\'s "remote" event; a malformed one is only logged', async (t) => {
  const env = makeModel(t);
  const tab = env.model.createSession({ cwd: env.dir });
  tab.emit('remote', R.parseRemoteOsc('status;state=blocked'));
  assert.equal(tab.status, 'blocked');
  tab.emit('remote', R.parseRemoteOsc('open;host=***'));
  await tick();
  assert.ok(env.logs.some((l) => /ignored a remote control sequence/.test(l)));
});

// ---------- status / rename / notify ----------

test('status, rename and notify need no permission, from any tab', async (t) => {
  const env = makeModel(t);
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir });
  await model.handleRemote(tab, R.parseRemoteOsc('status;state=blocked'));
  assert.equal(tab.status, 'blocked');
  assert.ok(env.events.some((e) => e.type === 'session.status' && e.status === 'blocked'));
  await model.handleRemote(tab, R.parseRemoteOsc(`rename;name=${b('build\x1b]0;x\x07 server')}`));
  assert.equal(tab.name, 'build ]0;x server');
  await model.handleRemote(tab, R.parseRemoteOsc(`notify;title=${b('CI')};text=${b('green')}`));
  assert.deepEqual(env.notes, [{ title: 'CI', text: 'green', session: tab.id }]);
  assert.ok(env.events.some((e) => e.type === 'session.notify' && e.session === tab.id && e.text === 'green'));
  await model.handleRemote(tab, R.notifyFromOsc9('osc nine'));
  await model.handleRemote(tab, R.notifyFromOsc777('notify;T;osc 777'));
  assert.deepEqual(env.notes.slice(1).map((n) => n.text), ['osc nine', 'osc 777']);
});

test('notifications: at most 10 a minute per tab', async (t) => {
  const env = makeModel(t);
  const tab = env.model.createSession({ cwd: env.dir });
  for (let i = 0; i < 15; i++) await env.model.handleRemote(tab, R.notifyFromOsc9('n' + i));
  assert.equal(env.notes.length, 10);
});

// ---------- rerun on load ----------

function writeState(dir, sessions) {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, counters: { w: 1, s: 9 }, workspaces: [{ id: 'w1', name: 'main', sessions }],
  }));
}

test('load: a tab opened over ssh connects again; other commands run only when marked rerun', (t) => {
  const env = makeModel(t);
  writeState(env.dir, [
    { id: 's1', name: 'agent', cwd: env.dir, shell: 'ssh', rerun: true, ssh: { destination: 'leo@myserver', options: ['-p', '2222'], cmd: 'claude' } },
    { id: 's2', name: 'dev', cwd: env.dir, shell: 'cmd', command: 'npm run dev' },
    { id: 's3', name: 'watch', cwd: env.dir, shell: 'cmd', command: 'npm run watch', rerun: true },
    { id: 's4', name: 'evil', cwd: env.dir, shell: 'ssh', ssh: { destination: 'x', options: ['-o', 'ProxyCommand=calc'] } },
  ]);
  env.model.load();
  const s1 = env.model.sessions.get('s1');
  assert.equal(s1.opts.shell.file, SSH);
  assert.deepEqual(s1.opts.shell.args, [...SEND_ENV, '-p', '2222', '--', 'leo@myserver', 'claude']);
  assert.equal(s1.rerun, true);
  assert.equal(env.model.sessions.get('s2').opts.runCommand, false, 'restore: fresh (default)');
  assert.equal(env.model.sessions.get('s3').opts.runCommand, true, 'rerun: true');
  const s4 = env.model.sessions.get('s4');
  assert.equal(s4.ssh, null, 'a saved ssh spec with -o is not trusted');
  assert.equal(s4.shellKey, 'cmd');
});

test('load with "restore": "rerun": every tab with a command runs it', (t) => {
  const env = makeModel(t, { settings: { restore: 'rerun' } });
  writeState(env.dir, [
    { id: 's1', name: 'dev', cwd: env.dir, shell: 'cmd', command: 'npm run dev' },
    { id: 's2', name: 'sh', cwd: env.dir, shell: 'cmd' },
  ]);
  env.model.load();
  assert.equal(env.model.sessions.get('s1').opts.runCommand, true);
  assert.equal(env.model.sessions.get('s2').opts.runCommand, false);
});

test('save + load round trip of an ssh tab; restart reconnects with the same arguments', (t) => {
  const env = makeModel(t);
  env.model.load();
  const s = env.model.createSession({ cwd: env.dir, rerun: true, ssh: { destination: 'myserver', options: ['-4'], cmd: 'tmux new -A -s main' } });
  const saved = env.model.serialize().workspaces[0].sessions.find((x) => x.id === s.id);
  assert.deepEqual(saved.ssh, { destination: 'myserver', options: ['-4'], cmd: 'tmux new -A -s main' });
  assert.equal(saved.rerun, true);
  assert.equal(saved.command, undefined);
  const r = env.model.restartSession(s.id);
  assert.notEqual(r, s);
  assert.deepEqual(r.opts.shell.args, s.opts.shell.args);
  assert.equal(r.rerun, true);
});

test('createSession refuses an ssh spec with unsafe options (the HTTP API passes it through)', (t) => {
  const env = makeModel(t);
  assert.throws(() => env.model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', options: ['-F', 'x'] } }), /ssh/);
  assert.throws(() => env.model.createSession({ cwd: env.dir, ssh: { destination: '-oProxyCommand=calc' } }), /ssh/);
});

test('allowHosts from settings and forgetting a remembered host', (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  const { model } = env;
  assert.ok(model.remoteHostAllowed('leo@myserver'));
  assert.ok(!model.remoteHostAllowed('other'));
  model.allowRemoteHost('other');
  assert.ok(model.remoteHostAllowed('other'));
  assert.equal(model.forgetRemoteHost('OTHER'), true);
  assert.ok(!model.remoteHostAllowed('other'));
  assert.equal(model.forgetRemoteHost('myserver'), false, 'a settings.json entry is not forgotten here');
});
