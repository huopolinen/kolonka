'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Writable } = require('stream');
const { Dictation, BUILDS, MODELS, download, renameRetry } = require('../src/main/dictation');

const CPU_FILES = ['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-blas.dll', 'libopenblas.dll'];

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-dict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A whisper.cpp install laid out like the real one: bin-cpu/Release/* and models/ggml-<model>.bin.
function installed(dir, { files = CPU_FILES, build = 'cpu' } = {}) {
  const rel = path.join(dir, 'bin-' + build, 'Release');
  fs.mkdirSync(rel, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(rel, f), 'x');
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'ggml-test.bin'), 'model');
  return path.join(rel, 'whisper-server.exe');
}

let nextPid = 1000;
class FakeProc extends EventEmitter {
  constructor(exe, args, { autoExit = true } = {}) {
    super();
    this.exe = exe; this.args = args; this.pid = ++nextPid; this.killed = false; this.autoExit = autoExit;
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
  }
  kill() { this.killed = true; if (this.autoExit) setImmediate(() => this.emit('exit', null)); }
}

// health: (url, n) => { status, body } for the n-th health request.
function makeDictation(t, { health, autoExit = true, idleMinutes = 10, settings } = {}) {
  const dir = tmpDir(t);
  installed(dir);
  const procs = [];
  const fetches = [];
  const d = new Dictation({
    settings: settings || { dictation: { local: { build: 'cpu', model: 'test', idleMinutes } } },
    baseDir: dir,
    spawn: (exe, args) => { const p = new FakeProc(exe, args, { autoExit }); procs.push(p); return p; },
    fetch: async (url) => {
      fetches.push(url);
      const n = fetches.filter((u) => u.endsWith('/health')).length;
      const r = (health || (() => ({ status: 200, body: { status: 'ok' } })))(url, n);
      return { status: r.status, ok: r.status < 400, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    },
    exePathOf: async () => null,
  });
  t.after(() => d.stopServer());
  return { d, dir, procs, fetches };
}

test('whisper-server runs under a random request path and is only reached through it', async (t) => {
  const { d, procs, fetches } = makeDictation(t);
  await d.ensureServer();
  const args = procs[0].args;
  const i = args.indexOf('--request-path');
  assert.ok(i > 0, 'the --request-path flag is passed');
  assert.match(args[i + 1], /^\/[0-9a-f]{48}$/);
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(d.base, `http://127.0.0.1:${d.port}${args[i + 1]}`);
  assert.ok(fetches.length > 0 && fetches.every((u) => u.startsWith(d.base + '/')), 'every request goes under the secret path');
});

test('each server start gets a new secret', async (t) => {
  const { d, procs } = makeDictation(t);
  await d.ensureServer();
  d.stopServer();
  await d.ensureServer();
  const secret = (p) => p.args[p.args.indexOf('--request-path') + 1];
  assert.notEqual(secret(procs[0]), secret(procs[1]));
});

test('ready only on 200 with {"status":"ok"} from /health', async (t) => {
  const answers = [{ status: 404, body: 'File Not Found' }, { status: 503, body: { status: 'loading model' } }, { status: 200, body: { status: 'loading' } }, { status: 200, body: { status: 'ok' } }];
  const { d, fetches } = makeDictation(t, { health: (_u, n) => answers[Math.min(n, answers.length) - 1] });
  await d.ensureServer();
  assert.equal(fetches.filter((u) => u.endsWith('/health')).length, 4);
});

test('a spawn error does not throw and fails the start', async (t) => {
  const { d, procs } = makeDictation(t, { health: () => ({ status: 503, body: {} }) });
  const started = d.ensureServer();
  await new Promise((r) => setTimeout(r, 50));
  assert.doesNotThrow(() => procs[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  await assert.rejects(started, /exited \(error: spawn ENOENT\)/);
  assert.equal(d.proc, null);
});

test('a server that exits during start-up fails the start', async (t) => {
  const { d, procs } = makeDictation(t, { health: () => ({ status: 503, body: {} }) });
  const started = d.ensureServer();
  await new Promise((r) => setTimeout(r, 50));
  procs[0].emit('exit', 3);
  await assert.rejects(started, /exited \(code 3\)/);
});

test('a late exit of an old server does not forget the new one', async (t) => {
  const { d, procs } = makeDictation(t, { autoExit: false });
  await d.ensureServer();
  d.stopServer();
  await d.ensureServer();
  const base = d.base;
  procs[0].emit('exit', 1); // the first server finally exits
  assert.equal(d.proc, procs[1]);
  assert.equal(d.base, base);
  assert.ok(d.ready);
});

test('warm() starts the idle timer, so an unused model does not stay loaded', async (t) => {
  const { d, procs } = makeDictation(t, { idleMinutes: 0.001 }); // 60 ms
  d.warm();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(procs.length, 1);
  assert.equal(procs[0].killed, true);
  assert.equal(d.proc, null);
});

test('stopServer kills the process and removes the PID file', async (t) => {
  const { d, procs } = makeDictation(t);
  await d.ensureServer();
  assert.deepEqual(JSON.parse(fs.readFileSync(d.pidFile, 'utf8')).pid, procs[0].pid);
  d.stopServer();
  assert.equal(procs[0].killed, true);
  assert.equal(fs.existsSync(d.pidFile), false);
});

test('killOrphan kills a leftover server only if the PID is still our exe', async (t) => {
  const dir = tmpDir(t);
  const exe = installed(dir);
  const kills = [];
  const mk = (actual) => new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir, exePathOf: async () => actual, kill: (pid) => kills.push(pid) });
  const pidFile = path.join(dir, 'whisper-server.pid');

  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242, exe }));
  assert.equal(await mk(exe.toUpperCase()).killOrphan(), true);
  assert.deepEqual(kills, [4242]);
  assert.equal(fs.existsSync(pidFile), false);

  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4243, exe }));
  assert.equal(await mk('C:\\Windows\\notepad.exe').killOrphan(), false, 'a reused PID is left alone');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4244, exe }));
  assert.equal(await mk(null).killOrphan(), false, 'a process that is gone is left alone');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4245, exe: path.join(os.tmpdir(), 'elsewhere', 'whisper-server.exe') }));
  assert.equal(await mk(path.join(os.tmpdir(), 'elsewhere', 'whisper-server.exe')).killOrphan(), false, 'an exe outside our folder is left alone');
  assert.deepEqual(kills, [4242]);
});

test('the GPU probe is asynchronous and runs once', async (t) => {
  const dir = tmpDir(t);
  let probes = 0;
  const d = new Dictation({ settings: { dictation: { local: { build: 'auto' } } }, baseDir: dir, hasNvidia: async () => { probes++; return true; } });
  assert.equal(d.build(), 'cpu', 'before detection: nothing installed, no blocking probe');
  assert.equal(probes, 0);
  assert.equal(d.publicConfig().installed, false);
  assert.equal(probes, 0, 'the IPC init path does not probe');
  assert.equal(await d.detectBuild(), 'cuda');
  await d.detectBuild();
  assert.equal(probes, 1);
  assert.equal(d.build(), 'cuda');
});

test('an installed build is used before detection finishes', async (t) => {
  const dir = tmpDir(t);
  installed(dir, { build: 'cuda', files: ['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', ...BUILDS.cuda.files] });
  const d = new Dictation({ settings: { dictation: { local: { build: 'auto', model: 'test' } } }, baseDir: dir, hasNvidia: () => new Promise(() => {}) });
  assert.equal(d.build(), 'cuda');
  assert.equal(d.isInstalled(), true);
});

test('an incomplete whisper.cpp folder does not count as installed', (t) => {
  const dir = tmpDir(t);
  installed(dir, { files: ['whisper-server.exe', 'whisper.dll'] });
  const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir });
  assert.equal(d.isInstalled(), false);
});

test('a truncated known model does not count as installed', (t) => {
  const dir = tmpDir(t);
  installed(dir);
  fs.writeFileSync(path.join(dir, 'models', 'ggml-base-q5_1.bin'), 'short');
  const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'base-q5_1' } } }, baseDir: dir });
  assert.equal(d.isInstalled(), false);
});

// ---------- unpack ----------
function fakeTar(files) {
  return async (args) => {
    const out = path.join(args[3], 'Release');
    fs.mkdirSync(out, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(out, f), 'x');
  };
}

test('unpack moves a complete build into place in one step', async (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'bin-cpu'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin-cpu', 'leftover.dll'), 'old partial unpack');
  const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir, tar: fakeTar(CPU_FILES) });
  await d.unpack(path.join(dir, 'w.zip'), 'cpu');
  assert.ok(fs.existsSync(path.join(dir, 'bin-cpu', 'Release', 'whisper-server.exe')));
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu', 'leftover.dll')), false, 'the old partial folder is replaced');
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu.tmp')), false);
  assert.equal(d.binReady('cpu'), true);
});

test('unpack of an incomplete archive leaves nothing that looks installed', async (t) => {
  const dir = tmpDir(t);
  const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir, tar: fakeTar(['whisper-server.exe', 'whisper.dll']) });
  await assert.rejects(d.unpack(path.join(dir, 'w.zip'), 'cpu'), /incomplete, missing: ggml\.dll/);
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu')), false);
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu.tmp')), false);
});

test('unpack that fails half-way leaves nothing behind', async (t) => {
  const dir = tmpDir(t);
  const tar = async (args) => { fs.writeFileSync(path.join(args[3], 'whisper-server.exe'), 'x'); throw new Error('unpacking failed: disk full'); };
  const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir, tar });
  await assert.rejects(d.unpack(path.join(dir, 'w.zip'), 'cpu'), /disk full/);
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu')), false);
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu.tmp')), false);
});

// fs.renameSync that fails with `code` the first `times` calls, as when Defender still scans the new files
function lockedRename(times, code = 'EPERM') {
  const calls = [];
  const rename = (from, to) => {
    calls.push([from, to]);
    if (calls.length <= times) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    return fs.renameSync(from, to);
  };
  return { rename, calls };
}

test('unpack waits out a folder briefly locked by an antivirus scan', async (t) => {
  const dir = tmpDir(t);
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const { rename, calls } = lockedRename(2, code);
    const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir, tar: fakeTar(CPU_FILES), rename });
    await d.unpack(path.join(dir, 'w.zip'), 'cpu');
    assert.equal(calls.length, 3, code);
    assert.equal(d.binReady('cpu'), true, code);
    assert.equal(fs.existsSync(path.join(dir, 'bin-cpu.tmp')), false, code);
  }
});

test('unpack gives up on a lock that does not go away and cleans up', async (t) => {
  const dir = tmpDir(t);
  const { rename, calls } = lockedRename(Infinity);
  const d = new Dictation({ settings: { dictation: { local: { build: 'cpu', model: 'test' } } }, baseDir: dir, tar: fakeTar(CPU_FILES), rename });
  // the real delays add up to a few seconds; the attempts are what matters here
  t.mock.method(global, 'setTimeout', (fn) => { fn(); return 0; });
  await assert.rejects(d.unpack(path.join(dir, 'w.zip'), 'cpu'), { code: 'EPERM' });
  t.mock.restoreAll();
  assert.ok(calls.length > 3, 'retried before giving up');
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu')), false);
  assert.equal(fs.existsSync(path.join(dir, 'bin-cpu.tmp')), false);
});

test('renameRetry does not retry other errors', async () => {
  const { rename, calls } = lockedRename(Infinity, 'ENOENT');
  await assert.rejects(renameRetry('a', 'b', { rename, delays: [1, 1, 1] }), { code: 'ENOENT' });
  assert.equal(calls.length, 1);
});

// ---------- downloads ----------
async function fileServer(t, body) {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}/file.bin`;
}

test('download keeps a file whose SHA-256 matches', async (t) => {
  const dir = tmpDir(t);
  const body = crypto.randomBytes(200000);
  const url = await fileServer(t, body);
  const dest = path.join(dir, 'model.bin');
  await download(url, dest, { sha256: crypto.createHash('sha256').update(body).digest('hex') });
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.equal(fs.existsSync(dest + '.part'), false);
});

test('download deletes a file whose SHA-256 does not match', async (t) => {
  const dir = tmpDir(t);
  const url = await fileServer(t, crypto.randomBytes(5000));
  const dest = path.join(dir, 'model.bin');
  await assert.rejects(download(url, dest, { sha256: 'a'.repeat(64) }), /checksum mismatch/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(dest + '.part'), false);
});

// A write stream that fails the way a full disk does: the first write fills the buffer (no 'drain' will come),
// then the write fails with ENOSPC. The .part file exists, as it would after the real open.
function fullDiskStream(file) {
  fs.writeFileSync(file, 'partial');
  return new Writable({
    highWaterMark: 1,
    write(_chunk, _enc, cb) { setTimeout(() => cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })), 5); },
  });
}

test('download on a full disk fails with a clear error and removes the .part file', { timeout: 5000 }, async (t) => {
  const dir = tmpDir(t);
  const body = crypto.randomBytes(300000);
  const url = await fileServer(t, body);
  const dest = path.join(dir, 'model.bin');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await assert.rejects(download(url, dest, { sha256, open: fullDiskStream }), (e) => {
    assert.equal(e.code, 'ENOSPC');
    assert.match(e.message, /not enough free disk space for model\.bin\.part in /);
    return true;
  });
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(dest + '.part'), false);
});

test('download into a folder that cannot be written fails instead of crashing', { timeout: 5000 }, async (t) => {
  const dir = tmpDir(t);
  const body = crypto.randomBytes(1000);
  const url = await fileServer(t, body);
  const dest = path.join(dir, 'missing', 'model.bin'); // the folder does not exist: the open fails
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await assert.rejects(download(url, dest, { sha256 }), (e) => {
    assert.equal(e.code, 'ENOENT');
    assert.match(e.message, /could not write .*model\.bin\.part/);
    return true;
  });
});

test('download waits out a locked .part file before renaming it, and removes it if the lock stays', async (t) => {
  const dir = tmpDir(t);
  const body = crypto.randomBytes(1000);
  const url = await fileServer(t, body);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const dest = path.join(dir, 'model.bin');
  const ok = lockedRename(1, 'EBUSY');
  await download(url, dest, { sha256, rename: ok.rename });
  assert.equal(ok.calls.length, 2);
  assert.deepEqual(fs.readFileSync(dest), body);

  // the real delays add up to a few seconds; an in-memory response keeps timers out of the HTTP client
  const dest2 = path.join(dir, 'model2.bin');
  const stuck = lockedRename(Infinity, 'EBUSY');
  const memFetch = async () => ({ ok: true, status: 200, body: [body], headers: { get: () => String(body.length) } });
  t.mock.method(global, 'setTimeout', (fn) => { fn(); return 0; });
  await assert.rejects(download(url, dest2, { sha256, fetch: memFetch, rename: stuck.rename }), { code: 'EBUSY' });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(dest2), false);
  assert.equal(fs.existsSync(dest2 + '.part'), false);
});

test('download refuses to run without a checksum', async (t) => {
  const dir = tmpDir(t);
  await assert.rejects(download('http://127.0.0.1:9/x', path.join(dir, 'x'), {}), /no checksum/);
});

test('every download is pinned to a release or commit and has a SHA-256', () => {
  for (const [name, b] of Object.entries(BUILDS)) {
    assert.match(b.url, /\/releases\/download\/b\d+\//, name);
    assert.match(b.sha256, /^[0-9a-f]{64}$/, name);
  }
  for (const [name, m] of Object.entries(MODELS)) {
    assert.match(m.url, /\/resolve\/[0-9a-f]{40}\//, name);
    assert.doesNotMatch(m.url, /\/resolve\/main\//, name);
    assert.match(m.sha256, /^[0-9a-f]{64}$/, name);
    assert.ok(Number.isInteger(m.size) && m.size > 1e6, name);
  }
});
