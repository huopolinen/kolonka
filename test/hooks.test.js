'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hooks = require('../bin/hooks');

// Point hooks.js at a throwaway Claude config directory for the duration of a test.
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
const ours = (h) => / status (active|blocked|done) --quiet$/.test(h.command) && /kolonka/.test(h.command);

const FOREIGN = {
  theme: 'dark',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
  },
};

test('settingsFile follows CLAUDE_CONFIG_DIR', (t) => {
  const dir = configDir(t);
  assert.equal(hooks.settingsFile(), path.join(dir, 'settings.json'));
});

test('settingsFile falls back to ~/.claude', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-home-'));
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(hooks.settingsFile(), path.join(home, '.claude', 'settings.json'));
});

test('install into a missing settings.json adds one hook per event', (t) => {
  const dir = configDir(t);
  assert.equal(hooks.installed(), false);
  const file = hooks.install();
  assert.equal(file, path.join(dir, 'settings.json'));
  const cfg = read(file);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), Object.keys(hooks.EVENTS).sort());
  for (const [ev, status] of Object.entries(hooks.EVENTS)) {
    const cmds = cfg.hooks[ev].flatMap((m) => m.hooks).map((h) => h.command);
    assert.equal(cmds.length, 1);
    assert.match(cmds[0], new RegExp(` status ${status} --quiet$`));
  }
  assert.equal(hooks.installed(), true);
});

test('install is idempotent', (t) => {
  const dir = configDir(t);
  hooks.install();
  const first = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  hooks.install();
  hooks.install();
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), first);
});

test('install keeps other settings and hooks, and backs the file up', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));
  hooks.install();
  const cfg = read(file);
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(cfg.permissions, FOREIGN.permissions);
  assert.deepEqual(cfg.hooks.PreToolUse, FOREIGN.hooks.PreToolUse);
  const stop = cfg.hooks.Stop.flatMap((m) => m.hooks);
  assert.ok(stop.some((h) => h.command === 'say done'), 'the foreign Stop hook is kept');
  assert.equal(stop.filter(ours).length, 1);
  assert.deepEqual(read(file + '.kolonka-backup'), FOREIGN);
});

test('uninstall removes only our hooks', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));
  hooks.install();
  hooks.install(true);
  assert.equal(hooks.installed(), false);
  assert.deepEqual(read(file), FOREIGN);
});

test('uninstall of our hooks alone leaves no hooks section', (t) => {
  const dir = configDir(t);
  const file = path.join(dir, 'settings.json');
  hooks.install();
  hooks.install(true);
  assert.deepEqual(read(file), {});
});

test('plan lists a command for every event', () => {
  const p = hooks.plan();
  assert.deepEqual(Object.keys(p).sort(), Object.keys(hooks.EVENTS).sort());
  for (const ev of Object.keys(p)) assert.ok(p[ev][0].hooks.every(ours));
});
