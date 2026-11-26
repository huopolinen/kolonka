'use strict';
// Claude Code hooks that set the status of their Kolonka tab (active / blocked / done).
// Used by both the CLI (`kolonka hooks install`) and the app (command palette), and by the uninstaller.
const fs = require('fs');
const path = require('path');
const os = require('os');

const EVENTS = {
  UserPromptSubmit: 'active',
  PostToolUse: 'active',
  Notification: 'blocked',
  Stop: 'done',
};

// Every hook command we write ends with this comment, so we can find our hooks whatever the path.
const MARK = '# kolonka-status-hook';
// Hooks written by Kolonka 0.1: `node "…/kolonka.js" status active --quiet` or `"…/kolonka.cmd" status …`.
const LEGACY = /kolonka(\.js|\.cmd)?["']? status (idle|active|blocked|done)\b/;

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function findOnPath(exe, env = process.env) {
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir.replace(/^"|"$/g, ''), exe);
    if (exists(p)) return p;
  }
  return null;
}

// Claude Code runs hook commands in Git Bash on Windows, or in PowerShell when Git Bash is not
// installed. Look for Git Bash the way it does: CLAUDE_CODE_GIT_BASH_PATH, the usual install
// folders, or next to git.exe on PATH.
function hasGitBash(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return true;
  if (env.CLAUDE_CODE_GIT_BASH_PATH && exists(env.CLAUDE_CODE_GIT_BASH_PATH)) return true;
  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  if (candidates.some(exists)) return true;
  const git = findOnPath('git.exe', env);
  return !!git && exists(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'));
}

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

// The hook entry for one status. It does not depend on `node` in PATH (the launcher scripts fall back
// to Kolonka.exe), and it stays silent and exits 0 if Kolonka has been removed, so Claude Code never
// shows a hook error because of us.
function hookEntry(status, { shell = hasGitBash() ? 'bash' : 'powershell', binDir = __dirname } = {}) {
  if (shell === 'powershell') {
    const cmd = path.join(binDir, 'kolonka.cmd');
    return {
      type: 'command',
      shell: 'powershell',
      command: `$k = ${psQuote(cmd)}; if (Test-Path -LiteralPath $k) { & $k status ${status} --quiet }; exit 0 ${MARK}`,
    };
  }
  const sh = path.join(binDir, 'kolonka').replace(/\\/g, '/');
  return { type: 'command', command: `k=${shQuote(sh)}; [ -f "$k" ] && sh "$k" status ${status} --quiet; exit 0 ${MARK}` };
}

function settingsFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

const isOurs = (h) => !!h && typeof h.command === 'string' && (h.command.includes(MARK) || LEGACY.test(h.command));

function plan(opts) {
  const out = {};
  for (const [ev, st] of Object.entries(EVENTS)) out[ev] = [{ hooks: [hookEntry(st, opts)] }];
  return out;
}

// Hooks for Claude Code running on a server in a Kolonka ssh tab: they call the kolonka-remote script
// (`kolonka remote install`), which prints the status as OSC 7711 to the terminal. Silent, and exit 0
// when the script is missing or the terminal is not Kolonka.
const REMOTE_MARK = '# kolonka-remote-status-hook';
function remoteHookEntry(status) {
  return {
    type: 'command',
    command: `k="$HOME/.local/bin/kolonka"; [ -x "$k" ] || k=$(command -v kolonka 2>/dev/null); [ -n "$k" ] && "$k" status ${status} >/dev/null 2>&1; exit 0 ${REMOTE_MARK}`,
  };
}

function remotePlan() {
  const out = {};
  for (const [ev, st] of Object.entries(EVENTS)) out[ev] = [{ hooks: [remoteHookEntry(st)] }];
  return out;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, cfg: raw.trim() ? JSON.parse(raw) : {} };
}

function installed() {
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return Object.keys(EVENTS).every((ev) => (cfg.hooks?.[ev] || []).some((m) => (m.hooks || []).some(isOurs)));
  } catch { return false; }
}

// Synchronous pause for the retry below (the CLI and the uninstaller are synchronous).
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Write next to the target and rename over it, so Claude Code never reads a half-written settings.json.
// A symlinked settings.json (dotfiles) stays a symlink: the file it points to is replaced.
function writeAtomic(file, text) {
  let target = file;
  try { target = fs.realpathSync(file); } catch { /* new file */ }
  const tmp = `${target}.kolonka-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, target); return; } catch (e) {
      // Windows: the file can be briefly locked by a reader
      if (i < 5 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { pause(50 * (i + 1)); continue; }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
}

// remove=false installs (replacing our old entries, in any format), true removes them.
// Nothing is written when nothing changes. The first original settings.json is kept as
// settings.json.kolonka-backup and never overwritten by later runs.
function install(remove = false, opts) {
  const file = settingsFile();
  const cur = readConfig(file);
  if (!cur && remove) return file;
  const cfg = cur ? cur.cfg : {};
  const before = JSON.stringify(cfg);
  cfg.hooks = cfg.hooks || {};
  const p = plan(opts);
  for (const ev of Object.keys(EVENTS)) {
    const list = (cfg.hooks[ev] || [])
      .map((m) => Object.assign({}, m, { hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length);
    if (!remove) list.push(p[ev][0]);
    if (list.length) cfg.hooks[ev] = list; else delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (cur && JSON.stringify(cfg) === before) return file;
  if (cur) {
    try { fs.copyFileSync(file, file + '.kolonka-backup', fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

// Bring hooks written by an older version (or for another install path) up to date.
// Does nothing if our hooks are not installed. Returns true if it rewrote them.
function migrate(opts) {
  let cur;
  try { cur = readConfig(settingsFile()); } catch { return false; }
  if (!cur || !cur.cfg.hooks) return false;
  const want = plan(opts);
  let ours = 0;
  let stale = false;
  for (const ev of Object.keys(EVENTS)) {
    for (const m of cur.cfg.hooks[ev] || []) {
      for (const h of m.hooks || []) {
        if (!isOurs(h)) continue;
        ours++;
        const w = want[ev][0].hooks[0];
        if (h.command !== w.command || h.shell !== w.shell) stale = true;
      }
    }
  }
  if (!ours || !stale) return false;
  install(false, opts);
  return true;
}

module.exports = { plan, remotePlan, remoteHookEntry, install, installed, migrate, settingsFile, hookEntry, hasGitBash, isOurs, EVENTS, MARK, REMOTE_MARK };
