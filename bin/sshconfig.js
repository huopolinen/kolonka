'use strict';
// "Connect a server": the address a person types, and the block Kolonka keeps for it in
// %USERPROFILE%\.ssh\config so the OpenSSH client sends Kolonka's variables to that server:
//
//   # >>> kolonka: <key>
//   Host <host>
//       SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN
//   # <<< kolonka: <key>
//
// Why a separate block at the end of the file works and breaks nothing:
// - For most keywords ssh_config(5) keeps the first value it finds, but SendEnv is cumulative: every
//   SendEnv line of every Host / Match block that applies adds to the list (readconf.c, oSendEnv:
//   "appends to list; doesn't respect first-match-wins"). So a block of the user's own for the same host
//   keeps all its settings, and ours only adds three variable names.
// - A Host line ends the block before it, whatever that was (Host, Match, a trailing Include), so the
//   block applies on its own, also after a Match block at the end of the file.
// - Host patterns are matched against the host name as typed on the ssh command line, never against the
//   user or the port (those are separate: User / Port, -l / -p). For user@host:port the line is
//   `Host host`; ssh gets `-p port -- user@host`. An IPv6 address is written without brackets.
// The key in the markers is the connection as Kolonka compares it (user@host:port, see destKey in
// src/main/remote.js): the same string "Always for this host" keeps in state.json.
//
// This file is in bin/ (outside app.asar) because both the CLI under plain node and the app use it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const START = '# >>> kolonka: ';
const END = '# <<< kolonka: ';
const SEND_ENV = 'SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN';

// The pattern of validHost in src/main/remote.js (which ssh destinations Kolonka ever starts);
// test/sshconfig.test.js checks that both accept the same strings.
const HOST_RE = /^[A-Za-z0-9._@:-]+$/;
function validHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 255 && HOST_RE.test(h) && !h.startsWith('-') && !h.startsWith('@');
}

// The rule of validCmd in src/main/remote.js: one line, at most 512 characters, nothing invisible.
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/u;
function validCmd(c) {
  return typeof c === 'string' && c.length <= 512 && !/[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(c) && !INVISIBLE.test(c);
}

const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,63}$/;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;   // an alias from ssh config, a host name, an IPv4 address
const V6_RE = /^[0-9A-Fa-f.:]+$/;

// user@host:port as Kolonka compares connections (destKey in src/main/remote.js).
function keyOf({ user, host, port }) {
  const h = host.includes(':') ? `[${host}]` : host;
  return (user ? user + '@' : '') + (port && port !== '22' ? `${h}:${port}` : h);
}

// What a person typed -> { destination, options, user, host, port, key } or { error } with a code:
// empty, space, option (starts with -), at (starts with @), user, host, port, chars, long.
// Accepted: an alias or host name, an IPv4 / IPv6 address, user@…, …:port (IPv6 with a port in
// brackets: [2001:db8::1]:2222), and the same with ssh:// in front.
function parseTarget(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { error: 'empty' };
  if (s.length > 255) return { error: 'long' };
  if (/\s/.test(s)) return { error: 'space' };
  if (s.startsWith('-')) return { error: 'option' };
  if (s.startsWith('@')) return { error: 'at' };
  const uri = /^ssh:\/\/(.+?)\/?$/i.exec(s);
  if (uri) s = uri[1];
  const at = s.lastIndexOf('@');
  const user = at >= 0 ? s.slice(0, at) : null;
  const rest = at >= 0 ? s.slice(at + 1) : s;
  if (user !== null && !USER_RE.test(user)) return { error: 'user' };
  let host; let port;
  if (rest.startsWith('[')) {
    const m = /^\[([^\]]*)\](?::([^:]*))?$/.exec(rest);
    if (!m || !m[1].includes(':') || !V6_RE.test(m[1])) return { error: 'host' };
    host = m[1]; port = m[2];
  } else {
    const colons = (rest.match(/:/g) || []).length;
    if (colons === 1) [host, port] = rest.split(':');
    else host = rest;
  }
  if (!host) return { error: 'host' };
  if (host.includes(':') ? !(V6_RE.test(host) && (host.match(/:/g) || []).length >= 2) : !NAME_RE.test(host)) return { error: 'host' };
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) return { error: 'port' };
    port = String(+port);
    if (port === '22') port = undefined;
  }
  const destination = (user ? user + '@' : '') + host;
  if (!validHost(destination)) return { error: 'chars' };
  return { destination, options: port ? ['-p', port] : [], user, host, port: port || null, key: keyOf({ user, host, port }) };
}

const ERRORS = {
  empty: 'type the address of the server',
  long: 'the address is longer than 255 characters',
  space: 'the address has spaces in it',
  option: 'the address cannot start with -',
  at: 'the address cannot start with @',
  user: 'the user name has characters ssh does not take here (letters, digits, . _ - only)',
  host: 'not a host name, an alias from ~/.ssh/config or an IP address',
  port: 'the port must be a number from 1 to 65535',
  chars: 'the address has characters ssh does not take here',
};

// ---------- the text of the file ----------

// Lines with their own line ends, so whatever is not ours is written back byte for byte.
function segments(text) { return text.match(/[^\n]*\n|[^\n]+$/g) || []; }
const content = (seg) => seg.replace(/\r?\n$/, '');
const sameKey = (a, b) => a.toLowerCase() === b.toLowerCase();

// The line end the file uses (the more common one); `fallback` for a file without any.
function detectEol(text, fallback = '\n') {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (!crlf && !lf) return fallback;
  return crlf >= lf ? '\r\n' : '\n';
}

function blockLines(target) {
  return [START + target.key, 'Host ' + target.host, '    ' + SEND_ENV, END + target.key];
}

// Our blocks: [{ key, start, end }] (indexes into segments(text)); end -1 = no closing marker.
function findBlocks(text) {
  const segs = segments(text);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const line = content(segs[i]).trim();
    if (!line.startsWith(START)) continue;
    const key = line.slice(START.length).trim();
    let end = -1;
    for (let j = i + 1; j < segs.length; j++) {
      const l = content(segs[j]).trim();
      if (l.startsWith(START)) break; // the next block starts before this one closes
      if (l.startsWith(END) && sameKey(l.slice(END.length).trim(), key)) { end = j; break; }
    }
    out.push({ key, start: i, end });
    if (end > 0) i = end;
  }
  return out;
}

class ConfigError extends Error {
  constructor(code, message, file) { super(message); this.code = code; this.file = file || null; }
}

function unclosed(key) { return new ConfigError('unclosed', `the kolonka block for ${key} in ssh config has no closing line "${END}${key}"; fix or remove it by hand`); }

// The keys of the servers Kolonka has connected (complete blocks only).
function listKeys(text) { return findBlocks(text).filter((b) => b.end > 0).map((b) => b.key); }

// Our block for target at the end of the text, unless it is there already. -> { text, changed }
function addBlock(text, target, { eol = '\n' } = {}) {
  const blocks = findBlocks(text).filter((b) => sameKey(b.key, target.key));
  if (blocks.some((b) => b.end < 0)) throw unclosed(target.key);
  if (blocks.length) return { text, changed: false };
  const e = detectEol(text, eol);
  let out = text;
  if (out && !out.endsWith('\n')) out += e;
  if (out && !/(^|\n)[ \t]*\r?\n$/.test(out)) out += e; // one blank line before the block
  out += blockLines(target).join(e) + e;
  return { text: out, changed: true };
}

// Every block of ours for key removed (with the blank line before it), nothing else. -> { text, changed }
function removeBlock(text, key) {
  const blocks = findBlocks(text).filter((b) => sameKey(b.key, key));
  if (blocks.some((b) => b.end < 0)) throw unclosed(key);
  if (!blocks.length) return { text, changed: false };
  const segs = segments(text);
  const drop = new Set();
  for (const b of blocks) {
    for (let i = b.start; i <= b.end; i++) drop.add(i);
    if (b.start > 0 && !drop.has(b.start - 1) && content(segs[b.start - 1]).trim() === '') drop.add(b.start - 1);
  }
  return { text: segs.filter((_, i) => !drop.has(i)).join(''), changed: true };
}

// ---------- bytes ----------

// UTF-8 (with or without a BOM, kept as it was); a file that is not valid UTF-8 is read as latin1,
// which gives back every byte unchanged. UTF-16 (Notepad's "Unicode") is refused: ssh cannot read it.
function decodeConfig(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    throw new ConfigError('utf16', 'the ssh config file is saved as UTF-16, which OpenSSH cannot read; save it as UTF-8 first');
  }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = bom ? buf.subarray(3) : buf;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), bom, encoding: 'utf8' };
  } catch {
    return { text: body.toString('latin1'), bom, encoding: 'latin1' };
  }
}

function encodeConfig({ text, bom, encoding }) {
  const body = Buffer.from(text, encoding || 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// ---------- the file ----------

function homeDir(env = process.env) { return env.USERPROFILE || os.homedir(); }
function configFile(home = homeDir()) { return path.join(home, '.ssh', 'config'); }

// The file limited to the current user, the way src/main/acl.js limits control.json: inherited entries
// removed, full control for DOMAIN\user. Explicit entries a new file gets from the creator's default DACL
// (SYSTEM, Administrators) stay; OpenSSH for Windows allows exactly those besides the owner and refuses a
// config anyone else may write to ("Bad owner or permissions", check_secure_file_permission in readconf.c).
function restrictToUser(file, { env = process.env, run = execFile } = {}) {
  if (!env.USERNAME) return Promise.reject(new Error('unknown user name'));
  const who = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  const exe = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  return new Promise((resolve, reject) => {
    run(exe, [file, '/inheritance:r', '/grant:r', `${who}:F`], { windowsHide: true, timeout: 10000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`icacls failed: ${String(stderr || err.message).trim()}`)); else resolve(true);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261126T153000Z

// One writer at a time (two `kolonka remote connect` at once must not lose a block): a lock file next
// to the config, taken with O_EXCL; one older than 30 s is left from a crash and is taken over.
async function withLock(file, fn, { timeout = 5000 } = {}) {
  const lock = file + '.kolonka-lock';
  const until = Date.now() + timeout;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new ConfigError('busy', `another program is changing ${file} (${lock}); try again`, file);
      await sleep(50);
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
}

function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      // an editor or an antivirus holding the file for a moment
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

// Change the ssh config with edit(text, eol) -> { text, changed }. Before a change: a copy
// config.bak-kolonka-<time> next to it (one per change). The new file is written next to it and
// renamed over it, so ssh never reads half a file. Not written: a symlink, a read-only file, anything
// that is not a regular file. -> { file, changed, created, backup }
async function editConfig(file, edit, { create = true, now = new Date(), platform = process.platform, restrict = restrictToUser } = {}) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    if (!create) return { file, changed: false, created: false, backup: null };
    fs.mkdirSync(dir, { recursive: true });
  }
  return withLock(file, async () => {
    let st = null;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw new ConfigError('read', `cannot read ${file}: ${e.message}`, file); }
    if (st && st.isSymbolicLink()) throw new ConfigError('symlink', `${file} is a link to another file; Kolonka does not change it (add the block by hand)`, file);
    if (st && !st.isFile()) throw new ConfigError('notfile', `${file} is not a file`, file);
    if (st && !(st.mode & 0o200)) throw new ConfigError('readonly', `${file} is read-only; Kolonka does not change it`, file);
    if (!st && !create) return { file, changed: false, created: false, backup: null };
    let buf;
    try { buf = st ? fs.readFileSync(file) : Buffer.alloc(0); } catch (e) { throw new ConfigError('read', `cannot read ${file}: ${e.message}`, file); }
    const doc = decodeConfig(buf);
    const r = edit(doc.text, platform === 'win32' ? '\r\n' : '\n');
    if (!r.changed) return { file, changed: false, created: false, backup: null };
    let backup = null;
    if (st) {
      backup = `${file}.bak-kolonka-${stamp(now)}`;
      for (let n = 2; fs.existsSync(backup); n++) backup = `${file}.bak-kolonka-${stamp(now)}-${n}`;
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
    const tmp = `${file}.kolonka-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, encodeConfig(Object.assign({}, doc, { text: r.text })), { flag: 'wx', mode: 0o600 });
      // the new file must be one OpenSSH for Windows accepts, also if the folder lets others write
      if (platform === 'win32') await restrict(tmp);
      else if (st) fs.chmodSync(tmp, st.mode & 0o777);
      renameRetry(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not written */ }
      throw e instanceof ConfigError ? e : new ConfigError('write', `cannot write ${file}: ${e.message}`, file);
    }
    return { file, changed: true, created: !st, backup };
  });
}

function connectConfig(target, opts = {}) {
  return editConfig(opts.file || configFile(opts.home), (text, eol) => addBlock(text, target, { eol }), opts);
}

function disconnectConfig(key, opts = {}) {
  return editConfig(opts.file || configFile(opts.home), (text) => removeBlock(text, key), Object.assign({}, opts, { create: false }));
}

// The keys of Kolonka's blocks in the file ([] without one).
function readKeys(file) {
  try { return listKeys(decodeConfig(fs.readFileSync(file)).text); } catch { return []; }
}

// Kolonka.exe --connect=<address> (or --connect <address>) -> the address, or null. It only fills in the
// dialog of the window. The = form is the one to hand out: in the argv a second instance passes on,
// Chromium may move a separate value away from its switch.
function connectArg(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--connect=')) return list[i].slice(10).slice(0, 255);
    if (list[i] === '--connect' && list[i + 1] && !list[i + 1].startsWith('-')) return list[i + 1].slice(0, 255);
  }
  return null;
}

module.exports = {
  connectArg,
  START, END, SEND_ENV, ERRORS,
  validHost, validCmd, parseTarget, keyOf,
  detectEol, blockLines, findBlocks, listKeys, addBlock, removeBlock,
  decodeConfig, encodeConfig, ConfigError,
  homeDir, configFile, restrictToUser, editConfig, connectConfig, disconnectConfig, readKeys, withLock,
};
