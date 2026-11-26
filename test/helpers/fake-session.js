'use strict';
// A stand-in for src/main/session.js: no pty, no headless terminal. Records what the model does with it.
// Unlike the real Session, kill() keeps the listeners, so tests can check that the model itself
// ignores events from a session it no longer owns.
const { EventEmitter } = require('events');
const { OutputLog } = require('../../src/main/outlog');

class FakeSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.id = opts.id;
    this.name = opts.name;
    this.workspaceId = opts.workspaceId;
    this.cwd = opts.cwd;
    this.shellKey = opts.shellKey;
    this.command = opts.command || null;
    this.status = 'idle';
    this.unread = false;
    this.title = '';
    this.exited = false;
    this.exitCode = null;
    this.startedAt = 0;
    this.lastOutputAt = 0;
    this.lastResizeAt = 0;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.seq = 0;
    this.output = new OutputLog();
    this.screen = '';
    this.written = [];
    this.killed = false;
    this.failStart = FakeSession.failNextStart;
    FakeSession.failNextStart = false;
  }

  start() {
    if (this.failStart) throw new Error('spawn failed');
    this.startedAt = Date.now();
  }
  write(data) { if (!this.exited) this.written.push(data); }
  kill() { this.killed = true; this.exited = true; this.emit('killed'); }

  // test helpers: output from the "process"
  emitData(data) {
    this.seq++;
    this.lastOutputAt = Date.now();
    this.output.append(data, this.seq);
    this.emit('data', data, this.seq);
  }
  emitExit(code) { this.exited = true; this.exitCode = code; this.emit('exit', code); }

  outputSince(seq) { return this.output.since(seq); }
  async text() { return this.screen; }

  info() {
    return {
      id: this.id, name: this.name, workspace: this.workspaceId, cwd: this.cwd, shell: this.shellKey,
      status: this.status, unread: this.unread, exited: this.exited, exitCode: this.exitCode,
      command: this.command, seq: this.seq,
    };
  }
}
FakeSession.failNextStart = false;

module.exports = { FakeSession };
