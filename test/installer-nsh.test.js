'use strict';
// The PowerShell command the uninstaller runs to stop a leftover whisper-server (build/installer.nsh),
// run for real against a profile path with an apostrophe and brackets. Windows only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const NSH = path.join(__dirname, '..', 'build', 'installer.nsh');
const win = process.platform === 'win32';

// The command line of the nsExec::Exec call, with NSIS's $$ turned back into $ and $LOCALAPPDATA filled in.
function stopCommand(localAppData) {
  const line = fs.readFileSync(NSH, 'utf8').split(/\r?\n/).find((l) => /nsExec::Exec `powershell\.exe/.test(l) && /whisper-server/.test(l));
  assert.ok(line, 'the whisper-server stop command is in installer.nsh');
  const cmd = /`([^`]+)`/.exec(line)[1].replace(/\$LOCALAPPDATA/g, localAppData).replace(/\$\$/g, '$');
  return cmd.replace(/^powershell\.exe\s+/i, '');
}

function startFake(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'whisper-server.exe');
  // any long-running console program will do; it only has to carry the name
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), exe);
  const p = spawn(exe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => p.on('exit', () => r(true)));
  return { p, exited };
}

const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(false), ms))]);

test('the uninstaller stops only our whisper-server, also with an apostrophe in the profile path', { skip: !win && 'Windows only', timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-nsh-'));
  const profile = path.join(root, "O'Brien [dev]", 'AppData', 'Local');
  const ours = startFake(path.join(profile, 'Kolonka', 'whisper', 'bin-cpu', 'Release'));
  // same name, another folder that only starts like ours: must survive
  const other = startFake(path.join(profile, 'Kolonka', 'whisper-other'));
  t.after(() => {
    for (const f of [ours, other]) { try { f.p.kill(); } catch { /* gone */ } }
    return within(Promise.all([ours.exited, other.exited]), 5000).then(() => fs.rmSync(root, { recursive: true, force: true }));
  });

  const r = spawnSync('powershell.exe', [stopCommand(profile)], {
    windowsVerbatimArguments: true,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    // the uninstaller sets this right before the call
    env: Object.assign({}, process.env, { KOLONKA_WHISPER_DIR: path.join(profile, 'Kolonka', 'whisper') }),
  });
  assert.equal(r.status, 0, `PowerShell failed: ${r.stderr}`);
  assert.equal(r.stderr.trim(), '', 'no PowerShell errors');
  assert.equal(await within(ours.exited, 10000), true, 'our whisper-server is stopped');
  assert.equal(await within(other.exited, 1000), false, 'a whisper-server elsewhere is left alone');
});
