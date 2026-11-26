'use strict';
// The real Session (headless xterm mirror) over a fake node-pty. Needs the npm dependencies, so a
// checkout without node_modules skips it; CI always runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

let Session = null;
try { Session = require('../src/main/session').Session; } catch (e) {
  if (process.env.CI) throw e;
}
const skip = Session ? false : 'needs npm install (runs in CI)';

function fakePty() {
  const p = {
    spawned: null, written: [], killed: false, onData: [], onExit: [],
    spawn(file, args, opts) {
      p.spawned = { file, args, opts };
      return {
        pid: 4242,
        onData: (fn) => p.onData.push(fn),
        onExit: (fn) => p.onExit.push(fn),
        write: (d) => p.written.push(d),
        resize() {},
        kill() { p.killed = true; },
      };
    },
    data(d) { for (const fn of p.onData) fn(d); },
    exit(code) { for (const fn of p.onExit) fn({ exitCode: code }); },
  };
  return p;
}

function make(t, opts = {}) {
  const pty = fakePty();
  const s = new Session(Object.assign({
    id: 's1', name: 'one', workspaceId: 'w1', cwd: os.tmpdir(), shellKey: 'cmd',
    shell: { file: 'cmd.exe', env: {} }, cols: 80, rows: 24, pty,
  }, opts));
  t.after(() => s.kill());
  return { s, pty };
}

test('a shell without args starts (args are optional in settings.json shells)', { skip }, (t) => {
  const { s, pty } = make(t);
  s.start();
  assert.deepEqual(pty.spawned.args, []);
  assert.equal(pty.spawned.file, 'cmd.exe');
});

test('after kill, late output and the exit of the old pty reach nobody', { skip }, (t) => {
  const { s, pty } = make(t);
  s.start();
  const seen = [];
  s.on('data', () => seen.push('data'));
  s.on('exit', () => seen.push('exit'));
  s.on('killed', () => seen.push('killed'));
  s.kill();
  assert.deepEqual(seen, ['killed']);
  assert.equal(s.listenerCount('data'), 0, 'listeners are dropped');
  pty.data('late output');
  pty.exit(1);
  assert.deepEqual(seen, ['killed']);
  assert.equal(s.exitCode, null);
  assert.ok(pty.killed);
});

test('the headless mirror uses Unicode 11 widths and the configured scrollback', { skip }, async (t) => {
  const { s, pty } = make(t, { scrollback: 3000 });
  s.start();
  assert.equal(s.term.unicode.activeVersion, '11');
  assert.equal(s.term.options.scrollback, 3000);
  pty.data('\u{1F600}');
  await s.flush();
  assert.equal(s.cursor().x, 2, 'an emoji is two cells wide, as in the window');
});

test('snapshot: the data matches its seq exactly', { skip }, async (t) => {
  const { s, pty } = make(t);
  s.start();
  pty.data('one ');
  pty.data('two ');
  const snap = s.snapshot();
  pty.data('three'); // arrives after the snapshot was asked for
  const { seq, data } = await snap;
  assert.equal(seq, 2);
  assert.match(data, /one two/);
  assert.doesNotMatch(data, /three/);
});

test('recent output is kept by seq for wait --since', { skip }, (t) => {
  const { s, pty } = make(t);
  s.start();
  pty.data('a'); pty.data('b'); pty.data('c');
  assert.deepEqual(s.outputSince(1), { data: 'bc', complete: true });
  assert.equal(s.info().seq, 3);
});

test('a restored session does not run its command on its own; a new one does', { skip }, async (t) => {
  const restored = make(t, { command: 'npm run dev', runCommand: false });
  restored.s.start();
  const fresh = make(t, { id: 's2', command: 'npm run dev' });
  fresh.s.start();
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(restored.pty.written, []);
  assert.deepEqual(fresh.pty.written, ['npm run dev\r']);
  assert.equal(restored.s.info().command, 'npm run dev');
});
