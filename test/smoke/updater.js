'use strict';
// Update through electron-updater, end to end, on Windows. The base installer is installed, Kolonka finds a newer
// build on a local feed (KOLONKA_UPDATE_TEST_FEED, loopback only), downloads it, checks its sha512 and installs it:
//   1. on quit ("updates": "auto"): the installer runs silently and Kolonka does not start again;
//   2. with "Restart to update" in the sidebar: the installer runs silently and starts the new version.
// Both times the Claude Code hooks, the voice files and the saved tabs must survive the update.
//   node test/smoke/updater.js <dist of the base version> <dist of the next version>
// Both folders come from `electron-builder --win nsis` (the next one with -c.extraMetadata.version=…).
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const BASE_DIST = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
const NEXT_DIST = path.resolve(process.argv[3] || path.join(ROOT, 'dist-next'));
const INST = path.join(process.env.LOCALAPPDATA, 'Programs', 'Kolonka');
const EXE = path.join(INST, 'Kolonka.exe');
const ASAR = path.join(INST, 'resources', 'app.asar');
const BIN = path.join(INST, 'resources', 'bin');
const UNINSTALLER = path.join(INST, 'Uninstall Kolonka.exe');
const DATA = path.join(process.env.APPDATA, 'Kolonka'); // the normal instance: the one that updates itself
const CONTROL = path.join(DATA, 'control.json');
const MAIN_LOG = path.join(DATA, 'logs', 'main.log');
const WHISPER = path.join(process.env.LOCALAPPDATA, 'Kolonka', 'whisper');
const UPDATER_CACHE = path.join(process.env.LOCALAPPDATA, 'kolonka-updater');
const MARK = '# kolonka-status-hook';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-update-'));
const CLAUDE = path.join(WORK, 'claude');
const CLAUDE_SETTINGS = path.join(CLAUDE, 'settings.json');

const log = (...a) => console.log('[updater]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requests = [];
let feedUrl = '';
let child = null;
let childExit = null;

function readLatest(dir) {
  const info = yaml.load(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'));
  return { version: String(info.version), exe: path.join(dir, info.path), name: info.path };
}

function newer(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

// ---------- the feed: latest.yml, the installer and the blockmaps, with HTTP ranges ----------
function rangesOf(header, size) {
  const m = /^bytes=(.+)$/.exec(header || '');
  if (!m) return null;
  const out = [];
  for (const part of m[1].split(',')) {
    const r = /^\s*(\d*)-(\d*)\s*$/.exec(part);
    if (!r) return null;
    let s = r[1] === '' ? size - Number(r[2]) : Number(r[1]);
    let e = r[1] === '' || r[2] === '' ? size - 1 : Number(r[2]);
    if (s < 0) s = 0;
    if (e >= size) e = size - 1;
    if (s > e) return null;
    out.push([s, e]);
  }
  return out;
}

function startFeed(files) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    requests.push(`${req.method} ${name}${req.headers.range ? ` (${req.headers.range.split(',').length} ranges)` : ''}`);
    const file = files.get(name);
    if (!file) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    if (!req.headers.range) {
      res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const ranges = rangesOf(req.headers.range, size);
    if (!ranges) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    if (ranges.length === 1) {
      const [s, e] = ranges[0];
      res.writeHead(206, { 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start: s, end: e }).pipe(res);
      return;
    }
    // multipart/byteranges, the way electron-updater's DataSplitter reads it
    const boundary = 'kolonka' + crypto.randomBytes(8).toString('hex');
    const fd = fs.openSync(file, 'r');
    const parts = [];
    ranges.forEach(([s, e], i) => {
      parts.push(Buffer.from(`${i ? '\r\n' : ''}--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${s}-${e}/${size}\r\n\r\n`));
      const b = Buffer.alloc(e - s + 1);
      fs.readSync(fd, b, 0, b.length, s);
      parts.push(b);
    });
    fs.closeSync(fd);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    res.writeHead(206, { 'content-type': `multipart/byteranges; boundary=${boundary}`, 'content-length': body.length, 'accept-ranges': 'bytes' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- the installed app ----------
function env(extra = {}) {
  const e = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CLAUDE });
  for (const k of ['KOLONKA_DATA', 'KOLONKA_SESSION', 'KOLONKA_NO_UPDATE', 'ELECTRON_RUN_AS_NODE']) delete e[k];
  return Object.assign(e, extra);
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, Object.assign({ encoding: 'utf8', timeout: 300000, windowsHide: true, env: env() }, opts));
  log(`${path.basename(file)} ${args.join(' ').slice(0, 80)} -> ${r.error ? r.error.message : 'exit ' + r.status}`);
  return r;
}

function startApp() {
  try { fs.unlinkSync(CONTROL); } catch { /* not there */ }
  child = spawn(EXE, [], { env: env({ KOLONKA_UPDATE_TEST_FEED: feedUrl, KOLONKA_DEBUG: '1' }), stdio: 'ignore', windowsHide: false });
  childExit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  log('started Kolonka, pid', child.pid);
}

function api(method, url, body) {
  const c = JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(c.url + url, {
      method,
      headers: Object.assign({ authorization: 'Bearer ' + c.token }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => (res.statusCode < 400 ? resolve(raw ? JSON.parse(raw) : null) : reject(new Error(`${method} ${url}: HTTP ${res.statusCode} ${raw}`))));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// the window's own JavaScript (KOLONKA_DEBUG builds of the API only)
const evalInWindow = async (js) => (await api('POST', '/api/window', { action: { eval: js } })).result;

async function waitFor(what, ms, fn) {
  const until = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* not yet */ }
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(500);
  }
}

const apiVersion = () => waitFor('the Kolonka API', 90000, async () => (await api('GET', '/api')));

function installedVersion() {
  const asar = require('@electron/asar');
  asar.uncacheAll(); // the archive is replaced by the update
  return JSON.parse(asar.extractFile(ASAR, 'package.json').toString('utf8')).version;
}

function running(image) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').toLowerCase().includes(`"${image.toLowerCase()}"`);
}

const hooks = () => {
  const cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  return Object.values(cfg.hooks || {}).flat().flatMap((m) => m.hooks).map((h) => h.command);
};

const logSince = (offset) => { try { return fs.readFileSync(MAIN_LOG, 'utf8').slice(offset); } catch { return ''; } };
const logSize = () => { try { return fs.statSync(MAIN_LOG).size; } catch { return 0; } };

const BAR = `(() => { const b = document.getElementById('update-bar'); return b && !b.hidden ? { kind: b.dataset.kind, text: b.textContent } : null; })()`;
async function waitReadyBar(version) {
  const bar = await waitFor('"Restart to update" in the sidebar', 240000, async () => {
    const b = await evalInWindow(BAR);
    return b && b.kind === 'ready' ? b : null;
  });
  log('sidebar:', bar.text);
  assert.ok(bar.text.includes(version), `the bar names ${version}: ${bar.text}`);
}

function checkSurvivors(before, what) {
  assert.deepEqual(hooks(), before, `${what}: the Claude Code hooks are unchanged`);
  assert.ok(fs.existsSync(path.join(WHISPER, 'marker.txt')), `${what}: the voice files are kept`);
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  const sessions = state.workspaces.flatMap((w) => w.sessions);
  const names = sessions.map((s) => s.name);
  assert.ok(names.includes('keep'), `${what}: the saved tabs are kept (${names.join(', ')})`);
  const again = sessions.find((s) => s.name === 'again');
  assert.ok(again && again.rerun === true && again.command === RERUN_CMD, `${what}: the rerun tab is saved with its command (${JSON.stringify(again)})`);
}

// a tab marked rerun (like one a server opened over ssh) runs its command again when Kolonka starts
const RERUN_CMD = 'echo kolonka-rerun-ok';
async function rerunRan() {
  return waitFor('the rerun tab to run its command again', 60000, async () => {
    const r = await api('GET', '/api/sessions/again/text');
    return r.text.split(/\r?\n/).some((l) => l.trim() === 'kolonka-rerun-ok');
  });
}

async function main() {
  assert.equal(process.platform, 'win32', 'Windows only');
  const base = readLatest(BASE_DIST);
  const next = readLatest(NEXT_DIST);
  log(`base ${base.version} (${base.name}), next ${next.version} (${next.name})`);
  assert.ok(newer(next.version, base.version), 'the next build has a higher version');
  assert.ok(!fs.existsSync(EXE), `Kolonka is already installed in ${INST}`);
  // leftovers of the earlier steps (a Crashpad folder) are fine, Kolonka's own files are not: they are deleted at the end
  const own = ['settings.json', 'state.json', 'control.json'].filter((f) => fs.existsSync(path.join(DATA, f)));
  assert.deepEqual(own, [], `${DATA} has Kolonka data; this test needs a profile without it`);
  assert.ok(!fs.existsSync(WHISPER), `${WHISPER} exists; this test would delete it`);

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
    backgroundMaterial: 'none', dictation: { enabled: false }, defaultShell: 'cmd', apiPort: 47897, updates: 'auto',
  }, null, 2));
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }, null, 2));
  fs.mkdirSync(WHISPER, { recursive: true });
  fs.writeFileSync(path.join(WHISPER, 'marker.txt'), 'x');

  const files = new Map([
    ['latest.yml', path.join(NEXT_DIST, 'latest.yml')],
    [next.name, next.exe],
    [next.name + '.blockmap', next.exe + '.blockmap'],
    // the blockmap of the installed version, for a differential download
    [base.name + '.blockmap', base.exe + '.blockmap'],
  ]);
  for (const f of files.values()) assert.ok(fs.existsSync(f), `missing ${f}`);
  const server = await startFeed(files);
  feedUrl = `http://127.0.0.1:${server.address().port}/`;
  log('feed at', feedUrl);

  try {
    assert.equal(run(base.exe, ['/S']).status, 0, 'base installer exit code');
    assert.equal(installedVersion(), base.version);
    const r = run(EXE, [path.join(BIN, 'kolonka.js'), 'hooks', 'install'], { env: env({ ELECTRON_RUN_AS_NODE: '1' }) });
    assert.equal(r.status, 0, r.stderr);
    const hooksBefore = hooks();
    assert.equal(hooksBefore.filter((c) => c.includes(MARK)).length, 4, 'four Kolonka hooks installed');

    // ---- 1. install on quit ----
    log('--- 1. a downloaded update is installed when Kolonka quits');
    let offset = logSize();
    startApp();
    assert.equal((await apiVersion()).version, base.version);
    await api('POST', '/api/sessions', { name: 'keep', shell: 'cmd' });
    await api('POST', '/api/sessions', { name: 'again', shell: 'cmd', command: RERUN_CMD, rerun: true });
    await rerunRan();
    await waitReadyBar(next.version);
    await api('POST', '/api/window', { action: 'quit' });
    assert.equal(await Promise.race([childExit, sleep(30000).then(() => 'timeout')]), 0, 'Kolonka quits with code 0');
    await waitFor(`${next.version} installed`, 240000, async () => installedVersion() === next.version && !running(next.name));
    log('installed', installedVersion());
    await sleep(10000);
    assert.ok(!running('Kolonka.exe'), 'Kolonka is not started again after an install on quit');
    assert.ok(!fs.existsSync(CONTROL), 'no control.json: nothing is running');
    let text = logSince(offset);
    assert.match(text, /update check: .* is available/);
    assert.match(text, /downloaded, sha512 matches latest\.yml/);
    assert.match(text, /Auto install update on quit/);
    assert.match(text, /isSilent: true, isForceRunAfter: false/);
    checkSurvivors(hooksBefore, 'install on quit');
    log('differential download:', /Download block maps/.test(text) ? (/Cannot download differentially/.test(text) ? 'tried, fell back to a full download' : 'used') : 'not tried');

    // ---- 2. "Restart to update" ----
    log('--- 2. "Restart to update" installs and starts the new version');
    assert.equal(run(base.exe, ['/S']).status, 0, 'reinstalling the base version');
    assert.equal(installedVersion(), base.version);
    offset = logSize();
    startApp();
    const before = await apiVersion();
    assert.equal(before.version, base.version);
    const tree = await api('GET', '/api/tree');
    assert.ok(tree.workspaces.some((w) => w.sessions.some((s) => s.name === 'keep')), 'the tab from the first run is restored');
    await waitReadyBar(next.version);
    // every session is idle, so there is no question first
    // (the answer may not arrive: Kolonka is already quitting)
    await evalInWindow(`setTimeout(() => document.querySelector('#update-bar .ub-btn').click(), 100); true`);
    const oldExit = await Promise.race([childExit, sleep(30000).then(() => 'timeout')]);
    assert.notEqual(oldExit, 'timeout', 'the old Kolonka quits');
    log('the old Kolonka exited with', oldExit);
    const after = await waitFor(`Kolonka ${next.version} started again`, 240000, async () => {
      const a = await api('GET', '/api');
      return a && a.version === next.version ? a : null;
    });
    assert.notEqual(after.pid, before.pid);
    assert.equal(installedVersion(), next.version);
    text = logSince(offset);
    assert.match(text, /installing update .* and restarting/);
    assert.match(text, /isSilent: true, isForceRunAfter: true/);
    const tree2 = await api('GET', '/api/tree');
    assert.ok(tree2.workspaces.some((w) => w.sessions.some((s) => s.name === 'keep')), 'the tabs are back after the restart');
    await rerunRan();
    log('the rerun tab ran its command again after "Restart to update"');
    checkSurvivors(hooksBefore, 'restart to update');

    await api('POST', '/api/window', { action: 'quit' });
    await waitFor('the new Kolonka to quit', 60000, async () => !running('Kolonka.exe'));
    log('feed requests:\n  ' + requests.join('\n  '));
    assert.ok(requests.some((q) => q.startsWith(`GET ${next.name}`)), 'the installer was downloaded from the feed');
    log('ok');
  } catch (e) {
    log('feed requests:\n  ' + requests.join('\n  '));
    try { console.log('--- main.log ---\n' + fs.readFileSync(MAIN_LOG, 'utf8').split('\n').slice(-120).join('\n')); } catch { /* none */ }
    throw e;
  } finally {
    server.close();
    if (running('Kolonka.exe')) spawnSync('taskkill', ['/IM', 'Kolonka.exe', '/T', '/F'], { windowsHide: true });
    if (fs.existsSync(UNINSTALLER)) {
      run(UNINSTALLER, ['/S']);
      const t0 = Date.now();
      while (fs.existsSync(EXE) && Date.now() - t0 < 120000) await sleep(1000);
    }
    for (const d of [DATA, WORK, WHISPER, UPDATER_CACHE]) fs.rmSync(d, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(WHISPER)); } catch { /* not empty or gone */ }
  }
}

main().catch((e) => {
  console.error('[updater] FAIL:', e.stack || e.message);
  process.exitCode = 1;
});
