'use strict';
// A stand-in for src/main/session.js: no pty, no headless terminal. Records what the model does with it.
const { EventEmitter } = require('events');

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
    this.written = [];
    this.killed = false;
  }

  start() { this.startedAt = Date.now(); }
  write(data) { if (!this.exited) this.written.push(data); }
  kill() { this.killed = true; this.exited = true; }

  info() {
    return {
      id: this.id, name: this.name, workspace: this.workspaceId, cwd: this.cwd, shell: this.shellKey,
      status: this.status, unread: this.unread, exited: this.exited, exitCode: this.exitCode,
    };
  }
}

module.exports = { FakeSession };
