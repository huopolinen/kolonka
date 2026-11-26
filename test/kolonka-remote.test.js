'use strict';
// bin/kolonka-remote (the server side, POSIX sh), the Claude Code hooks for a server, and
// `kolonka remote install`. The script is run with sh (Git Bash on Windows) and a file in place
// of /dev/tty; what it writes is parsed back with Kolonka's own parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('../src/main/remote');
const hooks = require('../bin/hooks');
const remoteCli = require('../bin/remote');

const SCRIPT = path.join(__dirname, '..', 'bin', 'kolonka-remote');

function findSh() {
  if (process.platform !== 'win32') return fs.existsSync('/bin/sh') ? '/bin/sh' : null;
  const env = process.env;
  const c = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'sh.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'sh.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'sh.exe'),
  ].filter(Boolean);
  return c.find((p) => fs.existsSync(p)) || null;
}
const SH = findSh();
if (!SH && process.env.CI) throw new Error('sh (Git Bash) is needed for this test in CI');
const skip = SH ? false : 'needs sh';

const fwd = (p) => p.replace(/\\/g, '/'); // msys sh takes C:/x paths

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-remote-sh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the script; returns { status, stdout, stderr, tty } where tty is what went to the fake /dev/tty.
function run(t, args, { env = {}, tty = true } = {}) {
  const dir = tmp(t);
  const ttyFile = path.join(dir, 'tty');
  if (tty) fs.writeFileSync(ttyFile, '');
  const e = Object.assign({}, process.env);
  for (const k of ['TMUX', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'LC_KOLONKA_TOKEN', 'KOLONKA_TTY']) delete e[k];
  Object.assign(e, { KOLONKA_TTY: tty ? fwd(ttyFile) : fwd(path.join(dir, 'no', 'such', 'tty')) }, env);
  const r = spawnSync(SH, [fwd(SCRIPT), ...args], { env: e, encoding: 'latin1', timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, tty: tty ? fs.readFileSync(ttyFile, 'latin1') : '' };
}

const K = { LC_TERMINAL: 'Kolonka' };
const utf8 = (s) => Buffer.from(s, 'latin1').toString('utf8');

// the payload of exactly one plain OSC 7711, parsed by Kolonka
function osc(bytes) {
  const m = /^\x1b\]7711;([^\x07\x1b]*)\x07$/.exec(bytes);
  assert.ok(m, 'one OSC 7711 terminated by BEL: ' + JSON.stringify(bytes));
  return R.parseRemoteOsc(utf8(m[1]));
}

test('open: the default host is @same; several words are quoted one by one; the tab name goes along', { skip }, (t) => {
  const r = run(t, ['open', '--name', 'мой таб', '--', 'vim', "it's a file", '$HOME', '-d'], { env: K });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'nothing on stdout when /dev/tty works');
  assert.deepEqual(osc(r.tty), { action: 'open', host: '@same', cmd: "'vim' 'it'\\''s a file' '$HOME' '-d'", name: 'мой таб', ws: '', select: true });
});

test('open: one word is a shell command line, passed as it is', { skip }, (t) => {
  const r = run(t, ['open', '--', 'tail -f /var/log/app.log | grep -i error'], { env: K });
  assert.equal(osc(r.tty).cmd, 'tail -f /var/log/app.log | grep -i error');
});

test('the tab token goes along: from the environment, or under tmux from the current client', { skip }, (t) => {
  const plain = run(t, ['open', '--no-rerun', '--', 'htop'], { env: Object.assign({ LC_KOLONKA_TOKEN: 'tok-123' }, K) });
  const m = osc(plain.tty);
  assert.equal(m.token, 'tok-123');
  assert.equal(m.rerun, false);
  assert.equal(osc(run(t, ['status', 'done'], { env: Object.assign({ LC_KOLONKA_TOKEN: 'tok-9' }, K) }).tty).token, 'tok-9');
  assert.equal(osc(run(t, ['status', 'done'], { env: K }).tty).token, undefined, 'no token: none sent');
  // a fake tmux that knows the token of the attached client
  const bin = tmp(t);
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$1 $2" = "show-environment LC_KOLONKA_TOKEN" ] && echo LC_KOLONKA_TOKEN=from-tmux\n');
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  const sep = process.platform === 'win32' ? ';' : ':';
  const r = run(t, ['notify', 'x'], { env: Object.assign({ TMUX: '/tmp/t,1,0', LC_KOLONKA_TOKEN: 'stale', PATH: bin + sep + process.env.PATH }, K) });
  const inner = /^\x1bPtmux;\x1b(\x1b\][^\x07]*\x07)\x1b\\$/.exec(r.tty);
  assert.ok(inner, JSON.stringify(r.tty));
  assert.equal(osc(inner[1].replace(/\x1b\x1b/g, '\x1b')).token, 'from-tmux');
});

test('open --host --ws --no-select, and a login shell without a command', { skip }, (t) => {
  const r = run(t, ['open', '--host', 'leo@myserver', '--ws', 'Today', '--no-select'], { env: K });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(osc(r.tty), { action: 'open', host: 'leo@myserver', cmd: '', name: '', ws: 'Today', select: false });
});

test('open --here starts the command in the current directory (quoted for the remote shell)', { skip }, (t) => {
  const dir = tmp(t);
  const odd = path.join(dir, "it's here");
  fs.mkdirSync(odd);
  const e = Object.assign({}, process.env, K, { KOLONKA_TTY: fwd(path.join(dir, 'tty')) });
  delete e.TMUX;
  fs.writeFileSync(path.join(dir, 'tty'), '');
  const r = spawnSync(SH, ['-c', `cd "$1" && sh "$2" open --here -- make test`, 'sh', fwd(odd), fwd(SCRIPT)], { env: e, encoding: 'latin1' });
  assert.equal(r.status, 0, r.stderr);
  const cmd = osc(fs.readFileSync(path.join(dir, 'tty'), 'latin1')).cmd;
  assert.match(cmd, /^cd '.*it'\\''s here' && 'make' 'test'$/);
});

test('status, notify (title, UTF-8), rename', { skip }, (t) => {
  assert.deepEqual(osc(run(t, ['status', 'blocked'], { env: K }).tty), { action: 'status', state: 'blocked' });
  assert.deepEqual(osc(run(t, ['notify', 'сборка', 'готова', '--title', 'CI'], { env: K }).tty), { action: 'notify', title: 'CI', text: 'сборка готова' });
  assert.deepEqual(osc(run(t, ['rename', 'build', 'box'], { env: K }).tty), { action: 'rename', name: 'build box' });
});

test('under tmux: wrapped in a DCS passthrough with ESC doubled', { skip }, (t) => {
  const r = run(t, ['status', 'done'], { env: Object.assign({ TMUX: '/tmp/tmux-1000/default,1234,0' }, K) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tty, '\x1bPtmux;\x1b\x1b]7711;status;state=done\x07\x1b\\');
});

test('not in Kolonka: nothing is written, exit code 3; --force sends anyway', { skip }, (t) => {
  const r = run(t, ['notify', 'hi']);
  assert.equal(r.status, 3);
  assert.equal(r.tty + r.stdout + r.stderr, '');
  const other = run(t, ['status', 'idle'], { env: { LC_TERMINAL: 'iTerm2' } });
  assert.equal(other.status, 3);
  const f = run(t, ['--force', 'notify', 'hi']);
  assert.equal(f.status, 0);
  assert.equal(osc(f.tty).text, 'hi');
  assert.equal(osc(run(t, ['status', '--force', 'active']).tty).state, 'active');
});

test('without a terminal the sequence goes to stdout', { skip }, (t) => {
  const r = run(t, ['status', 'active'], { env: K, tty: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(osc(r.stdout).state, 'active');
});

test('usage errors: exit code 2, nothing sent', { skip }, (t) => {
  for (const args of [[], ['status'], ['status', 'evil'], ['rename'], ['notify'], ['open', '--bogus'], ['open', '--host', '-oProxyCommand=x'], ['launch']]) {
    const r = run(t, args, { env: K });
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.tty, '', args.join(' '));
  }
});

// ---------- Claude Code hooks on a server ----------

test('hooks print --remote: four hooks calling ~/.local/bin/kolonka, quiet, always exit 0', () => {
  const plan = hooks.remotePlan();
  assert.deepEqual(Object.keys(plan).sort(), Object.keys(hooks.EVENTS).sort());
  for (const [ev, st] of Object.entries(hooks.EVENTS)) {
    const h = plan[ev][0].hooks[0];
    assert.equal(h.type, 'command');
    assert.equal(h.shell, undefined, 'the server runs it with its own sh');
    assert.match(h.command, new RegExp(`"\\$k" status ${st} >/dev/null 2>&1; exit 0 ${hooks.REMOTE_MARK}$`));
    assert.ok(!hooks.isOurs(h), 'not taken for a local hook by install / uninstall');
  }
});

test('the remote hook command sets the status through the script, and is silent without it', { skip }, (t) => {
  const home = tmp(t);
  const ttyFile = path.join(home, 'tty');
  fs.writeFileSync(ttyFile, '');
  const cmd = hooks.remoteHookEntry('blocked').command;
  const e = Object.assign({}, process.env, K, { HOME: fwd(home), KOLONKA_TTY: fwd(ttyFile) });
  delete e.TMUX;
  // no script installed: nothing, exit 0
  let r = spawnSync(SH, ['-c', cmd], { env: e, encoding: 'latin1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr + fs.readFileSync(ttyFile, 'latin1'), '');
  // installed the way `kolonka remote install` does it
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const target = path.join(home, '.local', 'bin', 'kolonka');
  fs.copyFileSync(SCRIPT, target);
  fs.chmodSync(target, 0o755);
  r = spawnSync(SH, ['-c', cmd], { env: e, encoding: 'latin1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'nothing on stdout: Claude Code would add it to the prompt');
  assert.equal(osc(fs.readFileSync(ttyFile, 'latin1')).state, 'blocked');
  // not in Kolonka: still exit 0
  delete e.LC_TERMINAL;
  r = spawnSync(SH, ['-c', cmd], { env: e, encoding: 'latin1' });
  assert.equal(r.status, 0);
});

// ---------- kolonka remote install ----------

function fakeRun(state) {
  const calls = [];
  const fn = (file, args, opts) => {
    calls.push({ file, args, input: opts && opts.input });
    if (args[2] === remoteCli.CHECK) return { status: 0, stdout: state + '\n' };
    return { status: 0, stdout: 'onpath\n' };
  };
  fn.calls = calls;
  return fn;
}
const sink = () => { const o = { text: '', write: (s) => { o.text += s; } }; return o; };

test('remote install: checks, then writes the script with plain ssh, host after --', () => {
  const run = fakeRun('none');
  const out = sink();
  assert.equal(remoteCli.install('myserver', { run, out, prompt: () => { throw new Error('no question expected'); } }), 0);
  assert.equal(run.calls.length, 2);
  assert.deepEqual(run.calls[0].args, ['--', 'myserver', remoteCli.CHECK]);
  assert.deepEqual(run.calls[1].args, ['--', 'myserver', remoteCli.WRITE]);
  assert.equal(run.calls[1].input, fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(!run.calls[1].input.includes('\r'));
  assert.match(out.text, /SendEnv LC_TERMINAL LC_TERMINAL_VERSION LC_KOLONKA_TOKEN/);
  assert.match(out.text, /kolonka hooks print --remote/);
});

test('remote install: an existing file is overwritten only after a yes (or --yes)', () => {
  for (const state of ['ours', 'other']) {
    let run = fakeRun(state);
    assert.equal(remoteCli.install('myserver', { run, out: sink(), prompt: () => 'n' }), 1);
    assert.equal(run.calls.length, 1, 'not written');
    run = fakeRun(state);
    assert.equal(remoteCli.install('myserver', { run, out: sink(), prompt: () => 'y' }), 0);
    assert.equal(run.calls.length, 2);
    run = fakeRun(state);
    assert.equal(remoteCli.install('myserver', { run, out: sink(), yes: true, prompt: () => 'n' }), 0);
    assert.equal(run.calls.length, 2);
  }
});

test('remote install refuses a host that ssh could read as an option', () => {
  const run = fakeRun('none');
  const err = process.stderr.write;
  process.stderr.write = () => true;
  try { assert.equal(remoteCli.install('-oProxyCommand=calc', { run, out: sink() }), 2); } finally { process.stderr.write = err; }
  assert.equal(run.calls.length, 0);
});

test('CLI: hooks print --remote prints the server hooks; new --rerun is a flag, not part of the command', () => {
  const cli = path.join(__dirname, '..', 'bin', 'kolonka.js');
  const r = spawnSync(process.execPath, [cli, 'hooks', 'print', '--remote'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { hooks: hooks.remotePlan() });
  const { parse } = require('../bin/kolonka.js');
  const p = parse(['new', '--rerun', '--name', 'dev', 'npm', 'run', 'dev']);
  assert.equal(p.opt.rerun, true);
  assert.deepEqual(p.rest, ['npm', 'run', 'dev']);
});

test('the installed script carries the marker remote install looks for', () => {
  assert.ok(fs.readFileSync(SCRIPT, 'utf8').includes(remoteCli.MARK));
});
