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
// A stand-in for ssh.exe: a copy of node.exe (see checkRemoteControl)
const FAKE_SSH = path.join(DATA, 'fakessh', 'ssh.exe');
const SETTINGS = {
  backgroundMaterial: 'none', dictation: { enabled: false }, defaultShell: 'cmd', apiPort: PORT,
  remote: { allowHosts: ['myhost:2222'], ssh: FAKE_SSH },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

let app = null;
let appExited = null; // promise resolved with the exit code
let appOutput = '';

// KOLONKA_NO_UPDATE: the packaged app must not ask GitHub for updates in a test (checked at the end)
function env() {
  const e = Object.assign({}, process.env, { KOLONKA_DATA: DATA, KOLONKA_NO_UPDATE: '1' });
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

// Run the CLI with plain node, the way scripts and agents call it. cliEnv: extra environment (cliWith).
function cli(...args) { return cliWith({}, ...args); }
function cliWith(extraEnv, ...args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PACKAGED_CLI, ...args], { env: Object.assign(env(), extraEnv), timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
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
    // main.js first writes {} to protect the file (KOLONKA_DATA outside the profile), the API then fills it in
    try { const c = JSON.parse(fs.readFileSync(CONTROL, 'utf8')); return c && c.url && c.token ? c : null; } catch { return null; }
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
  await checkRemoteControl();
  await checkConnect();

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
  const mainLog = fs.readFileSync(path.join(DATA, 'logs', 'main.log'), 'utf8');
  if (!/updates: off \(env\)/.test(mainLog) || /update check|updater: Checking/.test(mainLog)) throw new Error('the updater was not off under KOLONKA_NO_UPDATE');
  log('updater: off, no update check');
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
  'node_modules/electron-updater/out/main.js',
  'node_modules/js-yaml/index.js',
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

// The live event stream (/api/events), collected into an array.
function openEvents() {
  const c = JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
  const got = [];
  const req = http.get(c.url + '/api/events', { headers: { authorization: 'Bearer ' + c.token } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) got.push(JSON.parse(line.slice(6)));
      }
    });
  });
  req.on('error', () => {});
  return { got, close: () => req.destroy() };
}

// Remote control (OSC 7711, OSC 9) through the real ConPTY, PowerShell and process list:
//   - LC_TERMINAL=Kolonka is in the environment of a tab
//   - OSC 7711 notify and OSC 9 printed in a tab come out as session.notify events
//   - open from a local tab (nothing like ssh running in it) is refused
//   - open @same from a tab running "ssh.exe -p 2222 myhost" (a copy of node.exe under that name, which
//     prints the request itself, with the tab's token from its environment) opens, without a question
//     (myhost:2222 is allowed), a tab that starts remote.ssh with "-t" … "-p" "2222" "--" "myhost" <cmd>;
//     node then stops at "bad option: -t", which is enough to see the quoted arguments arrived
async function checkRemoteControl() {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const events = openEvents();
  const event = (what, pred) => waitFor(what, 45000, async () => events.got.find(pred));
  try {
    const id = (await cli('new', '--shell', 'powershell', '--name', 'osc')).trim();
    await waitFor('the PowerShell prompt', 60000, async () => /PS .*>/.test(await cli('text', '-t', 'osc')));

    await cli('run', '-t', 'osc', '--', 'Write-Output ("LCT=" + $env:LC_TERMINAL)');
    await cli('wait', '-t', 'osc', '--pattern', '^LCT=Kolonka', '--screen', '--timeout', '30000');

    await cli('run', '-t', 'osc', '--', `[Console]::Write([char]27 + ']7711;notify;title=${b64('smoke')};text=${b64('hello from 7711')}' + [char]7)`);
    await event('session.notify from OSC 7711', (e) => e.type === 'session.notify' && e.session === id && e.text === 'hello from 7711' && e.title === 'smoke');
    await cli('run', '-t', 'osc', '--', "[Console]::Write([char]27 + ']9;hello from osc9' + [char]7)");
    await event('session.notify from OSC 9', (e) => e.type === 'session.notify' && e.session === id && e.text === 'hello from osc9');
    log('notify: OSC 7711 and OSC 9 arrived');

    const before = JSON.parse(await cli('ls', '--json')).length;
    await cli('run', '-t', 'osc', '--', `[Console]::Write([char]27 + ']7711;open;host=${b64('@same')};cmd=${b64('echo nope')}' + [char]7)`);
    const denied = await event('open from a local tab refused', (e) => e.type === 'remote.denied' && e.session === id);
    if (denied.reason !== 'no-ssh') throw new Error('open from a local tab: unexpected refusal ' + JSON.stringify(denied));
    if (JSON.parse(await cli('ls', '--json')).length !== before) throw new Error('open from a local tab created a tab');
    log('open from a local tab: refused (' + denied.reason + ')');

    fs.mkdirSync(path.dirname(FAKE_SSH), { recursive: true });
    fs.copyFileSync(process.execPath, FAKE_SSH);
    const script = path.join(DATA, 'fakessh', 'osc.js');
    fs.writeFileSync(script, [
      "const tok = Buffer.from(process.env.KOLONKA_TOKEN || '').toString('base64');",
      `process.stdout.write('\\x1b]7711;open;host=${b64('@same')};cmd=${b64('echo remote-ok')};name=${b64('from-ssh')};token=' + tok + '\\x07');`,
      'setTimeout(() => {}, 30000);',
      '',
    ].join('\n'));
    // node -p 2222 prints 2222; the required script keeps it alive and prints the request
    await cli('run', '-t', 'osc', '--', `$env:NODE_OPTIONS='--require ${script.replace(/\\/g, '/')}'; & '${FAKE_SSH}' -p 2222 myhost`);
    const opened = await event('open @same from the ssh tab', (e) => e.type === 'remote.opened' && e.session === id);
    if (opened.host !== 'myhost:2222' || !opened.verified || !opened.rerun) throw new Error('open @same resolved to ' + JSON.stringify(opened));
    const info = JSON.parse(await cli('info', '-t', opened.created));
    if (info.shell !== 'ssh' || info.name !== 'from-ssh' || !info.remote || info.remote.host !== 'myhost' || info.remote.cmd !== 'echo remote-ok' || !info.rerun) {
      throw new Error('unexpected tab opened over ssh: ' + JSON.stringify(info));
    }
    const text = await waitFor('the fake ssh.exe to complain about -t', 30000, async () => {
      const s = await cli('text', '-t', opened.created);
      return /bad option: -t/.test(s) ? s : null;
    });
    log('open @same: ' + opened.created + ' started ssh.exe with -t …: ' + text.trim().split(/\r?\n/).find((l) => /bad option/.test(l)));
    await cli('keys', '-t', 'osc', 'ctrl+c');
  } finally {
    events.close();
  }
}

// "Connect a server" through the packaged CLI and the running app, with USERPROFILE pointing at a throwaway
// folder (the CLI writes the ssh config of that profile; the real one is never touched):
//   - remote connect myserver --no-open: %USERPROFILE%\.ssh\config created with Kolonka's block, myserver
//     trusted ("always for this host") in the app and in its state.json, no tab
//   - remote connect myserver --name conn: the block is not added twice, a tab ssh -t … -- myserver through
//     remote.ssh (the fake ssh.exe of checkRemoteControl), marked rerun
//   - remote disconnect myserver: the block and the trust are gone, the backup of the file is there
async function checkConnect() {
  const home = path.join(DATA, 'home');
  fs.mkdirSync(home);
  const extra = { USERPROFILE: home };
  const file = path.join(home, '.ssh', 'config');
  const remembered = async () => JSON.parse(await api('GET', '/api/remote')).remembered;
  const out = await cliWith(extra, 'remote', 'connect', 'myserver', '--no-open');
  log('remote connect myserver --no-open:\n' + out.trimEnd());
  const text = fs.readFileSync(file, 'utf8');
  const want = ['# >>> kolonka: myserver', 'Host myserver', '    SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN', '# <<< kolonka: myserver', ''].join('\r\n');
  if (text !== want) throw new Error('unexpected ssh config after connect: ' + JSON.stringify(text));
  if (!(await remembered()).includes('myserver')) throw new Error('myserver is not trusted after connect');
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  if (!st.remote || !st.remote.allowedHosts.includes('myserver')) throw new Error('myserver is not in state.json after connect');
  const icacls = await new Promise((resolve) => execFile('icacls', [file], { windowsHide: true }, (_e, o) => resolve(String(o || ''))));
  log('icacls of the new config:\n' + icacls.trimEnd());
  if (/BUILTIN\\Users|Everyone/i.test(icacls)) throw new Error('the new ssh config is open to other users');

  const out2 = await cliWith(extra, 'remote', 'connect', 'myserver', '--name', 'conn');
  const id = (/tab: (s\d+)/.exec(out2) || [])[1];
  if (!id) throw new Error('connect did not open a tab: ' + out2);
  if (fs.readFileSync(file, 'utf8') !== want) throw new Error('connecting again changed the ssh config');
  const info = JSON.parse(await cli('info', '-t', id));
  if (info.shell !== 'ssh' || info.name !== 'conn' || !info.remote || info.remote.host !== 'myserver' || !info.rerun) throw new Error('unexpected connect tab: ' + JSON.stringify(info));
  const screen = await waitFor('the connect tab to start ssh.exe -t …', 30000, async () => {
    const s = await cli('text', '-t', id);
    return /bad option: -t/.test(s) ? s : null;
  });
  log('connect tab ' + id + ': ' + screen.trim().split(/\r?\n/).find((l) => /bad option/.test(l)));

  await cliWith(extra, 'remote', 'disconnect', 'myserver');
  if (fs.readFileSync(file, 'utf8') !== '') throw new Error('disconnect left: ' + JSON.stringify(fs.readFileSync(file, 'utf8')));
  if ((await remembered()).includes('myserver')) throw new Error('myserver is still trusted after disconnect');
  if (!fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('config.bak-kolonka-'))) throw new Error('no backup of the ssh config');
  log('connect / disconnect: ssh config, trust and tab as expected');
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
