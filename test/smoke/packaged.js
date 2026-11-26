'use strict';
// Smoke test of the packaged app (dist/win-unpacked): start Kolonka.exe with a throwaway data folder,
// drive it through the CLI, then quit it through the API. Windows only; run after `electron-builder --win dir`.
//   node test/smoke/packaged.js [path\to\Kolonka.exe]
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const EXE = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'win-unpacked', 'Kolonka.exe'));
const PACKAGED_CLI = path.join(path.dirname(EXE), 'resources', 'bin', 'kolonka.js');
const PORT = 47899;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-smoke-'));
const CONTROL = path.join(DATA, 'control.json');
const SETTINGS = { backgroundMaterial: 'none', dictation: { enabled: false }, defaultShell: 'cmd', apiPort: PORT };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

let app = null;
let appExited = null; // promise resolved with the exit code
let appOutput = '';

function env() {
  const e = Object.assign({}, process.env, { KOLONKA_DATA: DATA });
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.KOLONKA_SESSION;
  return e;
}

function startApp() {
  log('starting', EXE);
  app = spawn(EXE, [], { env: env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  for (const s of [app.stdout, app.stderr]) s.on('data', (d) => { appOutput += d; });
  appExited = new Promise((resolve) => app.on('exit', (code, signal) => resolve(code === null ? signal : code)));
  app.on('error', (e) => { appOutput += `spawn error: ${e.message}\n`; });
}

// Run the CLI with plain node, the way scripts and agents call it.
function cli(...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PACKAGED_CLI, ...args], { env: env(), timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      log(`kolonka ${args.join(' ')} -> ${err ? 'exit ' + (err.code ?? err.signal) : 'ok'}`);
      if (err) { err.message = `kolonka ${args.join(' ')} failed: ${stderr || err.message}`; return reject(err); }
      resolve(stdout);
    });
  });
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
      res.on('end', () => (res.statusCode < 400 ? resolve(raw) : reject(new Error(`${method} ${url}: HTTP ${res.statusCode} ${raw}`))));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(what, ms, fn) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(250);
  }
}

// The timer is unref'd so a pending race does not keep the script alive after the app has exited.
const exitedWithin = (ms) => Promise.race([appExited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms).unref())]);

async function main() {
  if (process.platform !== 'win32') throw new Error('the packaged smoke test runs on Windows only');
  if (!fs.existsSync(EXE)) throw new Error(`no ${EXE}; build it with: npx electron-builder --win dir`);
  if (!fs.existsSync(PACKAGED_CLI)) throw new Error(`the CLI is not packaged: no ${PACKAGED_CLI}`);
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(SETTINGS, null, 2));

  startApp();
  const control = await waitFor('control.json', 60000, async () => {
    if (app.exitCode !== null) throw new Error(`Kolonka exited early with code ${app.exitCode}`);
    try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return null; }
  });
  log('API is up at', control.url);

  const tree = JSON.parse(await cli('tree', '--json'));
  if (!Array.isArray(tree.workspaces) || !tree.workspaces.length) throw new Error('tree has no workspaces: ' + JSON.stringify(tree));

  const id = (await cli('new', '--shell', 'cmd', '--name', 'smoke')).trim();
  if (!/^s\d+$/.test(id)) throw new Error(`new printed "${id}" instead of a session id`);
  const info = JSON.parse(await cli('info', '-t', 'smoke'));
  if (info.id !== id || info.shell !== 'cmd' || info.exited) throw new Error('unexpected session info: ' + JSON.stringify(info));

  await cli('run', '-t', 'smoke', 'echo kolonka-ok');
  await cli('wait', '-t', 'smoke', '--pattern', 'kolonka-ok', '--screen', '--timeout', '30000');
  // The typed command also contains "kolonka-ok"; a line that is exactly the output proves cmd ran it.
  const screen = await waitFor('the echo output on screen', 15000, async () => {
    const text = await cli('text', '-t', 'smoke');
    return text.split(/\r?\n/).some((l) => l.trim() === 'kolonka-ok') ? text : null;
  });
  log('screen:\n' + screen.trimEnd());

  log('quitting through the API');
  await api('POST', '/api/window', { action: 'quit' });
  if (!(await exitedWithin(20000))) throw new Error('Kolonka did not exit within 20 s after quit');
  const code = await appExited;
  log('Kolonka exited with', code);
  if (code !== 0) throw new Error(`Kolonka exited with code ${code}`);
  if (fs.existsSync(CONTROL)) throw new Error('control.json is still there after quit');
}

function dumpDiagnostics() {
  if (appOutput.trim()) console.log('--- Kolonka stdout/stderr ---\n' + appOutput.trimEnd());
  for (const f of ['logs/main.log', 'state.json']) {
    try { console.log(`--- ${f} ---\n` + fs.readFileSync(path.join(DATA, f), 'utf8').trimEnd()); } catch { /* none */ }
  }
}

function killApp() {
  if (!app || app.exitCode !== null) return Promise.resolve();
  log('killing Kolonka');
  return new Promise((resolve) => execFile('taskkill', ['/pid', String(app.pid), '/T', '/F'], () => resolve()));
}

main().then(
  async () => {
    log('PASS');
    fs.rmSync(DATA, { recursive: true, force: true });
  },
  async (e) => {
    console.error('[smoke] FAIL:', e.message);
    dumpDiagnostics();
    await killApp();
    if (appExited) await exitedWithin(5000);
    process.exitCode = 1;
  },
);
