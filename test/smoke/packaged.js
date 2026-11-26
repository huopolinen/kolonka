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
  checkPackageContents();
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

  // run --wait: one call, no race with fast output, and the echo of the command line is not taken for its output
  const matched = (await cli('run', '-t', 'smoke', '--wait', 'kolonka-wait-ok', '--timeout', '30000', 'echo', 'kolonka-wait-ok')).trim();
  if (matched !== 'kolonka-wait-ok') throw new Error(`run --wait printed "${matched}"`);

  await checkCmdFallback();

  // Electron APIs the control API relies on: capturePage and a Windows notification
  const shot = JSON.parse(await api('POST', '/api/screenshot', {}));
  if (!shot.png || !Buffer.from(shot.png, 'base64').subarray(1, 4).equals(Buffer.from('PNG'))) throw new Error('screenshot did not return a PNG');
  await api('POST', '/api/notify', { title: 'smoke', text: 'notification check' });

  log('quitting through the API');
  await api('POST', '/api/window', { action: 'quit' });
  if (!(await exitedWithin(20000))) throw new Error('Kolonka did not exit within 20 s after quit');
  const code = await appExited;
  log('Kolonka exited with', code);
  if (code !== 0) throw new Error(`Kolonka exited with code ${code}`);
  if (fs.existsSync(CONTROL)) throw new Error('control.json is still there after quit');
}

// kolonka.cmd without node on PATH runs the CLI through the real Kolonka.exe: it must work and must not
// leave ELECTRON_RUN_AS_NODE set in the calling cmd. (The code page switch is checked in test/cmd-wrapper.test.js.)
async function checkCmdFallback() {
  const cmdCli = path.join(path.dirname(EXE), 'resources', 'bin', 'kolonka.cmd');
  const script = path.join(DATA, 'fallback-check.cmd');
  fs.writeFileSync(script, [
    '@echo off',
    `call "${cmdCli}" ls`,
    'echo RC=%ERRORLEVEL%',
    'if defined ELECTRON_RUN_AS_NODE (echo ENV=leaked) else (echo ENV=clean)',
    '',
  ].join('\r\n'));
  const e = env();
  const pathKey = Object.keys(e).find((k) => k.toUpperCase() === 'PATH');
  e[pathKey] = e[pathKey].split(';').filter((d) => d && !fs.existsSync(path.join(d, 'node.exe'))).join(';');
  const out = await new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/d', '/c', script], { env: e, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`fallback check failed: ${stderr || err.message}\n${stdout}`));
      resolve(stdout);
    });
  });
  log('kolonka.cmd without node:\n' + out.trimEnd());
  const val = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out) || [])[1];
  if (val('RC') !== '0') throw new Error('kolonka.cmd ls through Kolonka.exe failed');
  if (!/\tsmoke\t/.test(out)) throw new Error('kolonka.cmd ls did not list the smoke session');
  if (val('ENV') !== 'clean') throw new Error('ELECTRON_RUN_AS_NODE leaked out of kolonka.cmd');
}

// What the package must and must not contain (build.files in package.json). The app starting and running
// a shell proves the kept files are enough; this catches a dropped exclusion that bloats the package again.
const REQUIRED = [
  'node_modules/node-pty/lib/index.js',
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/@xterm/xterm/lib/xterm.js',
  'node_modules/@xterm/xterm/css/xterm.css',
  'node_modules/@xterm/headless/lib-headless/xterm-headless.js',
  'src/main/main.js',
];
const FORBIDDEN = [
  [/\.pdb$/i, 'debug symbols'],
  [/\.map$/i, 'source maps'],
  [/\.mjs$/i, 'ES module builds (the app loads the CommonJS ones)'],
  [/\.test\.js$/i, 'tests'],
  [/^node_modules\/node-addon-api\//, 'node-addon-api (build-time headers)'],
  [/^node_modules\/@xterm\/[^/]+\/(src|typings)\//, 'xterm TypeScript sources'],
  [/^node_modules\/node-pty\/(src|deps|scripts|third_party|typings)\//, 'node-pty sources'],
  [/^node_modules\/node-pty\/build\//, 'the copy of conpty.dll from node-pty\'s install script'],
  [/^node_modules\/node-pty\/prebuilds\/(?!win32-x64\/)/, 'prebuilds for other platforms'],
  [/^node_modules\/node-pty\/prebuilds\/win32-x64\/conpty\//, 'the bundled conpty.dll (only used with useConptyDll)'],
  [/^node_modules\/node-pty\/prebuilds\/win32-x64\/(pty\.node|winpty)/i, 'winpty (node-pty uses it only before Windows 10 1903, which Kolonka does not support)'],
];

function packagedFiles() {
  const resources = path.join(path.dirname(EXE), 'resources');
  const files = new Set();
  // @electron/asar comes with electron-builder; the header lists the unpacked entries too
  const { header } = require('@electron/asar').getRawHeader(path.join(resources, 'app.asar'));
  const fromHeader = (node, rel) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const r = rel ? `${rel}/${name}` : name;
      if (child.files) fromHeader(child, r); else files.add(r);
    }
  };
  fromHeader(header, '');
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else files.add(r);
    }
  };
  const unpacked = path.join(resources, 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) walk(unpacked, '');
  return files;
}

function checkPackageContents() {
  const files = packagedFiles();
  const missing = REQUIRED.filter((f) => !files.has(f));
  if (missing.length) throw new Error('the package lacks: ' + missing.join(', '));
  const extra = [];
  for (const f of files) for (const [re, what] of FORBIDDEN) if (re.test(f)) extra.push(`${f} (${what})`);
  // Chromium's own UI strings: only the languages Kolonka has (build.electronLanguages)
  const locales = fs.readdirSync(path.join(path.dirname(EXE), 'locales')).sort();
  if (locales.join(',') !== 'en-US.pak,ru.pak') extra.push(`locales: ${locales.join(', ')} (only en-US and ru are needed)`);
  if (extra.length) throw new Error(`the package has files it should not ship:\n  ${extra.slice(0, 30).join('\n  ')}${extra.length > 30 ? `\n  … ${extra.length - 30} more` : ''}`);
  log(`package contents ok: ${files.size} entries`);
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
