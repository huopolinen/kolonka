'use strict';
// The model: workspaces → sessions. The single source of truth for both the UI and the API.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ApiError } = require('./errors');
const { homeDir } = require('./shells');
const { dirOk } = require('./paths');
const { OutputMatcher } = require('./match');
const remote = require('./remote');

const { STATUSES } = remote;
const REMOTE_PER_MINUTE = 10;     // open / notify / status requests per tab (and the tabs it opened) per minute
const REMOTE_OPEN_GLOBAL = 20;    // open requests per minute for the whole app
const REMOTE_LOG_PER_MINUTE = 5;  // log lines about remote requests per tab per minute
const REMOTE_DENY_BLOCK = 10 * 60000; // after Deny, open requests from that tab are dropped for this long
const PROCS_CACHE_MS = 1500;      // one process list for the requests of this long
const SAVE_DEBOUNCE = 500;
const SAVE_MAX_WAIT = 2000;
const MAX_TIMEOUT = 2147483647; // the largest delay setTimeout accepts
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 50;
const SCREEN_CHECK_MS = 200;    // wait --screen re-reads the screen at least this often while output flows

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// The largest N among ids like "s12" (prefix "s").
function maxId(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    const m = new RegExp('^' + prefix + '(\\d+)$').exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

class Model extends EventEmitter {
  // Session: the session class; tests pass a fake one so the model can run without node-pty.
  // remoteDeps: { listProcesses, sshExe, isAllowedSshExe } for remote control; tests pass fakes.
  constructor({ dataDir, settings, shells, env, pathPrepend, Session, remoteDeps }) {
    super();
    const deps = remoteDeps || {};
    this._listProcessesRaw = deps.listProcesses || (() => remote.listProcesses());
    this._findSshExe = deps.sshExe || (() => remote.findSshExe(this._remoteCfg().ssh));
    this._isAllowedSshExe = deps.isAllowedSshExe || ((p) => remote.isAllowedSshExe(p, this._remoteCfg().ssh));
    this._procs = null;            // { at, promise }: the process list shared by requests close in time
    this._denyUntil = new WeakMap(); // session -> time until which its open requests are dropped
    this.askRemote = null;         // async ({ session, from, host, cmd }) -> 'once' | 'always' | 'deny'; set by the window
    this.remoteAllowed = [];       // hosts allowed with "Always for this host" (kept in state.json)
    this.firstRun = false;
    this._remoteLimit = new remote.RateLimiter(REMOTE_PER_MINUTE, 60000);
    this._remoteLogLimit = new remote.RateLimiter(REMOTE_LOG_PER_MINUTE, 60000);
    this._malformedLimit = new remote.RateLimiter(1, 60000); // "ignored a malformed request" toasts per tab
    this._askChain = Promise.resolve();
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
    this._saveFirstAt = 0;
    this._unreadable = null; // why state.json could not be read at startup; saving waits until it can
  }

  // ---------- persistence ----------
  load() {
    const st = this._readState();
    this.firstRun = !st && !this._unreadable; // no state.json yet: the window offers "Connect a server…"
    const remembered = st && st.remote && Array.isArray(st.remote.allowedHosts) ? st.remote.allowedHosts : [];
    this.remoteAllowed = [...new Set(remembered.filter(remote.validKey))];
    // restore "rerun": every tab with a command runs it again; "fresh" (default): only tabs marked rerun
    const rerunAll = this.settings.restore === 'rerun';
    if (st && Array.isArray(st.workspaces) && st.workspaces.length) {
      this.counters = Object.assign({ w: 0, s: 0 }, st.counters);
      if (st.lastSize) this.lastSize = st.lastSize;
      for (const w of st.workspaces) {
        if (!w || typeof w.id !== 'string' || this.ws(w.id)) continue;
        const ws = { id: w.id, name: String(w.name || w.id), collapsed: !!w.collapsed, sessionIds: [] };
        this.workspaces.push(ws);
        for (const s of w.sessions || []) {
          if (!s || typeof s.id !== 'string' || this.sessions.has(s.id)) continue;
          // The command is kept for "Restart"; it runs again on its own only for tabs marked rerun
          // or with "restore": "rerun". A tab opened over ssh is its connection: marked rerun (opened by a
          // trusted request to a host you allowed) it connects again, otherwise it waits for Enter.
          const ssh = s.ssh ? remote.normalizeSsh(s.ssh, this._isAllowedSshExe) : null;
          const command = typeof s.command === 'string' ? s.command : undefined;
          const rerun = s.rerun === true;
          this._spawn({
            id: s.id, name: String(s.name || s.id), workspaceId: ws.id,
            cwd: dirOk(s.cwd) ? s.cwd : homeDir, shellKey: s.shell,
            command, runCommand: !!command && (rerun || rerunAll), ssh, rerun,
            deferred: !!ssh && !(rerun || rerunAll),
            fromRemote: s.fromRemote === true, nameFromServer: s.nameFromServer === true,
            remoteRoot: typeof s.remoteRoot === 'string' && /^s\d+$/.test(s.remoteRoot) ? s.remoteRoot : null,
          });
        }
      }
      // never hand out an id that is already taken, whatever the saved counters say
      this.counters.w = Math.max(this.counters.w | 0, maxId(this.workspaces.map((w) => w.id), 'w'));
      this.counters.s = Math.max(this.counters.s | 0, maxId([...this.sessions.keys()], 's'));
      if (st.activeId && this.sessions.has(st.activeId)) this.activeId = st.activeId;
    }
    if (!this.workspaces.length) {
      const ws = this.createWorkspace({ name: 'main' });
      this.createSession({ workspace: ws.id });
    }
    if (!this.activeId) this.activeId = this.firstSessionId();
    this.changed();
  }

  // The saved state, or null on the first run. A file that cannot be read as state is moved
  // aside to state.json.bad-<time> so the next save does not overwrite the user's layout.
  //
  // Any other read error (EBUSY / EPERM: an antivirus or a sync tool holding the file) is retried a few
  // times; if it persists, the file is left alone: saving is held back until it can be read (see saveNow).
  _readState() {
    let raw;
    for (let attempt = 1; ; attempt++) {
      try { raw = fs.readFileSync(this.stateFile, 'utf8'); break; } catch (e) {
        if (e.code === 'ENOENT') return null; // first run
        if (attempt >= READ_ATTEMPTS) {
          this._unreadable = e.code || e.message;
          console.error(`state.json could not be read (${this._unreadable}); it is kept and not overwritten until it can be read`);
          return null;
        }
        sleepSync(READ_RETRY_MS);
      }
    }
    let st = null;
    try { st = JSON.parse(raw); } catch { st = null; }
    if (st && typeof st === 'object' && Array.isArray(st.workspaces)) return st;
    const bad = `${this.stateFile}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(this.stateFile, bad); console.error(`state.json could not be read; moved to ${bad}`); } catch (e) { console.error('state.json could not be read', e); }
    return null;
  }

  // The state.json that could not be read at startup: once it can be read, keep a copy of it
  // (state.json.unread-<time>) before the first save replaces it. False while it still cannot be read.
  _keepUnreadState() {
    let raw;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') return false;
      this._unreadable = null; // gone meanwhile: nothing to keep
      return true;
    }
    const copy = `${this.stateFile}.unread-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.writeFileSync(copy, raw); } catch (e) { console.error('could not keep a copy of state.json', e); return false; }
    console.error(`state.json is readable again; the layout it had is kept in ${copy}`);
    this._unreadable = null;
    return true;
  }

  serialize() {
    return {
      version: 1,
      counters: this.counters,
      lastSize: this.lastSize,
      activeId: this.activeId,
      remote: { allowedHosts: this.remoteAllowed.slice() },
      workspaces: this.workspaces.map((w) => ({
        id: w.id, name: w.name, collapsed: w.collapsed,
        sessions: w.sessionIds.map((id) => this.sessions.get(id)).filter(Boolean)
          .map((s) => Object.assign({ id: s.id, name: s.name, cwd: s.cwd, shell: s.shellKey },
            s.command ? { command: s.command } : {},
            s.ssh ? { ssh: Object.assign({ destination: s.ssh.destination, options: s.ssh.options, cmd: s.ssh.cmd }, s.ssh.exe ? { exe: s.ssh.exe } : {}) } : {},
            s.rerun ? { rerun: true } : {},
            s.fromRemote ? { fromRemote: true } : {},
            s.remoteRoot ? { remoteRoot: s.remoteRoot } : {},
            s.nameFromServer ? { nameFromServer: true } : {})),
      })),
    };
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._saveFirstAt = 0;
    if (this._shutDown) return; // the state saved at shutdown is the one the next start restores
    if (this._unreadable && !this._keepUnreadState()) return;
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(), null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { console.error('save failed', e); }
  }

  // Save 500 ms after the last change, but no later than SAVE_MAX_WAIT after the first unsaved one:
  // a stream of changes (cwd updates from a busy script) must not postpone the save forever.
  _scheduleSave() {
    if (this._shutDown) return;
    const now = Date.now();
    if (!this._saveFirstAt) this._saveFirstAt = now;
    clearTimeout(this._saveTimer);
    const at = Math.min(now + SAVE_DEBOUNCE, this._saveFirstAt + SAVE_MAX_WAIT);
    this._saveTimer = setTimeout(() => this.saveNow(), Math.max(0, at - now));
  }

  // save: false for changes that are not part of the saved state (title, unread, status).
  changed({ save = true } = {}) {
    if (save) this._scheduleSave();
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
  // ssh: { destination, options, cmd, exe } makes the tab an ssh connection: ssh.exe is started
  // directly (no shell in between) with a command line Kolonka quotes itself, and nothing is typed.
  // exe: the ssh.exe of the tab that asked, if it is one Kolonka may start; otherwise the usual one.
  _spawn({ id, name, workspaceId, cwd, shellKey, command, runCommand = true, index, ssh, rerun, deferred, fromRemote, remoteRoot, nameFromServer }) {
    let key; let shell;
    if (ssh) {
      key = 'ssh';
      // no ssh.exe Kolonka may start: the tab is not started (no search on PATH); Enter tries again
      const file = (ssh.exe && this._isAllowedSshExe(ssh.exe) && ssh.exe) || this._findSshExe() || null;
      const argv = remote.buildSshArgs(ssh);
      shell = { label: 'SSH', file, args: argv, commandLine: file ? remote.sshCommandLine(file, argv) : '', env: {} };
      // MSYS=noglob (or CYGWIN) would make Git's ssh.exe read the quotes differently: never inherited
      // (the OpenSSH client of Windows does not read them, so they go for every ssh tab)
      shell.unsetEnv = ['MSYS', 'CYGWIN'];
      if (!file) deferred = true;
      command = undefined;
    } else {
      key = this.shells[shellKey] ? shellKey : this.defaultShellKey();
      shell = this.shells[key];
    }
    const s = new this.Session({
      id, name, workspaceId, cwd, shellKey: key, command, runCommand: ssh ? false : runCommand,
      ssh: ssh || null, rerun: !!rerun, deferred: !!deferred,
      fromRemote: !!fromRemote, remoteRoot: remoteRoot || null, nameFromServer: !!nameFromServer,
      shell, cols: this.lastSize.cols, rows: this.lastSize.rows,
      scrollback: this.settings.scrollback, env: this.extraEnv, pathPrepend: this.pathPrepend,
    });
    const ws = this.ws(workspaceId);
    if (Number.isInteger(index)) ws.sessionIds.splice(clamp(index, 0, ws.sessionIds.length), 0, id);
    else ws.sessionIds.push(id);
    this.sessions.set(id, s);
    this._wire(s);
    try {
      s.start();
      if (ssh && !shell.file) {
        s.term && s.term.write('\r\n\x1b[31mssh.exe not found: install the OpenSSH client of Windows or set remote.ssh in settings.json\x1b[0m\r\n');
        this._log('warn', `${id}: no ssh.exe to start (remote.ssh, Windows OpenSSH, Git for Windows)`);
      }
    } catch (e) {
      s.exited = true; s.exitCode = -1;
      s.term && s.term.write(`\r\n\x1b[31mFailed to start ${shell.file}: ${e.message}\x1b[0m\r\n`);
    }
    return s;
  }

  defaultShellKey() {
    const want = this.settings.defaultShell;
    if (want && this.shells[want]) return want;
    return this.shells.bash ? 'bash' : (this.shells.pwsh ? 'pwsh' : 'powershell');
  }

  _wire(s) {
    // A restarted session reuses the id: only events of the session currently registered under
    // that id may reach the UI and the API, never late ones from the process it replaced.
    const live = () => this.sessions.get(s.id) === s;
    s.on('data', (data, seq) => {
      if (!live()) return;
      this.emit('data', s.id, data, seq);
      const now = Date.now();
      // unread = background output, except the initial prompt and redraws after a resize
      if (s.id !== this.activeId && !s.unread && now - s.startedAt > 2000 && now - s.lastResizeAt > 500) {
        s.unread = true; this.changed({ save: false });
      }
    });
    s.on('meta', (what) => {
      if (!live()) return;
      this.changed({ save: what !== 'title' }); // the title is not saved
      this.event('session.updated', { session: s.id });
    });
    s.on('bell', () => {
      if (!live()) return;
      if (s.id !== this.activeId) { s.unread = true; this.changed({ save: false }); }
      this.event('session.bell', { session: s.id });
    });
    s.on('remote', (msg) => {
      if (!live()) return;
      this.handleRemote(s, msg).catch((e) => this._log('warn', `remote control from ${s.id}: ${e && e.stack || e}`));
    });
    s.on('exit', (code) => {
      if (!live()) return;
      this.emit('exit', s.id, code);
      this.changed({ save: false });
      this.event('session.exited', { session: s.id, exitCode: code });
      if (this.settings.closeOnExit && code === 0) setTimeout(() => live() && this.closeSession(s.id), 50);
    });
  }

  // rerun: run the command again when Kolonka starts. ssh: see _spawn (checked again here).
  // fromRemote / remoteRoot / nameFromServer: set by a remote open (not taken from the HTTP API).
  createSession({ workspace, name, cwd, shell, command, select = true, after, rerun, ssh } = {}, internal = {}) {
    if (ssh !== undefined && ssh !== null) {
      ssh = remote.normalizeSsh(ssh, this._isAllowedSshExe);
      if (!ssh) throw new ApiError(400, 'ssh: { destination, options, cmd } with a valid destination and only -p -l -i -J -4 -6 -o SendEnv=NAME');
    }
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
      // an ssh tab without a name is named after its host (the server usually sends a name)
      id, name: (name || '').trim().slice(0, 80) || (ssh ? ssh.destination.slice(ssh.destination.lastIndexOf('@') + 1).slice(0, 40) : this.autoName(ws, command)),
      workspaceId: ws.id, cwd: dir, shellKey: shell, command, index, ssh, rerun: rerun === true,
      fromRemote: !!internal.fromRemote, remoteRoot: internal.remoteRoot, nameFromServer: !!internal.nameFromServer,
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
    if (s.status === 'done') this._setStatus(s, 'idle'); // looked at: done → idle, with a session.status event
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
    for (const k of ['open', 'notify', 'status', 'log']) { this._remoteLimit.forget(`${k}:${s.id}`); this._remoteLogLimit.forget(`${k}:${s.id}`); }
    this._malformedLimit.forget('malformed:' + s.id);
    this.changed();
    this.emit('closed', s.id);
    this.event('session.closed', { session: s.id });
    return { ok: true };
  }

  restartSession(t) {
    const s = this.resolveSession(t);
    const ws = this.ws(s.workspaceId);
    const index = ws.sessionIds.indexOf(s.id);
    const { id, name, cwd, shellKey, command, ssh, rerun, fromRemote, remoteRoot, nameFromServer } = s;
    s.kill();
    this.sessions.delete(id);
    ws.sessionIds.splice(index, 1);
    this.emit('closed', id);
    // the session's own command (`kolonka new -- npm run dev`) is started again; an ssh tab reconnects
    this._spawn({ id, name, workspaceId: ws.id, cwd: dirOk(cwd) ? cwd : homeDir, shellKey, command, index, ssh, rerun, fromRemote, remoteRoot, nameFromServer });
    this.changed();
    this.event('session.restarted', { session: id });
    return this.sessions.get(id);
  }

  // ---------- remote control (OSC 7711 / 9 / 777 in a tab's output, see remote.js) ----------
  _remoteCfg() { return Object.assign({ enabled: true, allowHosts: [], ssh: '', fromLocalTabs: false, maxTabs: 30 }, this.settings.remote || {}); }

  _log(level, msg) { this.emit('log', level, msg); }

  // At most a few log lines per tab per minute: a `cat` of a broken file must not flood the log.
  _remoteLog(s, level, msg) {
    if (this._remoteLogLimit.take('log:' + s.id)) this._log(level, msg);
  }

  // Something the user should see in the window (a refused request): main turns it into a toast.
  _remoteDenied(s, reason, req = {}) {
    this.event('remote.denied', { session: s.id, reason, host: req.host || null });
    this.emit('remote-notice', { reason, session: s.id, name: s.name, host: req.host || null, options: req.options || null });
    this._remoteLog(s, 'info', `remote open from ${s.id} refused (${reason}): host ${req.host || '?'}`);
  }

  // Limits of a tab opened by a server are counted on the tab that started the chain, so opened tabs
  // do not bring fresh budgets of their own.
  _remoteRoot(s) { return s.remoteRoot || s.id; }

  // One parsed request from session s. Returns a promise (open is asynchronous).
  async handleRemote(s, msg) {
    if (!msg) return;
    if (msg.error) {
      this._remoteLog(s, 'info', `ignored a remote control sequence from ${s.id}: ${msg.error}`);
      // seen in the window too (once a minute per tab), so a script that speaks another format is not
      // silently ignored
      if (this._remoteCfg().enabled !== false && this._malformedLimit.take('malformed:' + s.id)) {
        this.emit('remote-notice', { reason: 'malformed', session: s.id, name: s.name, host: null, options: null });
      }
      this.event('remote.ignored', { session: s.id, error: msg.error });
      return;
    }
    if (this._remoteCfg().enabled === false) return;
    const root = this._remoteRoot(s);
    switch (msg.action) {
      case 'status':
        if (s.status === msg.state) return; // repeated states (a hook on every tool use) cost nothing
        if (!this._remoteLimit.take('status:' + root)) { this._remoteLog(s, 'info', `status changes from ${s.id} dropped: more than ${REMOTE_PER_MINUTE} a minute`); return; }
        this._setStatus(s, msg.state);
        this.changed({ save: false });
        return;
      case 'rename':
        if (msg.name && msg.name !== s.name) { s.name = msg.name; s.nameFromServer = true; this.changed(); this.event('session.updated', { session: s.id }); }
        return;
      case 'notify':
        if (!this._remoteLimit.take('notify:' + root)) { this._remoteLog(s, 'info', `notifications from ${s.id} dropped: more than ${REMOTE_PER_MINUTE} a minute`); return; }
        this.event('session.notify', { session: s.id, title: msg.title, text: msg.text });
        this.emit('notify', { title: msg.title, text: msg.text, session: s.id });
        return;
      case 'open': return this._remoteOpen(s, msg);
      default: return;
    }
  }

  // The process list, shared by the requests of the last PROCS_CACHE_MS (one PowerShell, not one each).
  _listProcesses() {
    const now = Date.now();
    if (this._procs && now - this._procs.at < PROCS_CACHE_MS) return this._procs.promise;
    const promise = Promise.resolve().then(() => this._listProcessesRaw());
    this._procs = { at: now, promise };
    promise.catch(() => { if (this._procs && this._procs.promise === promise) this._procs = null; });
    return promise;
  }

  // The ssh connection a tab belongs to: the one Kolonka opened it with, or an ssh.exe running
  // under its shell (the user typed `ssh host`). null for a local tab.
  async _sshOrigin(s) {
    if (s.ssh) return { destination: s.ssh.destination, options: s.ssh.options, dropped: [], exe: s.ssh.exe || null };
    if (!s.pid || s.exited) return null;
    let procs;
    try { procs = await this._listProcesses(); } catch (e) { this._log('warn', `remote open: ${e.message}`); return null; }
    return remote.sshOriginFromTree(s.pid, procs || []);
  }

  // key: remote.destKey (user@host:port); compared as a whole.
  remoteHostAllowed(key) {
    const cfg = this._remoteCfg();
    const list = (Array.isArray(cfg.allowHosts) ? cfg.allowHosts : []).concat(this.remoteAllowed);
    return list.some((e) => remote.hostMatches(e, key));
  }

  allowRemoteHost(key) {
    if (!remote.validKey(key) || this.remoteAllowed.some((h) => h.toLowerCase() === key.toLowerCase())) return;
    this.remoteAllowed.push(key);
    this.changed();
  }

  forgetRemoteHost(key) {
    const before = this.remoteAllowed.length;
    this.remoteAllowed = this.remoteAllowed.filter((h) => h.toLowerCase() !== String(key).toLowerCase());
    if (this.remoteAllowed.length !== before) this.changed();
    return before !== this.remoteAllowed.length;
  }

  // "Connect a server" (⚙ menu, `kolonka remote connect`): the user named the server, so it is trusted
  // as if they had pressed "Always for this host", and a tab connects to it (rerun: it reconnects when
  // Kolonka starts). The ssh config side is bin/sshconfig.js. This trusts the host and nothing more:
  // a request opens a tab without a question only with the tab's own token and for that same host
  // (_remoteOpen), exactly as after "Always".
  connectServer({ destination, options = [], cmd = '', name, workspace, open = true, select = true } = {}) {
    const ssh = remote.normalizeSsh({ destination, options, cmd: cmd || '' });
    if (!ssh) throw new ApiError(400, 'connect: a valid ssh destination, options -p -l -i -J -4 -6 -o SendEnv=NAME only, a one-line command');
    if (ssh.cmd && !open) throw new ApiError(400, 'connect: a command needs a tab (open)');
    const key = remote.destKey(ssh);
    this.allowRemoteHost(key);
    if (!this.remoteHostAllowed(key)) throw new ApiError(500, `connect: ${key} could not be trusted`);
    let created = null;
    if (open) {
      let ws;
      if (workspace) ws = this.resolveWorkspace(workspace, { required: false }) || this.createWorkspace({ name: remote.sanitize(workspace, remote.MAX_NAME) });
      created = this.createSession({ workspace: ws ? ws.id : undefined, name: remote.sanitize(name, remote.MAX_NAME), select, rerun: true, ssh });
    }
    this.saveNow(); // the trust is on disk before the caller reports it
    this._log('info', `connected ${key}${created ? `: ${created.id}` : ''}`);
    this.event('remote.connected', { host: key, session: created ? created.id : null });
    return { host: key, session: created ? created.id : null };
  }

  // One permission dialog at a time. Every request is asked about, also one that waited behind an
  // "Always" for its host: what is in the queue was not seen by the user. 'none': nobody to ask.
  _askQueued(req) {
    const run = async () => {
      if (typeof this.askRemote !== 'function') return 'none';
      try { return await this.askRemote(req); } catch (e) { this._log('warn', 'remote open dialog: ' + e.message); return 'none'; }
    };
    const p = this._askChain.then(run, run);
    this._askChain = p.catch(() => {});
    return p;
  }

  async _remoteOpen(s, msg) {
    const cfg = this._remoteCfg();
    const root = this._remoteRoot(s);
    const until = this._denyUntil.get(s);
    if (until && Date.now() < until) { this._remoteLog(s, 'info', `remote open from ${s.id} dropped: denied before`); return; }
    if (!this._remoteLimit.take('open:' + root)) {
      this._remoteLog(s, 'info', `remote open from ${s.id} dropped: more than ${REMOTE_PER_MINUTE} a minute`);
      return;
    }
    if (!this._remoteLimit.take('open:*', Date.now(), REMOTE_OPEN_GLOBAL)) {
      this._remoteLog(s, 'info', `remote open from ${s.id} dropped: more than ${REMOTE_OPEN_GLOBAL} a minute in all tabs`);
      return;
    }
    const max = Number.isInteger(cfg.maxTabs) && cfg.maxTabs >= 0 ? cfg.maxTabs : 30;
    const live = [...this.sessions.values()].filter((x) => x.fromRemote && !x.exited).length;
    if (live >= max) return this._remoteDenied(s, 'too-many', { host: msg.host });

    const same = msg.host === remote.SAME;
    const origin = await this._sshOrigin(s);
    if (this.sessions.get(s.id) !== s) return; // closed or restarted meanwhile
    // a tab that is not an ssh session never opens tabs: `cat` of a file in a local shell must not
    if (!origin && (same || !cfg.fromLocalTabs)) return this._remoteDenied(s, same ? 'no-ssh' : 'not-ssh', { host: msg.host });
    // a connection that needs options Kolonka does not carry over (-o, -F …) is not made without them
    if (same && origin.dropped.length) return this._remoteDenied(s, 'ssh-options', { host: remote.destKey(origin), options: origin.dropped });
    // the tab's own server named explicitly is the same as @same: its options (-J …) and ssh.exe
    const sameHost = !!origin && (same || remote.sameDest({ destination: msg.host }, origin));
    if (!same && sameHost && origin.dropped.length) return this._remoteDenied(s, 'ssh-options', { host: remote.destKey(origin), options: origin.dropped });
    const target = sameHost
      ? { destination: origin.destination, options: origin.options, exe: origin.exe }
      : { destination: msg.host, options: [], exe: origin ? origin.exe : null };
    if (!(target.exe && this._isAllowedSshExe(target.exe)) && !this._findSshExe()) return this._remoteDenied(s, 'no-ssh-exe', { host: target.destination });

    const key = remote.destKey(target);
    // the tab's own token: the request comes from a process of this ssh session, not from text it shows.
    // That only vouches for the server the tab is connected to (the token travels with the session, and
    // a server can forward it further): without a question only to that same host, and only if allowed.
    const verified = remote.tokenEquals(msg.token, s.token);
    let trusted = verified && sameHost && this.remoteHostAllowed(key);
    if (!trusted) {
      const answer = await this._askQueued({
        session: s.id, name: s.nameFromServer ? null : s.name, from: origin ? remote.destKey(origin) : null,
        host: key, cmd: msg.cmd, same, verified,
      });
      if (this.sessions.get(s.id) !== s) return;
      if (answer === 'always' && verified) { this.allowRemoteHost(key); trusted = true; } else if (answer === 'deny-tab') {
        this._denyUntil.set(s, Infinity);
        return this._remoteDenied(s, 'denied', { host: key });
      } else if (answer !== 'once' && answer !== 'always') {
        if (answer !== 'none') this._denyUntil.set(s, Date.now() + REMOTE_DENY_BLOCK);
        return this._remoteDenied(s, 'denied', { host: key });
      }
    }
    let ws = null;
    if (msg.ws) ws = this.workspaces.find((w) => w.name.toLowerCase() === msg.ws.toLowerCase()) || this.createWorkspace({ name: msg.ws });
    else ws = this.ws(s.workspaceId);
    // reconnect at startup only what you trust: a verified request to a host you allowed
    const rerun = trusted && msg.rerun !== false;
    const created = this.createSession({
      workspace: ws ? ws.id : undefined, name: msg.name, select: msg.select, rerun,
      ssh: { destination: target.destination, options: target.options, cmd: msg.cmd, exe: target.exe || undefined },
    }, { fromRemote: true, remoteRoot: root, nameFromServer: !!msg.name });
    this._log('info', `remote open from ${s.id}: ${created.id} → ${key}${verified ? '' : ' (unverified, allowed in the dialog)'}`);
    this.event('remote.opened', { session: s.id, created: created.id, host: key, verified, rerun });
    return created;
  }

  // ---------- input / output ----------
  type(t, text) {
    const s = this.resolveSession(t);
    if (s.exited) throw new ApiError(409, `session ${s.id} has exited`);
    s.write(text);
    return s;
  }

  // Wait for: a regex in new output / on screen, silence, or process exit.
  //   since:    also search output that arrived after this seq (as returned by type/keys), so
  //             nothing is missed between typing a command and starting to wait
  //   skipEcho: ignore the first line of that output — the echo of the typed command itself
  //   timeout:  ms; 0 = no limit (the wait ends when the client disconnects); default 30000
  //   signal:   an AbortSignal; aborting drops the wait (the HTTP client went away)
  wait(t, { pattern, screen, idle, exit, since, skipEcho, timeout = 30000, signal } = {}) {
    const s = this.resolveSession(t);
    const re = pattern ? new RegExp(pattern, 'm') : null;
    if (timeout === null) timeout = 30000;
    [timeout, idle, since] = [timeout, idle, since].map((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v));
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT) {
      throw new ApiError(400, `timeout must be a number of ms from 0 (no limit) to ${MAX_TIMEOUT}`);
    }
    if (idle !== undefined && idle !== null && idle !== false && (typeof idle !== 'number' || !(idle > 0) || idle > MAX_TIMEOUT)) {
      throw new ApiError(400, 'idle must be a positive number of ms');
    }
    if (since !== undefined && since !== null && (!Number.isInteger(since) || since < 0)) {
      throw new ApiError(400, 'since must be a seq returned by type / keys / info');
    }
    if (!re && !idle && !exit) throw new ApiError(400, 'pass pattern, idle or exit');
    return new Promise((resolve, reject) => {
      let done = false;
      let idleTimer = null;
      let timeoutTimer = null;
      let screenTimer = null;
      let fullTimer = null;
      let checking = false;
      let lastCheckAt = 0;
      const matcher = re && !screen ? new OutputMatcher(re, { skipLine: !!skipEcho }) : null;
      const finish = (err, val) => {
        if (done) return; done = true;
        s.off('data', onData); s.off('exit', onExit); s.off('killed', onKilled);
        if (signal) signal.removeEventListener('abort', onAbort);
        clearTimeout(timeoutTimer); clearTimeout(screenTimer); clearTimeout(fullTimer); clearInterval(idleTimer);
        err ? reject(err) : resolve(Object.assign({ seq: s.seq }, val));
      };
      const check = async () => {
        screenTimer = null;
        if (done) return;
        if (checking) { scheduleCheck(); return; }
        checking = true;
        lastCheckAt = Date.now();
        try {
          const m = re.exec(await s.text());
          if (m) finish(null, { matched: m[0] });
        } catch { /* the session is gone; its exit or close ends the wait */ }
        checking = false;
      };
      // throttle, not debounce: continuous output must not postpone the check forever
      const scheduleCheck = () => {
        if (screenTimer || done) return;
        const delay = Math.max(30, SCREEN_CHECK_MS - (Date.now() - lastCheckAt));
        screenTimer = setTimeout(check, delay);
      };
      // a match that starts before the quick search window is found by a full search a little later
      const scheduleFull = () => {
        const due = matcher.fullScanDue();
        if (due < 0 || fullTimer || done) return;
        fullTimer = setTimeout(() => {
          fullTimer = null;
          if (done) return;
          const m = matcher.fullScan();
          if (m) finish(null, { matched: m[0] });
        }, due);
      };
      const feed = (d) => {
        const m = matcher.push(d);
        if (m) finish(null, { matched: m[0] });
        else scheduleFull();
        return !!m;
      };
      const onData = (d) => {
        if (matcher) feed(d);
        else if (re && screen) scheduleCheck();
      };
      const onExit = (code) => {
        if (exit) finish(null, { exitCode: code });
        else finish(new ApiError(409, `process exited (code ${code}) before the condition was met`));
      };
      const onKilled = () => finish(new ApiError(409, `session ${s.id} was closed or restarted`));
      const onAbort = () => finish(new ApiError(499, 'the client went away'));
      if (signal && signal.aborted) return finish(new ApiError(499, 'the client went away'));
      if (matcher && since !== undefined && since !== null && feed(s.outputSince(since).data)) return;
      if (exit && s.exited) return finish(null, { exitCode: s.exitCode });
      if (s.exited && !exit) return finish(new ApiError(409, `session ${s.id} has already exited`));
      s.on('data', onData); s.on('exit', onExit); s.on('killed', onKilled);
      if (signal) signal.addEventListener('abort', onAbort);
      if (timeout > 0) timeoutTimer = setTimeout(() => finish(new ApiError(408, 'wait timed out')), timeout);
      if (idle) {
        const start = Date.now();
        idleTimer = setInterval(() => {
          const last = Math.max(s.lastOutputAt, start);
          if (Date.now() - last >= idle) finish(null, { idle: true });
        }, 50);
      }
      if (re && screen) check();
    });
  }

  // Quit or "Restart to update": save the tabs, then stop the shells. Nothing is saved after this: a killed
  // shell that exits with 0 closes its tab under closeOnExit, and that must not reach the saved state.
  shutdown() {
    this.saveNow();
    this._shutDown = true;
    for (const s of this.sessions.values()) s.kill();
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = { Model, ApiError, STATUSES };
