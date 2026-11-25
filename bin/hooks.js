'use strict';
// Claude Code hooks that set the status of their Kolonka tab (active / blocked / done).
// Used by both the CLI (`kolonka hooks install`) and the app (command palette).
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENTS = {
  UserPromptSubmit: 'active',
  PostToolUse: 'active',
  Notification: 'blocked',
  Stop: 'done',
};

function findOnPath(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir.replace(/^"|"$/g, ''), exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

// Hook command: via node when available (faster), otherwise via kolonka.cmd (works without node).
function hookCommand(status) {
  const js = path.join(__dirname, 'kolonka.js').replace(/\\/g, '/');
  const cmd = path.join(__dirname, 'kolonka.cmd').replace(/\\/g, '/');
  const runner = findOnPath('node.exe') ? `node "${js}"` : `"${cmd}"`;
  return `${runner} status ${status} --quiet`;
}

function settingsFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

const isOurs = (h) => h && typeof h.command === 'string' && /kolonka(\.js|\.cmd)?"? status /.test(h.command);

function plan() {
  const out = {};
  for (const [ev, st] of Object.entries(EVENTS)) out[ev] = [{ hooks: [{ type: 'command', command: hookCommand(st) }] }];
  return out;
}

function installed() {
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return Object.keys(EVENTS).every((ev) => (cfg.hooks?.[ev] || []).some((m) => (m.hooks || []).some(isOurs)));
  } catch { return false; }
}

// remove=false installs (replacing our old entries), true removes. Backs up settings.json.
function install(remove = false) {
  const file = settingsFile();
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    cfg = raw.trim() ? JSON.parse(raw) : {};
    fs.copyFileSync(file, file + '.kolonka-backup');
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  cfg.hooks = cfg.hooks || {};
  const p = plan();
  for (const ev of Object.keys(EVENTS)) {
    const list = (cfg.hooks[ev] || [])
      .map((m) => Object.assign({}, m, { hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length);
    if (!remove) list.push(p[ev][0]);
    if (list.length) cfg.hooks[ev] = list; else delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

module.exports = { plan, install, installed, settingsFile, EVENTS };
