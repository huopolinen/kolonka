'use strict';
// bin/kolonka.cmd without node on PATH (Windows only). A copy of node.exe plays Kolonka.exe and a stand-in
// kolonka.js reports what it saw: the console code page during the call, ELECTRON_RUN_AS_NODE, its args.
// The console rendering itself cannot be observed here; the code page in effect is what decides it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const skip = process.platform !== 'win32' ? 'Windows only' : false;
const WRAPPER = path.join(__dirname, '..', 'bin', 'kolonka.cmd');

const STAND_IN = `
const { execSync } = require('child_process');
const fs = require('fs');
const cp = execSync('chcp', { encoding: 'utf8' }).replace(/\\D/g, '');
fs.writeFileSync(process.env.KOLONKA_TEST_OUT, JSON.stringify({ cp, args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE || null }));
process.stdout.write('\\u25cb \\u0436\\n');
process.exit(Number(process.env.KOLONKA_TEST_RC || 0));
`;

function layout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-cmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'resources', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, 'Kolonka.exe'));
  fs.copyFileSync(WRAPPER, path.join(bin, 'kolonka.cmd'));
  fs.writeFileSync(path.join(bin, 'kolonka.js'), STAND_IN);
  return { root, cmd: path.join(bin, 'kolonka.cmd') };
}

function runDriver(root, cmdPath, args, extraEnv) {
  const driver = path.join(root, 'driver.cmd');
  fs.writeFileSync(driver, [
    '@echo off',
    'chcp 437 >nul',
    'for /f "tokens=2 delims=:." %%c in (\'chcp\') do echo BEFORE=%%c',
    `call "${cmdPath}" ${args}`,
    'echo RC=%ERRORLEVEL%',
    'if defined ELECTRON_RUN_AS_NODE (echo ENV=leaked) else (echo ENV=clean)',
    'for /f "tokens=2 delims=:." %%c in (\'chcp\') do echo AFTER=%%c',
    '',
  ].join('\r\n'));
  const env = Object.assign({}, process.env, extraEnv);
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  env[pathKey] = env[pathKey].split(';').filter((d) => d && !fs.existsSync(path.join(d, 'node.exe'))).join(';');
  return new Promise((resolve, reject) => {
    execFile('cmd.exe', ['/d', '/c', driver], { env, encoding: 'buffer', timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      const text = stdout.toString('utf8');
      const val = (k) => ((new RegExp(`^${k}=(.*)$`, 'm').exec(text) || [])[1] || '').trim() || undefined;
      resolve({ text, val });
    });
  });
}

test('without node: UTF-8 code page during the call, restored after, no env leak, exit code kept', { skip }, async (t) => {
  const { root, cmd } = layout(t);
  const out = path.join(root, 'out.json');
  const r = await runDriver(root, cmd, 'tree --json', { KOLONKA_TEST_OUT: out, KOLONKA_TEST_RC: '3' });
  if (!r.val('BEFORE')) { t.skip('no console to read a code page from: ' + r.text); return; }
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(r.val('BEFORE'), '437');
  assert.equal(seen.cp, '65001', 'the console is UTF-8 while Kolonka.exe writes');
  assert.equal(seen.runAsNode, '1');
  assert.deepEqual(seen.args, ['tree', '--json']);
  assert.match(r.text, /○ ж/, 'the UTF-8 output arrives intact');
  assert.equal(r.val('RC'), '3', 'the exit code of the CLI is passed on');
  assert.equal(r.val('ENV'), 'clean', 'ELECTRON_RUN_AS_NODE does not leak into the calling cmd');
  assert.equal(r.val('AFTER'), '437', 'the code page is restored');
});

test('without node: stream and events leave the code page alone', { skip }, async (t) => {
  const { root, cmd } = layout(t);
  for (const sub of ['stream', 'events']) {
    const out = path.join(root, sub + '.json');
    const r = await runDriver(root, cmd, sub, { KOLONKA_TEST_OUT: out });
    if (!r.val('BEFORE')) { t.skip('no console to read a code page from'); return; }
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).cp, '437', sub);
    assert.equal(r.val('ENV'), 'clean', sub);
  }
});
