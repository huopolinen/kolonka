'use strict';
// Install → hooks → uninstall round trip of the NSIS installer. Windows only; run after
// `electron-builder --win nsis --prepackaged dist/win-unpacked`.
//   node test/smoke/installer.js [path\to\Kolonka-Setup.exe]
// Checks that the hooks run without node in PATH, that a silent uninstall removes them (old and new format)
// and keeps the user's other hooks, that the hook command stays silent once Kolonka is gone, and that
// a silent uninstall keeps the downloaded voice files.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));
const SETUP = path.resolve(process.argv[2] || path.join(ROOT, 'dist', `Kolonka-Setup-${pkg.version}.exe`));
const INST = path.join(process.env.LOCALAPPDATA, 'Programs', 'Kolonka');
const EXE = path.join(INST, 'Kolonka.exe');
const BIN = path.join(INST, 'resources', 'bin');
const UNINSTALLER = path.join(INST, 'Uninstall Kolonka.exe');
const WHISPER = path.join(process.env.LOCALAPPDATA, 'Kolonka', 'whisper');
const GIT_BASH = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const MARK = '# kolonka-status-hook';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-installer-'));
const CLAUDE = path.join(WORK, 'claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const log = (...a) => console.log('[installer]', ...a);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function env(extra = {}) {
  const e = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CLAUDE }, extra);
  delete e.KOLONKA_SESSION;
  return e;
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, Object.assign({ encoding: 'utf8', timeout: 300000, windowsHide: true, env: env() }, opts));
  log(`${path.basename(file)} ${args.join(' ').slice(0, 80)} -> ${r.error ? r.error.message : 'exit ' + r.status}`);
  return r;
}

const commands = () => {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  return Object.values(cfg.hooks || {}).flat().flatMap((m) => m.hooks).map((h) => h.command);
};

// PATH without any node.exe: the hooks must still work through Kolonka.exe.
function pathWithoutNode() {
  return (process.env.PATH || '').split(';').filter((d) => d && !fs.existsSync(path.join(d, 'node.exe'))).join(';');
}

function waitGone(file, ms) {
  const t0 = Date.now();
  while (fs.existsSync(file)) {
    if (Date.now() - t0 > ms) throw new Error(`${file} is still there after ${ms} ms`);
    sleep(1000);
  }
}

function main() {
  assert.ok(fs.existsSync(SETUP), `installer not found: ${SETUP}`);
  assert.ok(fs.existsSync(GIT_BASH), 'Git Bash is needed for this test');
  assert.ok(!fs.existsSync(EXE), `Kolonka is already installed in ${INST}`);

  // a settings.json as Kolonka 0.1 left it, plus a hook of the user's own
  fs.mkdirSync(CLAUDE, { recursive: true });
  const legacy = `node "${path.join(BIN, 'kolonka.js').replace(/\\/g, '/')}" status active --quiet`;
  fs.writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacy }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }, null, 2));

  // a stand-in for downloaded voice files; a silent uninstall must keep them
  const fakeWhisper = !fs.existsSync(WHISPER);
  if (fakeWhisper) { fs.mkdirSync(WHISPER, { recursive: true }); fs.writeFileSync(path.join(WHISPER, 'marker.txt'), 'x'); }

  try {
    const inst = run(SETUP, ['/S']);
    assert.equal(inst.status, 0, 'installer exit code');
    assert.ok(fs.existsSync(EXE), 'Kolonka.exe installed');

    // install the hooks with the installed CLI, through the app's own Node runtime
    const r = run(EXE, [path.join(BIN, 'kolonka.js'), 'hooks', 'install'], { env: env({ ELECTRON_RUN_AS_NODE: '1' }) });
    assert.equal(r.status, 0, r.stderr);
    let cmds = commands();
    assert.equal(cmds.filter((c) => c.includes(MARK)).length, 4, 'four current hooks');
    assert.ok(!cmds.includes(legacy), 'the legacy hook is replaced');
    assert.ok(cmds.includes('echo user-hook'), 'the user hook is kept');

    // the hook runs in Git Bash without node in PATH
    const hook = cmds.find((c) => c.includes(MARK) && c.includes('status active'));
    const noNode = env({ PATH: pathWithoutNode() });
    let h = run(GIT_BASH, ['-c', hook], { env: noNode });
    assert.equal(h.status, 0, h.stderr);
    assert.equal((h.stdout + h.stderr).trim(), '', 'the hook is silent outside a Kolonka tab');
    const st = run(GIT_BASH, ['-c', `sh '${path.join(BIN, 'kolonka').replace(/\\/g, '/')}' hooks status`], { env: noNode });
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /^installed/, 'the launcher falls back to Kolonka.exe without node');

    // put the legacy hook back next to the new ones: uninstall must remove both
    const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    cfg.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: legacy }] });
    fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2));

    const un = run(UNINSTALLER, ['/S']);
    assert.equal(un.status, 0, 'uninstaller exit code');
    waitGone(EXE, 120000); // the uninstaller re-runs itself from %TEMP% and returns early
    sleep(2000);

    cmds = commands();
    assert.deepEqual(cmds, ['echo user-hook'], 'only the user hook is left');
    h = run(GIT_BASH, ['-c', hook], { env: noNode });
    assert.equal(h.status, 0, 'the hook exits 0 once Kolonka is removed');
    assert.equal((h.stdout + h.stderr).trim(), '', 'and prints nothing');
    if (fakeWhisper) assert.ok(fs.existsSync(path.join(WHISPER, 'marker.txt')), 'a silent uninstall keeps the voice files');
    log('ok');
  } finally {
    if (fakeWhisper) {
      fs.rmSync(WHISPER, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(WHISPER)); } catch { /* not empty or gone */ }
    }
    if (fs.existsSync(UNINSTALLER)) run(UNINSTALLER, ['/S']);
    fs.rmSync(WORK, { recursive: true, force: true });
  }
}

main();
