'use strict';
// Hooks must not break Claude Code: no dependency on node in PATH, silent once Kolonka is removed,
// old-format hooks replaced and removed, settings.json written atomically, the first backup kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const hooks = require('../bin/hooks');

function configDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-hooks-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const commands = (cfg) => Object.values(cfg.hooks || {}).flat().flatMap((m) => m.hooks).map((h) => h.command);

// What Kolonka 0.1 wrote into settings.json.
const LEGACY = {
  theme: 'dark',
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "C:/Users/a/AppData/Local/Programs/Kolonka/resources/bin/kolonka.js" status active --quiet' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'node "C:/Users/a/AppData/Local/Programs/Kolonka/resources/bin/kolonka.js" status active --quiet' }] }],
    Notification: [{ hooks: [{ type: 'command', command: '"C:/Users/a/AppData/Local/Programs/Kolonka/resources/bin/kolonka.cmd" status blocked --quiet' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node "C:/Users/a/AppData/Local/Programs/Kolonka/resources/bin/kolonka.js" status done --quiet' }, { type: 'command', command: 'say done' }] }],
  },
};

for (const shell of ['bash', 'powershell']) {
  test(`${shell} hook commands do not call node directly and always exit 0`, () => {
    const e = hooks.hookEntry('active', { shell, binDir: 'C:\\Program Files\\Kolonka\\resources\\bin' });
    assert.doesNotMatch(e.command, /(^|[;&|]\s*)node\b/);
    assert.match(e.command, /exit 0/);
    assert.ok(e.command.includes(hooks.MARK));
    assert.ok(hooks.isOurs(e));
    assert.equal(e.shell, shell === 'powershell' ? 'powershell' : undefined);
  });
}

test('install replaces hooks written by Kolonka 0.1', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(LEGACY, null, 2));
  hooks.install(false, { shell: 'bash' });
  const cmds = commands(read(file));
  assert.equal(cmds.filter((c) => /kolonka\.(js|cmd)" status/.test(c)).length, 0, 'no legacy command is left');
  assert.equal(cmds.filter((c) => c.includes(hooks.MARK)).length, 4);
  assert.ok(cmds.includes('say done'));
});

test('uninstall removes hooks in both the old and the new format', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  const mixed = JSON.parse(JSON.stringify(LEGACY));
  mixed.hooks.Stop[0].hooks.push(hooks.hookEntry('done', { shell: 'powershell' }));
  fs.writeFileSync(file, JSON.stringify(mixed, null, 2));
  hooks.install(true);
  assert.deepEqual(read(file), { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('migrate rewrites old hooks and leaves current ones and foreign files alone', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  assert.equal(hooks.migrate({ shell: 'bash' }), false, 'no settings.json: nothing to do');
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }));
  assert.equal(hooks.migrate({ shell: 'bash' }), false, 'our hooks are not installed: nothing to do');
  fs.writeFileSync(file, JSON.stringify(LEGACY));
  assert.equal(hooks.migrate({ shell: 'bash' }), true);
  assert.equal(commands(read(file)).filter((c) => c.includes(hooks.MARK)).length, 4);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(hooks.migrate({ shell: 'bash' }), false, 'already current');
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('the first backup is kept, later installs do not overwrite it', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'original' }));
  hooks.install(false, { shell: 'bash' });
  hooks.install(false, { shell: 'powershell' }); // rewrites the file again
  assert.deepEqual(read(file + '.kolonka-backup'), { theme: 'original' });
  hooks.install(true);
  assert.deepEqual(read(file + '.kolonka-backup'), { theme: 'original' });
});

test('uninstall without a settings.json creates nothing', (t) => {
  const dir = configDir(t);
  hooks.install(true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('uninstall when our hooks are absent does not rewrite the file', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  const raw = '{"theme":"dark"}';
  fs.writeFileSync(file, raw);
  hooks.install(true);
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'formatting kept, file untouched');
  assert.equal(fs.existsSync(file + '.kolonka-backup'), false);
});

test('settings.json is replaced by rename, no temporary file is left', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}');
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([a, b]); return orig(a, b); };
  t.after(() => { fs.renameSync = orig; });
  hooks.install(false, { shell: 'bash' });
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], fs.realpathSync(file));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.kolonka-backup']);
});

test('a broken settings.json is not overwritten', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ "theme": "dark", // comment\n}');
  assert.throws(() => hooks.install(false, { shell: 'bash' }), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "theme": "dark", // comment\n}');
});

// ---------- the commands really run ----------
// A launcher folder with a fake `kolonka` (sh) and `kolonka.cmd` that record their arguments.
function fakeBin(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka bin '));
  const bin = path.join(root, "it's here");
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'args.txt');
  fs.writeFileSync(path.join(bin, 'kolonka'), `#!/bin/sh\necho "$@" > '${log.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'\n`);
  fs.writeFileSync(path.join(bin, 'kolonka.cmd'), `@echo off\r\necho %*> "${log}"\r\n`);
  return { bin, log };
}

function gitBash() {
  if (process.platform !== 'win32') return '/bin/sh';
  const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  return fs.existsSync(p) ? p : null;
}

test('the bash hook runs the launcher, and is silent with exit 0 once it is gone', { skip: !gitBash() && 'no Git Bash' }, (t) => {
  const { bin, log } = fakeBin(t);
  const { command } = hooks.hookEntry('blocked', { shell: 'bash', binDir: bin });
  execFileSync(gitBash(), ['-c', command]);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'status blocked --quiet');
  fs.rmSync(bin, { recursive: true, force: true });
  const r = spawnSync(gitBash(), ['-c', command], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('the PowerShell hook runs the launcher, and is silent with exit 0 once it is gone', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const { bin, log } = fakeBin(t);
  const { command } = hooks.hookEntry('done', { shell: 'powershell', binDir: bin });
  const ps = (c) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c], { encoding: 'utf8' });
  const r1 = ps(command);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'status done --quiet');
  fs.rmSync(bin, { recursive: true, force: true });
  const r2 = ps(command);
  assert.equal(r2.status, 0);
  assert.equal((r2.stdout + r2.stderr).trim(), '');
});
