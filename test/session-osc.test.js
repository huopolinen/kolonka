'use strict';
// The real Session parses remote control sequences in its headless xterm: OSC 7711, OSC 9, OSC 777,
// also when a sequence is split between chunks of output. Needs the npm dependencies, so a checkout
// without node_modules skips it; CI always runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { b64encode: b } = require('../src/main/remote');

let Session = null;
try { Session = require('../src/main/session').Session; } catch (e) {
  if (process.env.CI) throw e;
}
const skip = Session ? false : 'needs npm install (runs in CI)';

function fakePty() {
  const p = {
    spawned: null, onData: [],
    spawn(file, args, opts) {
      p.spawned = { file, args, opts };
      return { pid: 4242, onData: (fn) => p.onData.push(fn), onExit() {}, write() {}, resize() {}, kill() {} };
    },
    data(d) { for (const fn of p.onData) fn(d); },
  };
  return p;
}

function make(t, opts = {}) {
  const pty = fakePty();
  const s = new Session(Object.assign({
    id: 's1', name: 'one', workspaceId: 'w1', cwd: os.tmpdir(), shellKey: 'cmd',
    shell: { file: 'cmd.exe', env: {} }, cols: 80, rows: 24, pty,
  }, opts));
  const got = [];
  s.on('remote', (m) => got.push(m));
  s.start();
  t.after(() => s.kill());
  return { s, pty, got };
}

test('OSC 7711 with BEL and with ST, all four actions', { skip }, async (t) => {
  const { s, pty, got } = make(t);
  pty.data(`a\x1b]7711;open;host=${b('@same')};cmd=${b('htop')}\x07b`);
  pty.data('\x1b]7711;status;state=blocked\x1b\\');
  pty.data(`\x1b]7711;notify;title=${b('T')};text=${b('hello')}\x07`);
  pty.data(`\x1b]7711;rename;name=${b('build')}\x07`);
  await s.flush();
  assert.deepEqual(got.map((m) => m.action), ['open', 'status', 'notify', 'rename']);
  assert.equal(got[0].host, '@same');
  assert.equal(got[0].cmd, 'htop');
  assert.equal(got[1].state, 'blocked');
  assert.equal(got[2].text, 'hello');
  assert.equal(await s.text(), 'ab', 'the sequences are not shown');
});

test('a sequence split between chunks of output is parsed once, whole', { skip }, async (t) => {
  const { s, pty, got } = make(t);
  const seq = `\x1b]7711;notify;text=${b('split in the middle')}\x07`;
  for (let i = 0; i < seq.length; i += 3) pty.data(seq.slice(i, i + 3)); // ESC and ] in different chunks too
  pty.data('\x1b]77');
  pty.data('11;status;st');
  pty.data('ate=done\x1b');
  pty.data('\\');
  await s.flush();
  assert.deepEqual(got.map((m) => m.text || m.state), ['split in the middle', 'done']);
});

test('broken OSC 7711 is reported as an error, not acted on', { skip }, async (t) => {
  const { s, pty, got } = make(t);
  pty.data('\x1b]7711;open;host=!!!\x07');
  pty.data('\x1b]7711;bogus\x07');
  await s.flush();
  assert.equal(got.length, 2);
  assert.ok(got.every((m) => m.error));
});

test('a tmux passthrough that reached Kolonka without tmux does not break later sequences', { skip }, async (t) => {
  const { s, pty, got } = make(t);
  pty.data('\x1bPtmux;\x1b\x1b]7711;status;state=blocked\x07\x1b\\');
  pty.data('x\x1b]7711;status;state=done\x07y');
  await s.flush();
  assert.equal(got[got.length - 1].state, 'done');
  assert.ok(got.every((m) => !m.error));
  assert.match(await s.text(), /xy/);
});

test('OSC 9: 9;9 is still the cwd, ConEmu 9;N is ignored, 9;<text> is a notification; OSC 777 notify', { skip }, async (t) => {
  const dir = os.tmpdir();
  const { s, pty, got } = make(t, { cwd: '/' });
  pty.data(`\x1b]9;9;${dir}\x07`);
  pty.data('\x1b]9;4;1;50\x07');
  pty.data('\x1b]9;Build finished\x07');
  pty.data('\x1b]777;notify;Claude;Waiting for you\x07');
  pty.data('\x1b]777;precmd\x07');
  await s.flush();
  assert.equal(s.cwd, dir);
  assert.deepEqual(got, [
    { action: 'notify', title: '', text: 'Build finished' },
    { action: 'notify', title: 'Claude', text: 'Waiting for you' },
  ]);
});

test('every tab has LC_TERMINAL=Kolonka, LC_TERMINAL_VERSION and its own token, not shown in info', { skip }, (t) => {
  const { s, pty } = make(t);
  const other = make(t, { id: 's2' });
  assert.equal(pty.spawned.opts.env.LC_TERMINAL, 'Kolonka');
  assert.equal(pty.spawned.opts.env.LC_TERMINAL_VERSION, require('../package.json').version);
  assert.match(pty.spawned.opts.env.KOLONKA_TOKEN, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(pty.spawned.opts.env.KOLONKA_TOKEN, s.token);
  assert.notEqual(other.s.token, s.token);
  assert.ok(!JSON.stringify(s.info()).includes(s.token));
});

test('a shell can drop variables from the environment it inherits (MSYS / CYGWIN for Git\'s ssh)', { skip }, (t) => {
  const { pty } = make(t, { shell: { file: 'ssh.exe', env: { MSYS: 'noglob', cygwin: 'x', KEEP: '1' }, unsetEnv: ['MSYS', 'CYGWIN'] } });
  const keys = Object.keys(pty.spawned.opts.env).map((k) => k.toUpperCase());
  assert.ok(!keys.includes('MSYS'));
  assert.ok(!keys.includes('CYGWIN'));
  assert.equal(pty.spawned.opts.env.KEEP, '1');
});

test('a deferred tab is not started: no process, shown as exited, its screen can still be read', { skip }, async (t) => {
  const { s, pty } = make(t, { deferred: true });
  assert.equal(pty.spawned, null);
  assert.equal(s.exited, true);
  assert.equal(s.info().deferred, true);
  assert.equal(await s.text(), '');
});

test('an ssh tab starts ssh.exe with its arguments and never types the command', { skip }, async (t) => {
  const ssh = { destination: 'myserver', options: [], cmd: 'htop' };
  const { s, pty } = make(t, { ssh, rerun: true, runCommand: false, shell: { file: 'ssh.exe', args: ['-t', '--', 'myserver', 'htop'], env: {} } });
  const written = [];
  s.proc.write = (d) => written.push(d);
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(pty.spawned.args, ['-t', '--', 'myserver', 'htop']);
  // with a command line Kolonka quoted itself, node-pty gets that string on Windows
  const q = make(t, { id: 's3', ssh, runCommand: false, shell: { file: 'ssh.exe', args: ['-t', '@x'], commandLine: '"-t" "@x"', env: {} } });
  assert.deepEqual(q.pty.spawned.args, process.platform === 'win32' ? '"-t" "@x"' : ['-t', '@x']);
  assert.deepEqual(written, []);
  assert.deepEqual(s.info().remote, { host: 'myserver', cmd: 'htop' });
  assert.equal(s.info().rerun, true);
});
