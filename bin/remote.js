'use strict';
// `kolonka remote install <ssh-host>`: puts bin/kolonka-remote on a server as ~/.local/bin/kolonka,
// so programs there can open tabs, set the status and notify (see README, "Remote control over SSH").
// Plain ssh is used for everything (no scp), with the host after `--` so it is never read as an option.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'kolonka-remote');
const MARK = 'kolonka-remote'; // the installed script contains it; anything else at the path is not ours
const TARGET = '~/.local/bin/kolonka';

function validHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 255 && /^[A-Za-z0-9._@\[\]:-]+$/.test(h) && !h.startsWith('-');
}

// ssh to use: KOLONKA_SSH, the OpenSSH client of Windows, or `ssh` from PATH.
function sshExe(env = process.env, exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) {
  if (env.KOLONKA_SSH) return env.KOLONKA_SSH;
  if (process.platform === 'win32') {
    const win = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (exists(win)) return win;
  }
  return 'ssh';
}

// The remote shell commands; $HOME is expanded on the server.
const CHECK = `f="$HOME/.local/bin/kolonka"; if [ -e "$f" ]; then if grep -q ${MARK} "$f" 2>/dev/null; then echo ours; else echo other; fi; else echo none; fi`;
const WRITE = 'set -e; d="$HOME/.local/bin"; mkdir -p "$d"; cat > "$d/.kolonka.tmp"; chmod 755 "$d/.kolonka.tmp"; mv -f "$d/.kolonka.tmp" "$d/kolonka"; '
  + 'case ":$PATH:" in *":$d:"*) echo onpath ;; *) echo offpath ;; esac';

function sshArgs(host, remoteCmd) { return ['--', host, remoteCmd]; }

// The script as it goes to the server: LF line ends whatever the checkout did.
function scriptBody() { return fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n'); }

function ask(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(256);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { return ''; }
  return buf.slice(0, n).toString('utf8').trim();
}

// -> exit code. run: spawnSync-like, for tests.
function install(host, { yes = false, out = process.stdout, run = spawnSync, prompt = ask } = {}) {
  if (!validHost(host)) { process.stderr.write(`kolonka: not a valid ssh host: ${host}\n`); return 2; }
  const ssh = sshExe();
  const check = run(ssh, sshArgs(host, CHECK), { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (check.error || check.status !== 0) { process.stderr.write(`kolonka: ssh ${host} failed${check.error ? ': ' + check.error.message : ''}\n`); return 1; }
  const state = String(check.stdout || '').trim().split(/\s+/).pop();
  if (state === 'ours' || state === 'other') {
    const what = state === 'ours' ? `${TARGET} on ${host} already exists (an earlier kolonka-remote).` : `${TARGET} on ${host} exists and is NOT kolonka-remote.`;
    if (!yes && !/^y(es)?$/i.test(prompt(`${what} Overwrite it? [y/N] `))) { out.write('Nothing changed.\n'); return 1; }
  }
  const w = run(ssh, sshArgs(host, WRITE), { input: scriptBody(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  if (w.error || w.status !== 0) { process.stderr.write(`kolonka: could not write ${TARGET} on ${host}\n`); return 1; }
  const onPath = String(w.stdout || '').includes('onpath');
  out.write(nextSteps(host, onPath));
  return 0;
}

function nextSteps(host, onPath) {
  return [
    `Installed ${TARGET} on ${host}.`,
    onPath ? '' : `~/.local/bin is not on PATH there: add  export PATH="$HOME/.local/bin:$PATH"  to ~/.profile (or ~/.bashrc).`,
    '',
    'For the server to know it talks to Kolonka (and to prove requests come from your tab), send Kolonka\'s',
    `variables over ssh: run  kolonka remote connect ${host}  (or ⚙ → Connect a server… in Kolonka), which adds`,
    'to %USERPROFILE%\\.ssh\\config:',
    '',
    `  Host ${host}`,
    '    SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN',
    '',
    '(only for this host, not Host *: the token is a secret of your tab). On the server sshd must accept',
    'them: AcceptEnv KOLONKA_TOKEN in /etc/ssh/sshd_config (LC_* is accepted on Debian / Ubuntu by default).',
    'Under tmux:  set -g allow-passthrough on  and  set -ga update-environment " KOLONKA_TOKEN LC_TERMINAL LC_TERMINAL_VERSION"',
    '',
    'Try it in an ssh tab:  kolonka notify "hello from the server"',
    '',
    'Claude Code status hooks on the server: merge the output of',
    '  kolonka hooks print --remote',
    'into ~/.claude/settings.json there.',
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// ---------- `kolonka remote connect` / `disconnect` ----------
// The ssh config is changed here, by the CLI (bin/sshconfig.js, the same code the window uses). The
// trust ("Always for this host") belongs to the running Kolonka: it is added through the API, so the
// app's own state.json is not overwritten under it. Without a running Kolonka it goes into state.json
// directly, which the next start reads.

const sshconfig = require('./sshconfig');

// state.json: remote.allowedHosts with key added (add) or removed. A file that cannot be read as state
// is not touched. -> true if it changed
function trustInState(file, key, add) {
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${file} could not be read (${e.code || e.message}); not changed`);
    if (!add) return false;
    st = { version: 1, workspaces: [] }; // the first start builds the rest
  }
  if (!st || typeof st !== 'object' || !Array.isArray(st.workspaces)) throw new Error(`${file} is not a Kolonka state file; not changed`);
  const list = st.remote && Array.isArray(st.remote.allowedHosts) ? st.remote.allowedHosts.filter((h) => typeof h === 'string') : [];
  const has = list.some((h) => h.toLowerCase() === key.toLowerCase());
  if (add === has) return false;
  st.remote = Object.assign({}, st.remote, { allowedHosts: add ? list.concat(key) : list.filter((h) => h.toLowerCase() !== key.toLowerCase()) });
  const tmp = file + '.kolonka-cli.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, file);
  return true;
}

function configLine(r, key) {
  if (r.changed) return `ssh config: ${r.created ? 'created' : 'changed'} ${r.file} — Kolonka's variables go to ${key}${r.backup ? ` (copy of the old file: ${path.basename(r.backup)})` : ''}`;
  return `ssh config: ${r.file} already sends Kolonka's variables to ${key}`;
}

// -> exit code. api: (method, url, body) -> Promise of the JSON answer of a running Kolonka, or null.
async function connect(input, { name, ws, open = true, command, api = null, dataDir, home, out = process.stdout, err = process.stderr, editOpts = {} } = {}) {
  const t = sshconfig.parseTarget(input);
  if (t.error) { err.write(`kolonka: ${input || '(empty)'}: ${sshconfig.ERRORS[t.error]}\n`); return 2; }
  if (command !== undefined && (command === true || !sshconfig.validCmd(command))) { err.write('kolonka: --command needs one line of text (at most 512 characters, no control characters)\n'); return 2; }
  if (command && !open) { err.write('kolonka: --command runs in the tab; it cannot go with --no-open\n'); return 2; }
  let r;
  try { r = await sshconfig.connectConfig(t, Object.assign({ home }, editOpts)); } catch (e) { err.write(`kolonka: ${e.message}\nNothing changed.\n`); return 1; }
  out.write(configLine(r, t.key) + '\n');
  try {
    if (api) {
      const res = await api('POST', '/api/remote/connect', { destination: t.destination, options: t.options, cmd: command || '', name, workspace: ws, open });
      out.write(`trusted: requests from ${res.host} with the token of its tab open tabs there without asking\n`);
      if (res.session) out.write(`tab: ${res.session}\n`);
    } else {
      trustInState(path.join(dataDir, 'state.json'), t.key, true);
      out.write(`trusted: requests from ${t.key} with the token of its tab open tabs there without asking (saved for the next start)\n`);
      if (open) out.write('Kolonka is not running, so no tab was opened.\n');
    }
  } catch (e) {
    err.write(`kolonka: ${t.key} was not added to the trusted hosts: ${e.message}\n(the ssh config change above stays; run the command again to retry)\n`);
    return 1;
  }
  return 0;
}

async function disconnect(input, { api = null, dataDir, home, out = process.stdout, err = process.stderr, editOpts = {} } = {}) {
  const t = sshconfig.parseTarget(input);
  if (t.error) { err.write(`kolonka: ${input || '(empty)'}: ${sshconfig.ERRORS[t.error]}\n`); return 2; }
  let r;
  try { r = await sshconfig.disconnectConfig(t.key, Object.assign({ home }, editOpts)); } catch (e) { err.write(`kolonka: ${e.message}\nNothing changed.\n`); return 1; }
  out.write(r.changed ? `ssh config: removed Kolonka's block for ${t.key} from ${r.file}${r.backup ? ` (copy of the old file: ${path.basename(r.backup)})` : ''}\n`
    : `ssh config: no block of Kolonka for ${t.key}\n`);
  let forgot;
  try {
    if (api) {
      try { await api('DELETE', '/api/remote/hosts/' + encodeURIComponent(t.key)); forgot = true; } catch (e) { if (e.status !== 404) throw e; forgot = false; }
    } else forgot = trustInState(path.join(dataDir, 'state.json'), t.key, false);
  } catch (e) { err.write(`kolonka: ${t.key} is still trusted: ${e.message}\n`); return 1; }
  out.write(forgot ? `trusted hosts: ${t.key} removed\n` : `trusted hosts: ${t.key} was not there\n`);
  return r.changed || forgot ? 0 : 1;
}

module.exports = { install, nextSteps, validHost, sshExe, CHECK, WRITE, SCRIPT, MARK, connect, disconnect, trustInState };
