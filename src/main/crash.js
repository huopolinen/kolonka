'use strict';
// Crash handling: a log file, native minidumps, fatal-error dialogs and a pre-filled GitHub issue.
// Nothing is uploaded automatically — the user reviews the issue in the browser and submits it.
const { app, dialog, shell, crashReporter } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact } = require('./redact');

const MAX_LOG = 1024 * 1024;
const ISSUE_URL_LIMIT = 7600; // GitHub rejects very long /issues/new URLs

class Crash {
  // secrets: () => [strings] that must never reach a report (API token, API keys).
  // beforeExit: called before a fatal error ends the process with app.exit, which skips before-quit.
  constructor({ dataDir, pkg, t, getWin, info, secrets, beforeExit }) {
    this.dir = path.join(dataDir, 'logs');
    this.file = path.join(this.dir, 'main.log');
    this.marker = path.join(dataDir, 'running.json');
    this.pkg = pkg;
    this.t = t;
    this.getWin = getWin;
    this.info = info || (() => ({}));
    this.secrets = secrets || (() => []);
    this.beforeExit = beforeExit || (() => {});
    this.lastDialog = 0;
    this.prev = null;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  repoUrl() {
    const r = this.pkg.repository;
    const url = typeof r === 'string' ? r : r && r.url;
    return (url || 'https://github.com/huopolinen/kolonka').replace(/^git\+/, '').replace(/\.git$/, '');
  }

  start() {
    try { crashReporter.start({ uploadToServer: false, compress: true }); } catch (e) { this.log('warn', 'crashReporter: ' + e.message); }
    this.rotate();
    // was the previous run closed uncleanly?
    try { this.prev = JSON.parse(fs.readFileSync(this.marker, 'utf8')); } catch { this.prev = null; }
    this.writeMarker({ pid: process.pid, startedAt: Date.now(), version: this.pkg.version });
    this.log('info', `start ${this.pkg.name} ${this.pkg.version} electron ${process.versions.electron} ${os.type()} ${os.release()} ${process.arch}`);

    process.on('uncaughtException', (err) => this.fatal(err));
    process.on('unhandledRejection', (reason) => this.log('error', 'unhandledRejection: ' + fmt(reason)));
    const origError = console.error.bind(console);
    console.error = (...a) => { this.log('error', a.map(fmt).join(' ')); origError(...a); };

    app.on('render-process-gone', (_e, wc, details) => this.rendererGone(wc, details));
    app.on('child-process-gone', (_e, d) => this.log('error', `child process gone: ${d.type} ${d.reason} code=${d.exitCode} ${d.name || ''}`));
    // Windows logoff / shutdown arrives as BrowserWindow 'session-end' (app has no such event): see main.js
  }

  writeMarker(obj) { try { fs.writeFileSync(this.marker, JSON.stringify(obj)); } catch { /* ignore */ } }
  cleanExit() { try { fs.unlinkSync(this.marker); } catch { /* ignore */ } }

  rotate() {
    try {
      if (fs.statSync(this.file).size > MAX_LOG) fs.renameSync(this.file, path.join(this.dir, 'main.old.log'));
    } catch { /* no log yet */ }
  }

  log(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${String(msg).replace(/\n/g, '\n    ')}\n`;
    try { fs.appendFileSync(this.file, line); } catch { /* ignore */ }
  }

  dumpsSince(ts) {
    const out = [];
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.dmp')) { try { if (fs.statSync(p).mtimeMs >= ts) out.push(p); } catch { /* ignore */ } }
      }
    };
    walk(app.getPath('crashDumps'));
    return out;
  }

  // Called once the window is up: offer a report if the last run crashed.
  async checkPrevious() {
    const p = this.prev;
    if (!p) return;
    const dumps = this.dumpsSince(p.startedAt || 0);
    if (!p.fatal && !dumps.length) return; // killed or powered off, not a crash
    this.log('warn', `previous run ended uncleanly (fatal=${!!p.fatal}, dumps=${dumps.length})`);
    const { response } = await dialog.showMessageBox(this.getWin(), {
      type: 'warning',
      message: this.t('crash.previousTitle'),
      detail: this.t('crash.previousDetail') + (p.fatal ? `\n\n${p.fatal}` : ''),
      buttons: [this.t('crash.btnReport'), this.t('crash.btnLogs'), this.t('crash.btnNotNow')],
      defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 0) this.report({ title: 'Crash: ' + (p.fatal ? p.fatal.split('\n')[0] : 'native crash'), error: p.fatal, dumps });
    if (response === 1) this.openLogs();
  }

  fatal(err) {
    const text = fmt(err);
    this.log('fatal', text);
    this.writeMarker({ pid: process.pid, startedAt: Date.now(), version: this.pkg.version, fatal: text.slice(0, 2000) });
    if (Date.now() - this.lastDialog < 15000 || !app.isReady()) return;
    this.lastDialog = Date.now();
    const r = dialog.showMessageBoxSync(this.getWin() || undefined, {
      type: 'error',
      message: this.t('crash.fatalTitle'),
      detail: this.t('crash.fatalDetail', { message: (err && err.message) || text.split('\n')[0] }),
      buttons: [this.t('crash.btnReport'), this.t('crash.btnContinue'), this.t('crash.btnQuit')],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (r === 0) this.report({ title: 'Error: ' + ((err && err.message) || text.split('\n')[0]).slice(0, 120), error: text });
    if (r === 2) {
      try { this.beforeExit(); } catch (e) { this.log('error', 'beforeExit: ' + fmt(e)); }
      app.exit(1);
    }
  }

  async rendererGone(wc, details) {
    this.log('error', `renderer gone: ${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === 'clean-exit') return;
    const win = this.getWin();
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'error',
      message: this.t('crash.rendererTitle', { reason: details.reason }),
      detail: this.t('crash.rendererDetail'),
      buttons: [this.t('crash.btnReload'), this.t('crash.btnReport'), this.t('crash.btnQuit')],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response === 1) this.report({ title: `Window crashed (${details.reason})`, error: `render-process-gone: ${JSON.stringify(details)}`, dumps: this.dumpsSince(Date.now() - 60000) });
    if (response === 2) { app.quit(); return; }
    try { if (!wc.isDestroyed()) wc.reload(); } catch { /* window may be gone */ }
  }

  openLogs() { shell.openPath(this.dir); }

  tail(lines) {
    let s = '';
    try { s = fs.readFileSync(this.file, 'utf8'); } catch { /* none */ }
    return s.split('\n').slice(-lines).join('\n');
  }

  redact(s) {
    const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
    let secrets = [];
    try { secrets = (this.secrets() || []).filter(Boolean); } catch { /* report without them */ }
    return redact(s, { home: os.homedir(), user, host: os.hostname(), secrets });
  }

  // Open a pre-filled GitHub issue. The user sees it before anything is sent.
  report({ title, error, dumps } = {}) {
    const info = this.info();
    const env = [
      `- Kolonka: ${this.pkg.version}${app.isPackaged ? '' : ' (dev)'}`,
      `- Windows: ${os.release()} ${process.arch}`,
      `- Electron: ${process.versions.electron}, Chrome ${process.versions.chrome}`,
      `- Locale: ${app.getLocale()}`,
      ...Object.entries(info).map(([k, v]) => `- ${k}: ${v}`),
    ].join('\n');
    const build = (logLines) => {
      const body = [
        '### What happened',
        '<!-- What were you doing when it broke? -->',
        '',
        '### Environment',
        env,
        error ? '\n### Error\n```\n' + this.redact(error).slice(0, 2500) + '\n```' : '',
        dumps && dumps.length ? `\n### Crash dumps\n${dumps.length} minidump(s) saved locally — zip and attach them if you can.` : '',
        '\n### Log (last lines)\n```\n' + this.redact(this.tail(logLines)) + '\n```',
      ].join('\n');
      const q = new URLSearchParams({ title: this.redact(title || 'Problem report'), body, labels: 'bug' });
      return `${this.repoUrl()}/issues/new?${q}`;
    };
    let url = build(60);
    for (const n of [40, 25, 12, 0]) { if (url.length <= ISSUE_URL_LIMIT) break; url = build(n); }
    if (url.length > ISSUE_URL_LIMIT) url = url.slice(0, ISSUE_URL_LIMIT);
    this.log('info', 'opening issue report');
    shell.openExternal(url);
    if (dumps && dumps.length) shell.openPath(path.dirname(dumps[0]));
    return url;
  }
}

function fmt(x) {
  if (x instanceof Error) return x.stack || x.message;
  if (typeof x === 'object') { try { return JSON.stringify(x); } catch { return String(x); } }
  return String(x);
}

module.exports = { Crash };
