'use strict';
// One session = one pty + a headless xterm mirror the API reads the screen text from.
const { EventEmitter } = require('events');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { parseOsc7 } = require('./shells');
const { stripAnsi } = require('./ansi');

class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.workspaceId = opts.workspaceId;
    this.cwd = opts.cwd;
    this.shellKey = opts.shellKey;
    this.command = opts.command || null; // initial command, if any
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
  }

  start() {
    const sh = this._shell;
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.parser.registerOscHandler(7, (data) => { this._setCwd(parseOsc7(data)); return true; });
    this.term.parser.registerOscHandler(9, (data) => {
      if (data.startsWith('9;')) { this._setCwd(data.slice(2).replace(/^"|"$/g, '')); return true; }
      return false;
    });
    this.term.onTitleChange((t) => { this.title = t; this.emit('meta'); });
    this.term.onBell(() => this.emit('bell'));

    const env = Object.assign({}, process.env, sh.env || {}, this._env, {
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'kolonka',
      KOLONKA_SESSION: this.id,
    });
    if (this._pathPrepend) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[key] = this._pathPrepend + ';' + (env[key] || '');
    }
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;

    let args = sh.args.slice();
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
    this.proc.onData((data) => this._onData(data));
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.emit('exit', exitCode);
    });
    if (this.command) setTimeout(() => this.write(this.command + '\r'), 400);
  }

  _setCwd(p) {
    if (p && p !== this.cwd) { this.cwd = p; this.emit('meta'); }
  }

  _onData(data) {
    this.seq++;
    this.lastOutputAt = Date.now();
    this.term.write(data);
    this.emit('data', data, this.seq);
  }

  write(data) {
    if (!this.exited) this.proc.write(data);
  }

  resize(cols, rows) {
    cols = Math.max(2, cols | 0); rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.lastResizeAt = Date.now();
    this.term.resize(cols, rows);
    if (!this.exited) { try { this.proc.resize(cols, rows); } catch { /* the process may have exited */ } }
  }

  kill() {
    if (!this.exited) { try { this.proc.kill(); } catch { /* ignore */ } }
    this.exited = true;
    try { this.term.dispose(); } catch { /* ignore */ }
  }

  // Wait until the headless terminal has parsed everything received so far.
  flush() {
    return new Promise((resolve) => {
      const seq = this.seq;
      try { this.term.write('', () => resolve(seq)); } catch { resolve(seq); }
    });
  }

  async snapshot() {
    const seq = await this.flush();
    return { seq, data: this.serializer.serialize({ scrollback: 2000 }) };
  }

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
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastOutputAt: this.lastOutputAt,
    };
  }
}

module.exports = { Session, stripAnsi };
