'use strict';
// Remote control in formats seen in the field: host=@same sent as is, -o SendEnv on the user's ssh
// command line, and a visible note for a request Kolonka could not read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/main/remote');
const { Model } = require('../src/main/model');
const { FakeSession } = require('./helpers/fake-session');

const b = R.b64encode;
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SHELLS = { bash: { label: 'Git Bash', file: 'bash.exe', args: [], env: {} } };
const SEND_ENV = ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', '-o', 'SendEnv=KOLONKA_TOKEN'];

// ---------- host=@same ----------

test('parseRemoteOsc: host=@same is taken as it is, as well as base64 of it', () => {
  const tok = b('t0k');
  assert.deepEqual(R.parseRemoteOsc(`open;host=@same;cmd=${b('htop')};token=${tok}`),
    { action: 'open', host: '@same', cmd: 'htop', name: '', ws: '', select: true, token: 't0k' });
  assert.equal(R.parseRemoteOsc(`open;host=${b('@same')}`).host, '@same');
  assert.equal(R.parseRemoteOsc('open; host = @same ').host, '@same', 'spaces around, as for other fields');
});

test('parseRemoteOsc: only @same goes without base64; other hosts and other fields still need it', () => {
  assert.match(R.parseRemoteOsc('open;host=my-server').error, /base64/, 'a plain host name is not taken');
  assert.match(R.parseRemoteOsc('open;host=@other').error, /base64/);
  assert.match(R.parseRemoteOsc('open;host=@SAME').error, /base64/);
  assert.match(R.parseRemoteOsc('open;host=@same;cmd=@same').error, /field "cmd" is not valid base64/);
  assert.match(R.parseRemoteOsc('open;host=@same;host=@same').error, /duplicate/);
});

// ---------- -o SendEnv ----------

const parse = (line) => R.parseSshArgs(R.parseWinCommandLine(line).slice(1));

test('parseSshArgs: -o SendEnv=… is carried over (one -o per name), any case and form of the option name', () => {
  assert.deepEqual(parse('ssh -o SendEnv=FOO myserver'), { destination: 'myserver', options: ['-o', 'SendEnv=FOO'], dropped: [] });
  assert.deepEqual(parse('ssh -oSendEnv=LC_* myserver').options, ['-o', 'SendEnv=LC_*']);
  assert.deepEqual(parse('ssh -o "sendenv A B" -o SENDENV=C,D_1 -p 2222 myserver').options,
    ['-o', 'SendEnv=A', '-o', 'SendEnv=B', '-o', 'SendEnv=C', '-o', 'SendEnv=D_1', '-p', '2222']);
  assert.deepEqual(parse('ssh -o "SendEnv = X" myserver').options, ['-o', 'SendEnv=X']);
});

test('parseSshArgs: any other -o, and SendEnv with something that is not a plain name, is still refused', () => {
  for (const o of ['ProxyCommand=calc', 'SendEnv=-KOLONKA_TOKEN', 'SendEnv=', 'SendEnv=A=B', 'SendEnv=$(calc)', 'SendEnvX=A', 'Send Env=A', 'SetEnv=A=1', 'SendEnv=1A']) {
    assert.deepEqual(parse(`ssh -o "${o}" myserver`).dropped, ['-o'], o);
    assert.deepEqual(parse(`ssh -o "${o}" myserver`).options, [], o);
  }
  assert.deepEqual(parse('ssh -o SendEnv=A -o ProxyJump=x myserver'), { destination: 'myserver', options: ['-o', 'SendEnv=A'], dropped: ['-o'] });
});

test('cleanOptions / normalizeSsh: -o SendEnv=NAME passes, every other -o does not', () => {
  assert.deepEqual(R.cleanOptions(['-o', 'SendEnv=A_*', '-p', '22']), ['-o', 'SendEnv=A_*', '-p', '22']);
  for (const v of ['ProxyCommand=calc', 'SendEnv=A B', 'SendEnv=-A', 'sendenv=A', 'SendEnv=']) assert.equal(R.cleanOptions(['-o', v]), null, v);
  assert.ok(R.normalizeSsh({ destination: 'myserver', options: ['-o', 'SendEnv=FOO'] }));
});

function makeModel(t, procs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-compat-'));
  const model = new Model({
    dataDir: dir, settings: { defaultShell: 'bash', remote: { allowHosts: ['myserver'] } }, shells: SHELLS, Session: FakeSession,
    remoteDeps: { listProcesses: async () => procs(), sshExe: () => SSH, isAllowedSshExe: (p) => p === SSH },
  });
  const notices = []; const asked = []; const events = [];
  model.on('remote-notice', (n) => notices.push(n));
  model.on('event', (e) => events.push(e));
  model.askRemote = async (req) => { asked.push(req); return 'deny'; };
  t.after(() => { clearTimeout(model._saveTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { model, dir, notices, asked, events };
}

const sshUnder = (pid, line) => [{ pid, ppid: 1, name: 'bash.exe', started: 10 }, { pid: pid + 1, ppid: pid, name: 'ssh.exe', cmd: line, exe: SSH, started: 20 }];

test('@same from a tab where the user typed ssh -o SendEnv=FOO: opened, the SendEnv carried, still silent only with the token', async (t) => {
  let tab;
  const env = makeModel(t, () => sshUnder(tab.pid, `"${SSH}" -o SendEnv=FOO myserver`));
  tab = env.model.createSession({ cwd: env.dir, shell: 'bash' });
  const s = await env.model.handleRemote(tab, R.parseRemoteOsc(`open;host=@same;cmd=${b('htop')};token=${b(tab.token)}`));
  assert.ok(s, 'opened');
  assert.equal(env.asked.length, 0);
  assert.deepEqual(s.opts.shell.args, [...SEND_ENV, '-o', 'SendEnv=FOO', '--', 'myserver', 'htop']);
  await env.model.handleRemote(tab, R.parseRemoteOsc('open;host=@same'));
  assert.equal(env.asked.length, 1, 'without the token: asked, as before');
});

test('@same from a tab with ssh -o ProxyCommand=…: still refused', async (t) => {
  let tab;
  const env = makeModel(t, () => sshUnder(tab.pid, `"${SSH}" -o SendEnv=FOO -o ProxyCommand=calc myserver`));
  tab = env.model.createSession({ cwd: env.dir, shell: 'bash' });
  const before = env.model.sessions.size;
  await env.model.handleRemote(tab, R.parseRemoteOsc(`open;host=@same;token=${b(tab.token)}`));
  assert.equal(env.model.sessions.size, before);
  assert.deepEqual(env.notices.map((n) => [n.reason, n.options]), [['ssh-options', ['-o']]]);
});

// ---------- a request Kolonka could not read ----------

test('a malformed OSC 7711 shows one notice a minute per tab, and an event each time', async (t) => {
  const env = makeModel(t, () => []);
  const a = env.model.createSession({ cwd: env.dir, shell: 'bash', name: 'build' });
  const c = env.model.createSession({ cwd: env.dir, shell: 'bash', name: 'other' });
  const bad = R.parseRemoteOsc('open;host=my-server');
  assert.ok(bad.error);
  await env.model.handleRemote(a, bad);
  await env.model.handleRemote(a, bad);
  await env.model.handleRemote(c, R.parseRemoteOsc('nonsense'));
  assert.deepEqual(env.notices.map((n) => [n.reason, n.session, n.name]), [['malformed', a.id, 'build'], ['malformed', c.id, 'other']]);
  assert.equal(env.events.filter((e) => e.type === 'remote.ignored').length, 3);
  assert.equal(env.notices.length, 2, 'the second one from the same tab within a minute: log only');
  env.model.settings.remote.enabled = false;
  const d = env.model.createSession({ cwd: env.dir, shell: 'bash' });
  await env.model.handleRemote(d, bad);
  assert.equal(env.notices.length, 2, 'remote control off: no notice');
});
