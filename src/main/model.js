'use strict';
// The model: workspaces → sessions. The single source of truth for both the UI and the API.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { stripAnsi } = require('./ansi');
const { ApiError } = require('./errors');
const { homeDir } = require('./shells');

const STATUSES = ['idle', 'active', 'blocked', 'done'];

class Model extends EventEmitter {
  // Session: the session class; tests pass a fake one so the model can run without node-pty.
  constructor({ dataDir, settings, shells, env, pathPrepend, Session }) {
    super();
    this.Session = Session || require('./session').Session;
    this.extraEnv = env || {};
    this.pathPrepend = pathPrepend || null;
    this.dataDir = dataDir;
    this.settings = settings;
    this.shells = shells;
    this.workspaces = [];          // [{id, name, collapsed, sessionIds: []}]
    this.sessions = new Map();     // id -> Session
    this.activeId = null;
    this.counters = { w: 0, s: 0 };
    this.lastSize = { cols: 120, rows: 32 };
    this.stateFile = path.join(dataDir, 'state.json');
    this._saveTimer = null;
    this._changeTimer = null;
  }

  // ---------- persistence ----------
  load() {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { /* first run */ }
    if (st && Array.isArray(st.workspaces) && st.workspaces.length) {
      this.counters = Object.assign({ w: 0, s: 0 }, st.counters);
      if (st.lastSize) this.lastSize = st.lastSize;
      for (const w of st.workspaces) {
        const ws = { id: w.id, name: w.name, collapsed: !!w.collapsed, sessionIds: [] };
        this.workspaces.push(ws);
        for (const s of w.sessions || []) {
          this._spawn({
            id: s.id, name: s.name, workspaceId: ws.id,
            cwd: dirOk(s.cwd) ? s.cwd : homeDir, shellKey: s.shell,
          });
        }
      }
      if (st.activeId && this.sessions.has(st.activeId)) this.activeId = st.activeId;
    }
    if (!this.workspaces.length) {
      const ws = this.createWorkspace({ name: 'main' });
      this.createSession({ workspace: ws.id });
    }
    if (!this.activeId) this.activeId = this.firstSessionId();
    this.changed();
  }

  serialize() {
    return {
      version: 1,
      counters: this.counters,
      lastSize: this.lastSize,
      activeId: this.activeId,
      workspaces: this.workspaces.map((w) => ({
        id: w.id, name: w.name, collapsed: w.collapsed,
        sessions: w.sessionIds.map((id) => this.sessions.get(id)).filter(Boolean)
          .map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, shell: s.shellKey })),
      })),
    };
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(), null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { console.error('save failed', e); }
  }

  changed() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 500);
    if (this._changeTimer) return;
    this._changeTimer = setImmediate(() => { this._changeTimer = null; this.emit('change'); });
  }

  event(type, payload) { this.emit('event', Object.assign({ type, at: Date.now() }, payload)); }

  // ---------- views ----------
  tree() {
    return {
      active: this.activeId,
      workspaces: this.workspaces.map((w) => ({
        id: w.id, name: w.name, collapsed: w.collapsed,
        sessions: w.sessionIds.map((id) => this.sessions.get(id)).filter(Boolean).map((s) => s.info()),
      })),
    };
  }

  firstSessionId() {
    for (const w of this.workspaces) if (w.sessionIds.length) return w.sessionIds[0];
    return null;
  }

  orderedSessionIds() {
    return this.workspaces.flatMap((w) => w.sessionIds);
  }

  // ---------- resolve ----------
  resolveWorkspace(t, { required = true } = {}) {
    if (t == null || t === '' || t === 'current') {
      const s = this.sessions.get(this.activeId);
      const ws = s ? this.ws(s.workspaceId) : this.workspaces[0];
      if (!ws && required) throw new ApiError(404, 'no workspaces');
      return ws;
    }
    const str = String(t);
    let ws = this.workspaces.find((w) => w.id === str);
    if (!ws) {
      const m = this.workspaces.filter((w) => w.name.toLowerCase() === str.toLowerCase());
      if (m.length > 1) throw new ApiError(409, `several workspaces are named "${str}", use the id`);
      ws = m[0];
    }
    if (!ws && /^\d+$/.test(str)) ws = this.workspaces[Number(str) - 1];
    if (!ws && required) throw new ApiError(404, `workspace not found: ${str}`);
    return ws;
  }

  resolveSession(t) {
    if (t == null || t === '' || t === 'current' || t === '.') {
      const s = this.sessions.get(this.activeId);
      if (!s) throw new ApiError(404, 'no active session');
      return s;
    }
    const str = String(t);
    if (this.sessions.has(str)) return this.sessions.get(str);
    let pool = [...this.sessions.values()];
    let name = str;
    const slash = str.indexOf('/');
    if (slash > 0) {
      const ws = this.resolveWorkspace(str.slice(0, slash), { required: false });
      if (ws) { pool = pool.filter((s) => s.workspaceId === ws.id); name = str.slice(slash + 1); }
    }
    const m = pool.filter((s) => s.name.toLowerCase() === name.toLowerCase());
    if (m.length > 1) throw new ApiError(409, `several sessions are named "${name}", use the id or workspace/name`);
    if (m.length === 1) return m[0];
    if (/^\d+$/.test(str)) {
      const id = this.orderedSessionIds()[Number(str) - 1];
      if (id) return this.sessions.get(id);
    }
    throw new ApiError(404, `session not found: ${str}`);
  }

  ws(id) { return this.workspaces.find((w) => w.id === id); }

  // ---------- workspaces ----------
  createWorkspace({ name } = {}) {
    const id = 'w' + (++this.counters.w);
    const ws = { id, name: (name || '').trim() || `workspace ${this.counters.w}`, collapsed: false, sessionIds: [] };
    this.workspaces.push(ws);
    this.changed();
    this.event('workspace.created', { workspace: id });
    return ws;
  }

  updateWorkspace(t, { name, collapsed, index } = {}) {
    const ws = this.resolveWorkspace(t);
    if (typeof name === 'string' && name.trim()) ws.name = name.trim();
    if (typeof collapsed === 'boolean') ws.collapsed = collapsed;
    if (Number.isInteger(index)) {
      const from = this.workspaces.indexOf(ws);
      this.workspaces.splice(from, 1);
      this.workspaces.splice(clamp(index, 0, this.workspaces.length), 0, ws);
    }
    this.changed();
    this.event('workspace.updated', { workspace: ws.id });
    return ws;
  }

  deleteWorkspace(t, { force } = {}) {
    const ws = this.resolveWorkspace(t);
    if (ws.sessionIds.length && !force) throw new ApiError(409, `workspace "${ws.name}" has sessions; use force`);
    for (const id of ws.sessionIds.slice()) this.closeSession(id);
    this.workspaces = this.workspaces.filter((w) => w !== ws);
    if (!this.workspaces.length) this.createWorkspace({ name: 'main' });
    this.changed();
    this.event('workspace.deleted', { workspace: ws.id });
    return { ok: true };
  }

  // ---------- sessions ----------
  _spawn({ id, name, workspaceId, cwd, shellKey, command, index }) {
    const key = this.shells[shellKey] ? shellKey : this.defaultShellKey();
    const s = new this.Session({
      id, name, workspaceId, cwd, shellKey: key, command,
      shell: this.shells[key], cols: this.lastSize.cols, rows: this.lastSize.rows,
      env: this.extraEnv, pathPrepend: this.pathPrepend,
    });
    const ws = this.ws(workspaceId);
    if (Number.isInteger(index)) ws.sessionIds.splice(clamp(index, 0, ws.sessionIds.length), 0, id);
    else ws.sessionIds.push(id);
    this.sessions.set(id, s);
    this._wire(s);
    try {
      s.start();
    } catch (e) {
      s.exited = true; s.exitCode = -1;
      s.term && s.term.write(`\r\n\x1b[31mFailed to start ${this.shells[key].file}: ${e.message}\x1b[0m\r\n`);
    }
    return s;
  }

  defaultShellKey() {
    const want = this.settings.defaultShell;
    if (want && this.shells[want]) return want;
    return this.shells.bash ? 'bash' : (this.shells.pwsh ? 'pwsh' : 'powershell');
  }

  _wire(s) {
    s.on('data', (data, seq) => {
      this.emit('data', s.id, data, seq);
      const now = Date.now();
      // unread = background output, except the initial prompt and redraws after a resize
      if (s.id !== this.activeId && !s.unread && now - s.startedAt > 2000 && now - s.lastResizeAt > 500) {
        s.unread = true; this.changed();
      }
    });
    s.on('meta', () => { this.changed(); this.event('session.updated', { session: s.id }); });
    s.on('bell', () => {
      if (s.id !== this.activeId) { s.unread = true; this.changed(); }
      this.event('session.bell', { session: s.id });
    });
    s.on('exit', (code) => {
      this.emit('exit', s.id, code);
      this.changed();
      this.event('session.exited', { session: s.id, exitCode: code });
      if (this.settings.closeOnExit && code === 0) setTimeout(() => this.sessions.has(s.id) && this.closeSession(s.id), 50);
    });
  }

  createSession({ workspace, name, cwd, shell, command, select = true, after } = {}) {
    let ws;
    if (workspace) ws = this.resolveWorkspace(workspace);
    else ws = this.resolveWorkspace('current', { required: false }) || this.createWorkspace({ name: 'main' });
    if (shell && !this.shells[shell]) throw new ApiError(400, `unknown shell: ${shell}; available: ${Object.keys(this.shells).join(', ')}`);
    let dir = cwd;
    if (!dir) {
      const cur = this.sessions.get(this.activeId);
      dir = cur && cur.workspaceId === ws.id && dirOk(cur.cwd) ? cur.cwd : (this.settings.startDir || homeDir);
    }
    if (!dirOk(dir)) throw new ApiError(400, `directory does not exist: ${dir}`);
    const id = 's' + (++this.counters.s);
    let index;
    if (after) {
      const a = this.resolveSession(after);
      if (a.workspaceId === ws.id) index = ws.sessionIds.indexOf(a.id) + 1;
    }
    const s = this._spawn({
      id, name: (name || '').trim() || this.autoName(ws, command), workspaceId: ws.id,
      cwd: dir, shellKey: shell, command, index,
    });
    ws.collapsed = false;
    if (select || !this.activeId) this.activeId = id;
    this.changed();
    this.event('session.created', { session: id, workspace: ws.id });
    return s;
  }

  autoName(ws, command) {
    if (command) return command.split(/\s+/)[0].replace(/^.*[\\/]/, '').slice(0, 24);
    const names = new Set(ws.sessionIds.map((id) => this.sessions.get(id)?.name));
    let i = 1;
    while (names.has(`shell ${i}`)) i++;
    return `shell ${i}`;
  }

  updateSession(t, { name, status, workspace, index } = {}) {
    const s = this.resolveSession(t);
    if (typeof name === 'string' && name.trim()) s.name = name.trim().slice(0, 80);
    if (status !== undefined) this._setStatus(s, status);
    if (workspace !== undefined || Number.isInteger(index)) {
      const to = workspace !== undefined ? this.resolveWorkspace(workspace) : this.ws(s.workspaceId);
      const from = this.ws(s.workspaceId);
      from.sessionIds = from.sessionIds.filter((id) => id !== s.id);
      const at = Number.isInteger(index) ? clamp(index, 0, to.sessionIds.length) : to.sessionIds.length;
      to.sessionIds.splice(at, 0, s.id);
      s.workspaceId = to.id;
    }
    this.changed();
    this.event('session.updated', { session: s.id });
    return s;
  }

  _setStatus(s, status) {
    if (!STATUSES.includes(status)) throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
    if (s.status === status) return;
    const prev = s.status;
    s.status = status;
    this.event('session.status', { session: s.id, status, prev });
    this.emit('status', s, status, prev);
  }

  selectSession(t) {
    const s = this.resolveSession(t);
    this.activeId = s.id;
    s.unread = false;
    if (s.status === 'done') s.status = 'idle';
    const ws = this.ws(s.workspaceId);
    if (ws.collapsed) ws.collapsed = false;
    this.changed();
    this.event('session.selected', { session: s.id });
    return s;
  }

  closeSession(t) {
    const s = this.resolveSession(t);
    const order = this.orderedSessionIds();
    const idx = order.indexOf(s.id);
    s.kill();
    this.sessions.delete(s.id);
    const ws = this.ws(s.workspaceId);
    if (ws) ws.sessionIds = ws.sessionIds.filter((id) => id !== s.id);
    if (this.activeId === s.id) {
      const rest = order.filter((id) => id !== s.id);
      this.activeId = rest[Math.min(idx, rest.length - 1)] || null;
      if (this.activeId) this.sessions.get(this.activeId).unread = false;
    }
    this.changed();
    this.emit('closed', s.id);
    this.event('session.closed', { session: s.id });
    return { ok: true };
  }

  restartSession(t) {
    const s = this.resolveSession(t);
    const ws = this.ws(s.workspaceId);
    const index = ws.sessionIds.indexOf(s.id);
    const { id, name, cwd, shellKey } = s;
    s.kill();
    this.sessions.delete(id);
    ws.sessionIds.splice(index, 1);
    this.emit('closed', id);
    this._spawn({ id, name, workspaceId: ws.id, cwd: dirOk(cwd) ? cwd : homeDir, shellKey, index });
    this.changed();
    this.event('session.restarted', { session: id });
    return this.sessions.get(id);
  }

  // ---------- input / output ----------
  type(t, text) {
    const s = this.resolveSession(t);
    if (s.exited) throw new ApiError(409, `session ${s.id} has exited`);
    s.write(text);
    return s;
  }

  // Wait for: a regex in new output / on screen, silence, or process exit.
  wait(t, { pattern, screen, idle, exit, timeout = 30000 } = {}) {
    const s = this.resolveSession(t);
    const re = pattern ? new RegExp(pattern, 'm') : null;
    return new Promise((resolve, reject) => {
      let acc = '';
      let done = false;
      let idleTimer = null;
      const timers = [];
      const finish = (err, val) => {
        if (done) return; done = true;
        s.off('data', onData); s.off('exit', onExit);
        timers.forEach(clearTimeout); clearInterval(idleTimer);
        err ? reject(err) : resolve(val);
      };
      const check = async () => {
        if (re && screen) {
          const txt = await s.text();
          const m = re.exec(txt);
          if (m) finish(null, { matched: m[0] });
        }
      };
      const onData = (d) => {
        if (re && !screen) {
          acc = (acc + stripAnsi(d)).slice(-200000);
          const m = re.exec(acc);
          if (m) finish(null, { matched: m[0] });
        } else if (re && screen) {
          clearTimeout(timers[1]);
          timers[1] = setTimeout(check, 60);
        }
      };
      const onExit = (code) => {
        if (exit) finish(null, { exitCode: code });
        else finish(new ApiError(409, `process exited (code ${code}) before the condition was met`));
      };
      if (exit && s.exited) return finish(null, { exitCode: s.exitCode });
      if (s.exited && !exit) return finish(new ApiError(409, `session ${s.id} has already exited`));
      s.on('data', onData); s.on('exit', onExit);
      timers[0] = setTimeout(() => finish(new ApiError(408, 'wait timed out')), timeout);
      if (idle) {
        const since = Date.now();
        idleTimer = setInterval(() => {
          const last = Math.max(s.lastOutputAt, since);
          if (Date.now() - last >= idle) finish(null, { idle: true });
        }, 50);
      }
      if (re && screen) check();
    });
  }

  shutdown() {
    this.saveNow();
    for (const s of this.sessions.values()) s.kill();
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dirOk(p) { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } }

module.exports = { Model, ApiError, STATUSES };
