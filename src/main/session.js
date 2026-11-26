'use strict';
// One session = one pty + a headless xterm mirror the API reads the screen text from.
const { EventEmitter } = require('events');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { parseOsc7 } = require('./shells');
const { isSafeLocalPath } = require('./paths');
const { stripAnsi } = require('./ansi');
const { OutputLog } = require('./outlog');
const { parseRemoteOsc, notifyFromOsc9, notifyFromOsc777, newToken } = require('./remote');

const VERSION = require('../../package.json').version;

class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.workspaceId = opts.workspaceId;
    this.cwd = opts.cwd;
    this.shellKey = opts.shellKey;
    this.command = opts.command || null; // initial command, if any; kept for restarts
    this.ssh = opts.ssh || null;         // { destination, options, cmd } for a tab opened over ssh (shell = ssh.exe)
    this.rerun = !!opts.rerun;           // run the command again when Kolonka starts
    this.fromRemote = !!opts.fromRemote; // opened by a server (OSC 7711 open)
    this.remoteRoot = opts.remoteRoot || null; // the tab whose request opened it (limits are counted there)
    this.nameFromServer = !!opts.nameFromServer;
    this._deferred = !!opts.deferred;    // not started yet: shown as "not connected", Enter starts it
    this.deferred = false;
    // A secret of this run of the tab, in its environment as LC_KOLONKA_TOKEN: a remote control request
    // carrying it comes from a process of this tab's session, not from text it merely displays.
    // Never shown in info(), never saved, never logged.
    this.token = newToken();
    this._runCommand = opts.runCommand !== false; // false when restoring a saved layout
    this.status = 'idle';     // idle | active | blocked | done
    this.unread = false;
    this.title = '';
    this.exited = false;
    this.exitCode = null;
    this.createdAt = Date.now();
    this.seq = 0;
    this.lastOutputAt = 0;
    this.lastResizeAt = 0;
    this.cols = opts.cols || 120;
    this.rows = opts.rows || 32;
    this._shell = opts.shell;
    this._env = opts.env || {};
    this._pathPrepend = opts.pathPrepend || null;
    this._scrollback = opts.scrollback || 10000;
    this._pty = opts.pty || null; // tests pass a fake node-pty
    this._killed = false;
    this.output = new OutputLog();
  }

  start() {
    const sh = this._shell;
    // the same width tables and scrollback as the window, so the API sees what the user sees
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: this._scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.parser.registerOscHandler(7, (data) => { this._setCwd(parseOsc7(data)); return true; });
    this.term.parser.registerOscHandler(9, (data) => {
      if (data.startsWith('9;')) { this._setCwd(data.slice(2).replace(/^"|"$/g, '')); return true; }
      const n = notifyFromOsc9(data);
      if (n) { this.emit('remote', n); return true; }
      return false;
    });
    // remote control (src/main/remote.js); the model decides what is allowed
    this.term.parser.registerOscHandler(7711, (data) => { this.emit('remote', parseRemoteOsc(data)); return true; });
    this.term.parser.registerOscHandler(777, (data) => {
      const n = notifyFromOsc777(data);
      if (n) { this.emit('remote', n); return true; }
      return false;
    });
    this.term.onTitleChange((t) => { this.title = t; this.emit('meta', 'title'); });
    this.term.onBell(() => this.emit('bell'));
    if (this._deferred) {
      this.deferred = true;
      this.exited = true;
      this.startedAt = Date.now();
      return;
    }

    const env = Object.assign({}, process.env, sh.env || {}, this._env, {
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'kolonka',
      KOLONKA_SESSION: this.id,
      // what programs on a server see (with SendEnv / AcceptEnv): kolonka-remote checks it
      LC_TERMINAL: 'Kolonka',
      LC_TERMINAL_VERSION: VERSION,
      LC_KOLONKA_TOKEN: this.token,
    });
    if (this._pathPrepend) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[key] = this._pathPrepend + ';' + (env[key] || '');
    }
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;

    const pty = this._pty || require('node-pty');
    // a shell may bring a ready command line (ssh: quoted by Kolonka for that ssh.exe), which node-pty
    // passes to Windows as it is
    const args = process.platform === 'win32' && typeof sh.commandLine === 'string' ? sh.commandLine : (sh.args || []).slice();
    this.proc = pty.spawn(sh.file, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
      useConpty: true,
    });
    this.pid = this.proc.pid;
    this.startedAt = Date.now();
    // after kill() the old pty may still deliver data or its exit; that must not reach anyone
    this.proc.onData((data) => { if (!this._killed) this._onData(data); });
    this.proc.onExit(({ exitCode }) => {
      if (this._killed) return;
      this.exited = true;
      this.exitCode = exitCode;
      this.emit('exit', exitCode);
    });
    if (this.command && this._runCommand) setTimeout(() => this.write(this.command + '\r'), 400);
  }

  // Any program in the terminal can print OSC 7 / OSC 9;9, so the path is untrusted: local drive paths only.
  _setCwd(p) {
    if (!isSafeLocalPath(p)) return;
    if (p !== this.cwd) { this.cwd = p; this.emit('meta'); }
  }

  _onData(data) {
    this.seq++;
    this.lastOutputAt = Date.now();
    this.output.append(data, this.seq);
    this.term.write(data);
    this.emit('data', data, this.seq);
  }

  write(data) {
    if (!this.exited && this.proc) this.proc.write(data);
  }

  resize(cols, rows) {
    cols = Math.max(2, cols | 0); rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.lastResizeAt = Date.now();
    this.term.resize(cols, rows);
    if (!this.exited && this.proc) { try { this.proc.resize(cols, rows); } catch { /* the process may have exited */ } }
  }

  // Stop the process for good (close or restart). Listeners get a 'killed' event and are then
  // dropped, so a late exit of this pty cannot be taken for the exit of a new one with the same id.
  kill() {
    if (this._killed) return;
    this._killed = true;
    if (!this.exited && this.proc) { try { this.proc.kill(); } catch { /* ignore */ } }
    this.exited = true;
    try { this.term.dispose(); } catch { /* ignore */ }
    this.emit('killed');
    this.removeAllListeners();
  }

  // Wait until the headless terminal has parsed everything received so far.
  flush() {
    return new Promise((resolve) => {
      const seq = this.seq;
      try { this.term.write('', () => resolve(seq)); } catch { resolve(seq); }
    });
  }

  // The screen as escape sequences plus the seq it corresponds to: serialized in the parser
  // callback, before any later output is parsed, so seq and data match exactly.
  snapshot() {
    return new Promise((resolve) => {
      const seq = this.seq;
      const take = () => {
        let data = '';
        try { data = this.serializer.serialize({ scrollback: 2000 }); } catch { /* disposed */ }
        resolve({ seq, data });
      };
      try { this.term.write('', take); } catch { take(); }
    });
  }

  // Output after `seq` from the recent-output log (see outlog.js).
  outputSince(seq) { return this.output.since(seq); }

  async text({ lines, all } = {}) {
    await this.flush();
    const buf = this.term.buffer.active;
    const start = all ? 0 : buf.baseY;
    const end = all ? buf.length : Math.min(buf.length, buf.baseY + this.term.rows);
    const out = [];
    for (let y = start; y < end; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const s = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += s;
      else out.push(s);
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    const res = lines ? out.slice(-lines) : out;
    return res.join('\n');
  }

  cursor() {
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      workspace: this.workspaceId,
      cwd: this.cwd,
      shell: this.shellKey,
      status: this.status,
      unread: this.unread,
      title: this.title,
      pid: this.pid,
      exited: this.exited,
      exitCode: this.exitCode,
      command: this.command,
      remote: this.ssh ? { host: this.ssh.destination, cmd: this.ssh.cmd } : null,
      rerun: this.rerun,
      deferred: this.deferred,
      seq: this.seq,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastOutputAt: this.lastOutputAt,
    };
  }
}

module.exports = { Session, stripAnsi };
