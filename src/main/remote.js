'use strict';
// Remote control over SSH: a program on a server (inside the ssh session of a tab) prints
//   ESC ] 7711 ; <action> ; key=value ; ... BEL
// and Kolonka acts on it: opens a tab connected to that server, sets the tab's status, shows a
// notification, renames the tab. Everything here is pure (no Electron, no pty) except listProcesses.
//
// Terminal output is untrusted: `cat` of a file or any program on the server can print these
// sequences. So values are base64 (no escaping games), hosts are checked against a strict pattern,
// a command from the server never becomes ssh options, and ssh is started without a shell.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { msysToWin } = require('./shells');

const STATUSES = ['idle', 'active', 'blocked', 'done'];
const MAX_OSC = 16384;        // longer payloads are ignored
const MAX_CMD = 4096;
const MAX_NAME = 80;
const MAX_TITLE = 80;
const MAX_TEXT = 300;
const HOST_RE = /^[A-Za-z0-9._@\[\]:-]+$/;
const SAME = '@same';

// Ignored when shown: C0/C1 controls, DEL, and bidi / zero-width format characters that can make a
// name or a command in the permission dialog read differently from what it is.
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Standard base64 (RFC 4648 §4) of UTF-8, padding optional. null for anything else.
function b64decode(s) {
  if (typeof s !== 'string') return null;
  if (!/^[A-Za-z0-9+/]*(={1,2})?$/.test(s)) return null;
  const body = s.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  if (s.length !== body.length && s.length % 4 !== 0) return null; // padding present, but wrong
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(body, 'base64')); } catch { return null; }
}

function b64encode(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

// A one-line label: controls and format characters removed, whitespace collapsed, cut to `max`.
function sanitize(s, max) {
  const v = String(s == null ? '' : s).replace(CONTROLS, ' ').replace(FORMAT, '').replace(/\s+/g, ' ').trim();
  return Array.from(v).slice(0, max).join('');
}

// An ssh destination the server may name: host, user@host, an alias from ~/.ssh/config, an IP.
// Never something ssh could take for an option.
function validHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 255 && HOST_RE.test(h) && !h.startsWith('-');
}

// The remote command is shown to the user before it runs, so it must read exactly as it is:
// no control characters (a tab is fine) and no bidi / zero-width tricks.
function validCmd(c) {
  return typeof c === 'string' && c.length <= MAX_CMD && !/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(c) && !/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(c);
}

// The payload of OSC 7711 (everything after "7711;") -> { action, ... } or { error }.
function parseRemoteOsc(data) {
  if (typeof data !== 'string') return { error: 'not a string' };
  if (data.length > MAX_OSC) return { error: `longer than ${MAX_OSC} characters` };
  const parts = data.split(';');
  const action = parts.shift().trim();
  const f = Object.create(null);
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue; // not key=value: ignored, like unknown keys
    const k = p.slice(0, i).trim();
    if (k in f) return { error: `duplicate field "${k}"` };
    f[k] = p.slice(i + 1).trim();
  }
  const dec = (k) => {
    if (f[k] === undefined) return undefined;
    const v = b64decode(f[k]);
    if (v === null) throw new Error(`field "${k}" is not valid base64 of UTF-8`);
    return v;
  };
  try {
    switch (action) {
      case 'open': {
        const host = dec('host');
        if (!host) return { error: 'open needs host' };
        if (host !== SAME && !validHost(host)) return { error: 'open: host is not a valid ssh destination' };
        const cmd = dec('cmd') || '';
        if (!validCmd(cmd)) return { error: 'open: cmd has control characters or is too long' };
        const sel = f.select === undefined ? '1' : f.select;
        if (sel !== '0' && sel !== '1') return { error: 'open: select must be 0 or 1' };
        return { action, host, cmd, name: sanitize(dec('name'), MAX_NAME), ws: sanitize(dec('ws'), MAX_NAME), select: sel === '1' };
      }
      case 'status': {
        if (!STATUSES.includes(f.state)) return { error: `status: state must be one of ${STATUSES.join(', ')}` };
        return { action, state: f.state };
      }
      case 'notify': {
        const title = sanitize(dec('title'), MAX_TITLE);
        const text = sanitize(dec('text'), MAX_TEXT);
        if (!title && !text) return { error: 'notify needs title or text' };
        return { action, title, text };
      }
      case 'rename': {
        const name = sanitize(dec('name'), MAX_NAME);
        if (!name) return { error: 'rename needs name' };
        return { action, name };
      }
      default: return { error: `unknown action "${sanitize(action, 20)}"` };
    }
  } catch (e) { return { error: e.message }; }
}

// OSC 9 (ConEmu / iTerm2 / Windows Terminal): "9;<text>" is a notification, but ConEmu also uses
// "9;N" and "9;N;…" for other things (9;9 = cwd, 9;4 = progress …): those are not notifications.
// `data` is the payload after "9;".
function notifyFromOsc9(data) {
  if (typeof data !== 'string' || data.length > MAX_OSC || /^\d+(;|$)/.test(data)) return null;
  const text = sanitize(data, MAX_TEXT);
  return text ? { action: 'notify', title: '', text } : null;
}

// OSC 777 (urxvt, Ghostty, foot): "notify;<title>;<body>". `data` is the payload after "777;".
function notifyFromOsc777(data) {
  if (typeof data !== 'string' || data.length > MAX_OSC) return null;
  const parts = data.split(';');
  if (parts[0] !== 'notify') return null;
  const title = sanitize(parts[1], MAX_TITLE);
  const text = sanitize(parts.slice(2).join(';'), MAX_TEXT);
  return title || text ? { action: 'notify', title, text } : null;
}

// ---------- ssh command lines ----------

// Split a Windows command line the way the C runtime (and CommandLineToArgvW) does.
function parseWinCommandLine(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  let first = true;
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) break;
    let arg = '';
    if (first) {
      // the program name: quotes group, backslashes are literal
      if (s[i] === '"') { i++; while (i < n && s[i] !== '"') arg += s[i++]; i++; } else { while (i < n && s[i] !== ' ' && s[i] !== '\t') arg += s[i++]; }
      out.push(arg);
      first = false;
      continue;
    }
    let quoted = false;
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        let k = 0;
        while (s[i] === '\\') { k++; i++; }
        if (s[i] === '"') { arg += '\\'.repeat(k >> 1); if (k & 1) { arg += '"'; i++; } } else arg += '\\'.repeat(k);
        continue;
      }
      if (c === '"') {
        if (quoted && s[i + 1] === '"') { arg += '"'; i += 2; continue; } // "" inside quotes = a literal quote
        quoted = !quoted; i++; continue;
      }
      if (!quoted && (c === ' ' || c === '\t')) break;
      arg += c; i++;
    }
    out.push(arg);
  }
  return out;
}

// Options of OpenSSH's getopt string that take an argument.
const WITH_ARG = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
// The only options carried over to a new tab. Never -o (ProxyCommand, LocalCommand …), -F, -E,
// forwardings (-L -R -D -W), the control socket (-S -O) or the agent (-A).
const SAFE = new Set(['p', 'l', 'i', 'J', '4', '6']);

// ssh's arguments (without the program name) -> { destination, options } or null.
// Like ssh, options may also come after the destination; the first word after it starts the remote command.
function parseSshArgs(argv) {
  let dest = null;
  let terminated = false;
  const opts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!terminated && a === '--') { terminated = true; continue; }
    if (!terminated && a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (WITH_ARG.has(f)) {
          let val = a.slice(j + 1);
          if (!val) { i++; val = argv[i]; if (val === undefined) return null; }
          if (SAFE.has(f)) opts.push('-' + f, val);
          break;
        }
        if (SAFE.has(f)) opts.push('-' + f);
      }
      continue;
    }
    if (dest !== null) break; // the remote command
    dest = a;
    if (terminated) break;
  }
  if (dest === null) return null;
  const uri = /^ssh:\/\/(?:([^@/;:]+)@)?([^@/:[\]]+|\[[^\]/]+\])(?::(\d+))?\/?$/.exec(dest);
  if (uri) {
    dest = (uri[1] ? uri[1] + '@' : '') + uri[2];
    if (uri[3]) opts.push('-p', uri[3]);
  }
  const options = cleanOptions(opts);
  if (!options || !validHost(dest)) return null;
  return { destination: dest, options };
}

// Checks a list of carried-over options; null if any is not allowed. -i paths written the msys way
// (/c/Users/…, from Git Bash's ssh) become Windows paths for the Windows ssh.exe.
function cleanOptions(opts) {
  if (!Array.isArray(opts)) return null;
  const out = [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (o === '-4' || o === '-6') { out.push(o); continue; }
    const v = opts[i + 1];
    if (typeof v !== 'string' || !v || v.startsWith('-') || /[\x00-\x1f\x7f]/.test(v)) return null;
    i++;
    if (o === '-p') { if (!/^\d{1,5}$/.test(v) || +v < 1 || +v > 65535) return null; out.push(o, v); } else if (o === '-l') { if (v.length > 64 || /\s/.test(v)) return null; out.push(o, v); } else if (o === '-J') { if (v.length > 512 || !/^[A-Za-z0-9._@\[\]:,%-]+$/.test(v)) return null; out.push(o, v); } else if (o === '-i') { if (v.length > 1024) return null; out.push(o, (/^\/[a-zA-Z](\/|$)/.test(v) && msysToWin(v)) || v); } else return null;
  }
  return out;
}

// A saved or passed ssh spec { destination, options, cmd } checked again, or null.
function normalizeSsh(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const options = cleanOptions(spec.options || []);
  const cmd = spec.cmd == null ? '' : spec.cmd;
  if (!options || !validHost(spec.destination) || !validCmd(cmd)) return null;
  return { destination: spec.destination, options, cmd };
}

// Arguments for ssh.exe: a terminal, our two env variables, the carried-over options, then the
// destination and the command after `--`, so neither can be read as an option. The command is a
// single argument: the remote shell interprets it, nothing on this computer does.
function buildSshArgs({ destination, options, cmd }) {
  return ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', ...(options || []), '--', destination, ...(cmd ? [cmd] : [])];
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// ssh.exe: settings remote.ssh, then the OpenSSH client of Windows, then the one of Git for Windows.
function findSshExe(setting, { env = process.env, exists = fileExists, platform = process.platform } = {}) {
  if (typeof setting === 'string' && setting.trim()) return exists(setting.trim()) ? setting.trim() : null;
  if (platform !== 'win32') return ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'].find(exists) || null;
  const candidates = [
    path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'usr', 'bin', 'ssh.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'usr', 'bin', 'ssh.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'ssh.exe'),
  ].filter(Boolean);
  return candidates.find(exists) || null;
}

// ---------- the ssh connection of a tab ----------

const isSsh = (name) => /^ssh(\.exe)?$/i.test(String(name || ''));

// The ssh process a tab is connected through: procs is [{ pid, ppid, name, cmd, started }], root the
// pid node-pty reports (the shell under ConPTY). Descendants only (a reused parent pid of an older
// process is not followed), not below another ssh (the -J helper), the most recently started one.
function findSshInTree(rootPid, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const root = byPid.get(rootPid);
  if (!root) return null;
  if (isSsh(root.name)) return root;
  const kids = new Map();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const found = [];
  const seen = new Set([root.pid]);
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    for (const c of kids.get(cur.pid) || []) {
      if (seen.has(c.pid)) continue;
      if (cur.started && c.started && c.started < cur.started) continue; // the pid belonged to an older process
      seen.add(c.pid);
      if (isSsh(c.name)) found.push(c); else queue.push(c);
    }
  }
  if (!found.length) return null;
  return found.reduce((a, b) => ((b.started || 0) >= (a.started || 0) ? b : a));
}

// The ssh connection of the process tree under rootPid: { destination, options } or null.
function sshOriginFromTree(rootPid, procs) {
  const p = findSshInTree(rootPid, procs);
  if (!p || typeof p.cmd !== 'string') return null;
  const argv = parseWinCommandLine(p.cmd);
  return parseSshArgs(argv.slice(1));
}

const PS_LIST = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object {',
  '  $t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }',
  "  $c = $null; if ($_.Name -match '^ssh(\\.exe)?$') { $c = $_.CommandLine }",
  '  [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $c; t = $t }',
  '} | ConvertTo-Json -Compress',
].join('\n');

// All processes (command lines of ssh processes only), through PowerShell / CIM. Resolves to [] on
// other platforms; rejects on a timeout or a failure.
function listProcesses({ timeout = 10000, env = process.env } = {}) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const ps = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_LIST],
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        if (err) return reject(new Error('process list: ' + (err.killed ? 'timed out' : err.message)));
        resolve(parseProcessList(stdout));
      });
  });
}

function parseProcessList(stdout) {
  let v;
  try { v = JSON.parse(String(stdout).trim() || '[]'); } catch { return []; }
  if (!Array.isArray(v)) v = [v];
  return v.filter((x) => x && Number.isInteger(x.p)).map((x) => ({ pid: x.p, ppid: x.q, name: x.n, cmd: x.c, started: x.t || 0 }));
}

// ---------- limits ----------

// At most `limit` events per `windowMs` for each key (a sliding window).
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  take(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    const ok = list.length < this.limit;
    if (ok) list.push(now);
    this.hits.set(key, list);
    return ok;
  }
  forget(key) { this.hits.delete(key); }
}

// An entry of allowHosts matches the destination itself, or, without a user part, its host:
// "myserver" allows "myserver" and "leo@myserver"; "leo@myserver" only that.
function hostMatches(entry, dest) {
  if (typeof entry !== 'string' || typeof dest !== 'string') return false;
  const e = entry.trim().toLowerCase();
  const d = dest.toLowerCase();
  if (!e) return false;
  if (e === d) return true;
  return !e.includes('@') && d.slice(d.lastIndexOf('@') + 1) === e;
}

module.exports = {
  STATUSES, SAME, MAX_NAME, MAX_TEXT, MAX_TITLE, MAX_CMD,
  b64decode, b64encode, sanitize, validHost, validCmd,
  parseRemoteOsc, notifyFromOsc9, notifyFromOsc777,
  parseWinCommandLine, parseSshArgs, cleanOptions, normalizeSsh, buildSshArgs, findSshExe,
  findSshInTree, sshOriginFromTree, listProcesses, parseProcessList,
  RateLimiter, hostMatches,
};
