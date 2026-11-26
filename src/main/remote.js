'use strict';
// Remote control over SSH: a program on a server (inside the ssh session of a tab) prints
//   ESC ] 7711 ; <action> ; key=value ; ... BEL
// and Kolonka acts on it: opens a tab connected to that server, sets the tab's status, shows a
// notification, renames the tab. Everything here is pure (no Electron, no pty) except listProcesses.
//
// Terminal output is untrusted: `cat` of a file or any program on the server can print these
// sequences. So values are base64 (no escaping games), a request is trusted only with the tab's own
// token (LC_KOLONKA_TOKEN, which only processes of that ssh session have), hosts are checked against
// a strict pattern, a command from the server never becomes ssh options, and ssh is started without
// a shell, with a command line Kolonka quotes itself.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { msysToWin } = require('./shells');

const STATUSES = ['idle', 'active', 'blocked', 'done'];
const MAX_OSC = 16384;        // longer payloads are ignored
const MAX_CMD = 512;
const MAX_NAME = 80;
const MAX_TITLE = 80;
const MAX_TEXT = 300;
const MAX_TOKEN = 128;
// no leading @ (an msys @file argument) or - (an option); no brackets
const HOST_RE = /^[A-Za-z0-9._@:-]+$/;
const SAME = '@same';

// C0/C1 controls and DEL; invisible and direction-changing characters that can make a name or a
// command read differently from what it is: soft hyphen, bidi marks and overrides, zero-width and
// invisible operators, line / paragraph separators, Hangul and Mongolian fillers, BOM, tag characters.
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
const INVISIBLE_TEST = new RegExp(INVISIBLE.source, 'u');

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

// A one-line label: controls and invisible characters removed, whitespace collapsed, cut to `max`.
function sanitize(s, max) {
  const v = String(s == null ? '' : s).replace(CONTROLS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(v).slice(0, max).join('');
}

// An ssh destination the server may name: host, user@host, an alias from ~/.ssh/config, an IP.
// Never something ssh (or the msys argument parser) could take for an option or an @file.
function validHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 255 && HOST_RE.test(h) && !h.startsWith('-') && !h.startsWith('@');
}

// The remote command is shown to the user before it runs, so it must read exactly as it is: one line,
// at most 512 characters, no control characters (a tab is fine) and no invisible characters.
function validCmd(c) {
  return typeof c === 'string' && c.length <= MAX_CMD && !/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(c) && !INVISIBLE_TEST.test(c);
}

// How a command is shown in the permission dialog: runs of spaces and tabs collapsed.
function displayCmd(c) { return String(c || '').replace(/[ \t]+/g, ' ').trim(); }

// The payload of OSC 7711 (everything after "7711;") -> { action, ... } or { error }.
// The token is returned for checking only: callers must never log or store it.
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
  const flag = (k) => {
    if (f[k] === undefined) return undefined;
    if (f[k] !== '0' && f[k] !== '1') throw new Error(`${k} must be 0 or 1`);
    return f[k] === '1';
  };
  try {
    const token = dec('token');
    const tok = token && token.length <= MAX_TOKEN ? { token } : {};
    switch (action) {
      case 'open': {
        const host = dec('host');
        if (!host) return { error: 'open needs host' };
        if (host !== SAME && !validHost(host)) return { error: 'open: host is not a valid ssh destination' };
        const cmd = dec('cmd') || '';
        if (!validCmd(cmd)) return { error: `open: cmd has several lines, control or invisible characters, or is longer than ${MAX_CMD}` };
        const select = flag('select');
        const rerun = flag('rerun');
        return Object.assign({ action, host, cmd, name: sanitize(dec('name'), MAX_NAME), ws: sanitize(dec('ws'), MAX_NAME), select: select !== false }, rerun === undefined ? {} : { rerun }, tok);
      }
      case 'status': {
        if (!STATUSES.includes(f.state)) return { error: `status: state must be one of ${STATUSES.join(', ')}` };
        return Object.assign({ action, state: f.state }, tok);
      }
      case 'notify': {
        const title = sanitize(dec('title'), MAX_TITLE);
        const text = sanitize(dec('text'), MAX_TEXT);
        if (!title && !text) return { error: 'notify needs title or text' };
        return Object.assign({ action, title, text }, tok);
      }
      case 'rename': {
        const name = sanitize(dec('name'), MAX_NAME);
        if (!name) return { error: 'rename needs name' };
        return Object.assign({ action, name }, tok);
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

// ---------- the tab token ----------

function newToken() { return crypto.randomBytes(18).toString('base64url'); }

// Constant time, whatever the lengths: both sides are hashed first.
function tokenEquals(given, actual) {
  if (typeof given !== 'string' || typeof actual !== 'string' || !given || !actual) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(a, b);
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

// One argument for a program that parses its command line with the Microsoft C runtime (the OpenSSH
// client of Windows): always in double quotes, backslashes doubled only before a quote.
function quoteMsvcrt(a) {
  let out = '"';
  let bs = 0;
  for (const c of String(a)) {
    if (c === '\\') { bs++; continue; }
    if (c === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + c; bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

// One argument for an msys / Cygwin program (ssh.exe of Git for Windows). Its runtime parses the
// command line itself: a word starting with @ outside quotes is replaced by a file's contents,
// unquoted words are globbed (~ * ? [] {}), ' quotes too. A word that starts with " is none of that;
// inside it \ escapes the next character (globify), so every \ and " is escaped.
function quoteMsys(a) {
  return '"' + String(a).replace(/[\\"]/g, (c) => '\\' + c) + '"';
}

// msys-style ssh: Git for Windows, MSYS2, Cygwin (…\usr\bin\ssh.exe or …\bin\ssh.exe outside System32).
function isMsysSsh(exe) {
  const p = String(exe || '').replace(/\//g, '\\').toLowerCase();
  if (/\\windows\\system32\\openssh\\ssh\.exe$/.test(p)) return false;
  return /\\(usr\\)?bin\\ssh\.exe$/.test(p);
}

// The arguments as the command line node-pty passes to CreateProcess (without the program name,
// which node-pty adds): every argument quoted, for the parser of that ssh.exe.
function sshCommandLine(exe, argv) {
  const q = isMsysSsh(exe) ? quoteMsys : quoteMsvcrt;
  return argv.map(q).join(' ');
}

// Options of OpenSSH's getopt string that take an argument.
const WITH_ARG = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));
// The only options carried over to a new tab.
const SAFE = new Set(['p', 'l', 'i', 'J', '4', '6']);
// Options that do not change where or how a connection goes: left out without a word. -A (the agent)
// is left out too: a tab opened by a server does not get your agent.
const HARMLESS = new Set(['v', 't', 'T', 'q', 'C', 'A']);

// ssh's arguments (without the program name) -> { destination, options, dropped } or null.
// dropped: options that are neither carried over nor harmless (-o, -F, forwardings, …): a connection
// that needs them cannot be reproduced. Like ssh, options may also come after the destination; the
// first word after it starts the remote command.
function parseSshArgs(argv) {
  let dest = null;
  let terminated = false;
  const opts = [];
  const dropped = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!terminated && a === '--') { terminated = true; continue; }
    if (!terminated && a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (WITH_ARG.has(f)) {
          let val = a.slice(j + 1);
          if (!val) { i++; val = argv[i]; if (val === undefined) return null; }
          if (SAFE.has(f)) opts.push('-' + f, val); else dropped.push('-' + f);
          break;
        }
        if (SAFE.has(f)) opts.push('-' + f); else if (!HARMLESS.has(f)) dropped.push('-' + f);
      }
      continue;
    }
    if (dest !== null) break; // the remote command
    dest = a;
    if (terminated) break;
  }
  if (dest === null) return null;
  const uri = /^ssh:\/\/(?:([^@/;:]+)@)?([^@/:[\]]+)(?::(\d+))?\/?$/.exec(dest);
  if (uri) {
    dest = (uri[1] ? uri[1] + '@' : '') + uri[2];
    if (uri[3]) opts.push('-p', uri[3]);
  }
  const options = cleanOptions(opts);
  if (!options || !validHost(dest)) return null;
  return { destination: dest, options, dropped: [...new Set(dropped)] };
}

// Checks a list of carried-over options; null if any is not allowed. -i paths written the msys way
// (/c/Users/…, from Git Bash's ssh) become Windows paths.
function cleanOptions(opts) {
  if (!Array.isArray(opts)) return null;
  const out = [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    if (o === '-4' || o === '-6') { out.push(o); continue; }
    const v = opts[i + 1];
    if (typeof v !== 'string' || !v || v.startsWith('-') || v.startsWith('@') || /[\x00-\x1f\x7f]/.test(v)) return null;
    i++;
    if (o === '-p') { if (!/^\d{1,5}$/.test(v) || +v < 1 || +v > 65535) return null; out.push(o, v); } else if (o === '-l') { if (v.length > 64 || /\s/.test(v)) return null; out.push(o, v); } else if (o === '-J') { if (v.length > 512 || !/^[A-Za-z0-9._@:,%-]+$/.test(v)) return null; out.push(o, v); } else if (o === '-i') { if (v.length > 1024) return null; out.push(o, (/^\/[a-zA-Z](\/|$)/.test(v) && msysToWin(v)) || v); } else return null;
  }
  return out;
}

// What a connection is compared by (allowHosts, "Always for this host"): user@host:port, with the
// user and the port taken from -l / -p when the destination has none. "prod" is not "root@prod".
function destKey({ destination, options = [] }) {
  let user = null; let host = String(destination || ''); let port = null;
  const at = host.lastIndexOf('@');
  if (at >= 0) { user = host.slice(0, at); host = host.slice(at + 1); }
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '-l' && !user) user = options[i + 1];
    if (options[i] === '-p') port = options[i + 1];
  }
  return (user ? user + '@' : '') + host + (port && port !== '22' ? ':' + port : '');
}

function hostMatches(entry, key) {
  return typeof entry === 'string' && typeof key === 'string' && !!entry.trim() && entry.trim().toLowerCase() === key.toLowerCase();
}

// A saved or passed ssh spec { destination, options, cmd, exe } checked again, or null.
// exe is kept only if isAllowedExe says so.
function normalizeSsh(spec, isAllowedExe = () => false) {
  if (!spec || typeof spec !== 'object') return null;
  const options = cleanOptions(spec.options || []);
  const cmd = spec.cmd == null ? '' : spec.cmd;
  if (!options || !validHost(spec.destination) || !validCmd(cmd)) return null;
  const out = { destination: spec.destination, options, cmd };
  if (typeof spec.exe === 'string' && isAllowedExe(spec.exe)) out.exe = spec.exe;
  return out;
}

// Arguments for ssh.exe: a terminal, the env variables to send, the carried-over options, then the
// destination and the command after `--`, so neither can be read as an option. The command is a
// single argument: the remote shell interprets it, nothing on this computer does.
function buildSshArgs({ destination, options, cmd }) {
  return ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', '-o', 'SendEnv=LC_KOLONKA_TOKEN',
    ...(options || []), '--', destination, ...(cmd ? [cmd] : [])];
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function gitSshCandidates(env) {
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean).map((d) => path.win32.join(d, 'Git', 'usr', 'bin', 'ssh.exe'));
}
const systemSsh = (env) => path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');

// ssh.exe: settings remote.ssh, then the OpenSSH client of Windows, then the one of Git for Windows.
function findSshExe(setting, { env = process.env, exists = fileExists, platform = process.platform } = {}) {
  if (typeof setting === 'string' && setting.trim()) return exists(setting.trim()) ? setting.trim() : null;
  if (platform !== 'win32') return ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'].find(exists) || null;
  return [systemSsh(env), ...gitSshCandidates(env)].find(exists) || null;
}

// The ssh.exe files Kolonka may start because a tab used them (or state.json names them): remote.ssh,
// the OpenSSH client of Windows, ssh.exe of an existing Git for Windows. Compared case-insensitively.
function isAllowedSshExe(p, setting, { env = process.env, exists = fileExists } = {}) {
  if (typeof p !== 'string' || !p) return false;
  const norm = (x) => path.win32.normalize(String(x)).toLowerCase();
  const want = norm(p);
  if (typeof setting === 'string' && setting.trim() && norm(setting.trim()) === want) return true;
  if (norm(systemSsh(env)) === want) return true;
  return gitSshCandidates(env).some((g) => norm(g) === want && exists(g));
}

// ---------- the ssh connection of a tab ----------

const isSsh = (name) => /^ssh(\.exe)?$/i.test(String(name || ''));

// The ssh process a tab is connected through: procs is [{ pid, ppid, name, cmd, exe, started }], root
// the pid node-pty reports (the shell under ConPTY). Descendants only (a reused parent pid of an older
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

// The ssh connection of the process tree under rootPid: { destination, options, dropped, exe } or null.
function sshOriginFromTree(rootPid, procs) {
  const p = findSshInTree(rootPid, procs);
  if (!p || typeof p.cmd !== 'string') return null;
  const argv = parseWinCommandLine(p.cmd);
  const r = parseSshArgs(argv.slice(1));
  return r ? Object.assign(r, { exe: p.exe || null }) : null;
}

const PS_LIST = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate | ForEach-Object {',
  '  $t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }',
  "  $c = $null; $e = $null; if ($_.Name -match '^ssh(\\.exe)?$') { $c = $_.CommandLine; $e = $_.ExecutablePath }",
  '  [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $c; e = $e; t = $t }',
  '} | ConvertTo-Json -Compress',
].join('\n');

// All processes (command line and path of ssh processes only), through PowerShell / CIM. Resolves to []
// on other platforms; rejects on a timeout or a failure.
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
  return v.filter((x) => x && Number.isInteger(x.p)).map((x) => ({ pid: x.p, ppid: x.q, name: x.n, cmd: x.c, exe: x.e || null, started: x.t || 0 }));
}

// ---------- limits ----------

// At most `limit` events per `windowMs` for each key (a sliding window).
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  take(key, now = Date.now(), limit = this.limit) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    const ok = list.length < limit;
    if (ok) list.push(now);
    this.hits.set(key, list);
    return ok;
  }
  forget(key) { this.hits.delete(key); }
}

module.exports = {
  STATUSES, SAME, MAX_NAME, MAX_TEXT, MAX_TITLE, MAX_CMD,
  b64decode, b64encode, sanitize, validHost, validCmd, displayCmd,
  parseRemoteOsc, notifyFromOsc9, notifyFromOsc777,
  newToken, tokenEquals,
  parseWinCommandLine, parseSshArgs, cleanOptions, normalizeSsh, buildSshArgs, destKey, hostMatches,
  quoteMsvcrt, quoteMsys, isMsysSsh, sshCommandLine,
  findSshExe, isAllowedSshExe, findSshInTree, sshOriginFromTree, listProcesses, parseProcessList,
  RateLimiter,
};
