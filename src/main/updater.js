'use strict';
// Updates from this repository's GitHub releases, through electron-updater.
// settings.json "updates": "auto" (check, download in the background, install on quit) | "notify" (show the
// new version, download on request) | "off". Only a packaged build checks; see UpdatePolicy.shouldRun.
//
// Events: 'state' (the public state changed), 'download-failed' ({ message, checksum }).
const { EventEmitter } = require('events');
const P = require('../shared/update-policy');

const PHASES = ['off', 'idle', 'checking', 'available', 'downloading', 'downloaded'];

class Updater extends EventEmitter {
  // load: returns electron-updater's autoUpdater (injected by the tests); it is not loaded when updates are off.
  constructor({ mode, version, log, isPackaged, env = process.env, isolated = false, load, timers = { setTimeout, clearTimeout } }) {
    super();
    this.version = version;
    this.log = log || (() => {});
    this.load = load || (() => require('electron-updater').autoUpdater);
    this.timers = timers;
    const m = P.parseMode(mode);
    if (m.warning) this.log('warn', m.warning);
    this.mode = m.mode;
    const tf = P.testFeed(env.KOLONKA_UPDATE_TEST_FEED);
    if (tf.error) this.log('warn', tf.error);
    this.feed = tf.feed || P.FEED;
    const run = P.shouldRun({ isPackaged, mode: this.mode, env, isolated, testFeed: tf.feed });
    this.enabled = run.on;
    this.s = { phase: run.on ? 'idle' : 'off', mode: this.mode, current: version, version: null, percent: 0, manual: false, reason: run.reason };
    this.u = null;
    this._checking = null;
    this._downloading = null;
    this._timer = null;
    this.installing = false;
    const where = this.feed.provider === 'github' ? `github.com/${this.feed.owner}/${this.feed.repo}` : `${this.feed.url} (test feed)`;
    this.log('info', run.on ? `updates: ${this.mode}, current version ${version}, feed ${where}` : `updates: off (${run.reason})`);
  }

  state() { return Object.assign({}, this.s); }

  _set(patch) {
    Object.assign(this.s, patch);
    if (!PHASES.includes(this.s.phase)) throw new Error('bad update phase ' + this.s.phase);
    this.emit('state', this.state());
  }

  // Set up electron-updater and schedule the checks: CHECK_DELAY_MS after start, then every CHECK_EVERY_MS.
  start() {
    if (!this.enabled || this.u) return;
    const u = this.u = this.load();
    u.logger = {
      info: (m) => this.log('info', 'updater: ' + m),
      warn: (m) => this.log('warn', 'updater: ' + m),
      error: (m) => this.log('error', 'updater: ' + m),
      debug: () => {},
    };
    // Kolonka downloads and installs itself (download() / installNow()), so the result of every step is known here
    u.autoDownload = false;
    u.autoInstallOnAppQuit = P.installOnQuit(this.mode);
    u.autoRunAppAfterInstall = true;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.disableWebInstaller = true;
    // The installer is not code-signed yet, so there is no publisherName and electron-updater does not check
    // the installer's signature (verifyUpdateCodeSignature stays unset): the sha512 in latest.yml is what
    // protects the download. Once releases are signed (SignPath), set build.win.signtoolOptions.publisherName
    // in package.json: app-update.yml then carries it and electron-updater refuses an installer not signed by it.
    u.setFeedURL(Object.assign({}, this.feed));
    // electron-updater also reports every failure as an 'error' event, and an EventEmitter without an
    // 'error' listener throws; the promises below handle the failures, this only keeps them in the log
    u.on('error', (e) => this.log('warn', 'updater error: ' + (e && e.message || e)));
    u.on('download-progress', (p) => {
      const percent = Math.floor(p && p.percent || 0);
      if (this.s.phase === 'downloading' && percent !== this.s.percent) this._set({ percent });
    });
    this._schedule(P.CHECK_DELAY_MS);
  }

  stop() {
    if (this._timer) this.timers.clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule(ms) {
    this.stop();
    this._timer = this.timers.setTimeout(() => {
      this._timer = null;
      this.check({ manual: false }).finally(() => this._schedule(P.CHECK_EVERY_MS));
    }, ms);
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  // -> { ok: true, available, version } | { ok: false, off: reason } | { ok: false, error }
  check({ manual = false } = {}) {
    if (!this.enabled) return Promise.resolve({ ok: false, off: this.s.reason });
    if (!this.u) this.start();
    const phase = this.s.phase;
    // a download is under way or done: the next check would only find the same version again
    if (phase === 'downloading' || phase === 'downloaded') {
      if (manual && !this.s.manual) this._set({ manual: true });
      return Promise.resolve({ ok: true, available: true, version: this.s.version, phase });
    }
    if (this._checking) return this._checking;
    this._set({ phase: 'checking' });
    this._checking = (async () => {
      try {
        const r = await this.u.checkForUpdates();
        // null: electron-updater considers itself inactive; that is not "up to date"
        if (!r) throw new Error('electron-updater did not check (inactive)');
        const info = r.updateInfo;
        if (!r.isUpdateAvailable || !info) {
          this.log('info', `update check: ${this.version} is up to date (latest published: ${info ? info.version : 'unknown'})`);
          this._set({ phase: 'idle', version: null });
          return { ok: true, available: false, version: this.version };
        }
        this.log('info', `update check: ${info.version} is available (current ${this.version})`);
        this._set({ phase: 'available', version: info.version, percent: 0, manual: this.s.manual || manual });
        if (P.onAvailable(this.mode) === 'download') this.download({ manual }); // reports its own failure
        return { ok: true, available: true, version: info.version, phase: this.s.phase };
      } catch (e) {
        const message = errorText(e);
        // offline or GitHub unreachable: the log only, unless the user asked (UpdatePolicy.showError)
        this.log('warn', `update check failed${manual ? '' : ' (background)'}: ${message}`);
        // a version found earlier is still there to download
        this._set({ phase: this.s.version ? 'available' : 'idle' });
        return { ok: false, error: message };
      } finally {
        this._checking = null;
      }
    })();
    return this._checking;
  }

  // -> { ok: true } | { ok: false, error, checksum }
  download({ manual = false } = {}) {
    if (!this.enabled || !this.u) return Promise.resolve({ ok: false, error: 'updates are off' });
    if (this.s.phase === 'downloaded') return Promise.resolve({ ok: true });
    if (this._downloading) return this._downloading;
    if (this.s.phase !== 'available') return Promise.resolve({ ok: false, error: 'no update to download' });
    const version = this.s.version;
    this.log('info', `downloading update ${version}`);
    this._set({ phase: 'downloading', percent: 0, manual: this.s.manual || manual });
    this._downloading = Promise.resolve()
      .then(() => this.u.downloadUpdate())
      .then((files) => {
        // electron-updater has checked the file against the sha512 in latest.yml before resolving
        this.log('info', `update ${version} downloaded, sha512 matches latest.yml: ${(files || []).join(', ')}`);
        this._set({ phase: 'downloaded', percent: 100 });
        return { ok: true };
      }, (e) => {
        const checksum = !!(e && e.code === 'ERR_CHECKSUM_MISMATCH');
        const message = errorText(e);
        this.log('error', `update ${version} download failed${checksum ? ' (integrity check)' : ''}: ${message}`);
        this._set({ phase: 'available', percent: 0 });
        const failure = { message, checksum };
        this.emit('download-failed', failure);
        return Object.assign({ ok: false, error: message }, failure);
      })
      .finally(() => { this._downloading = null; });
    return this._downloading;
  }

  // Install the downloaded update now and start Kolonka again. beforeQuit saves the state and stops the shells
  // and whisper-server, like a normal quit, before the installer starts. -> true if the installer was started.
  installNow({ beforeQuit }) {
    if (this.s.phase !== 'downloaded' || this.installing) return false;
    this.installing = true;
    this.stop();
    this.log('info', `installing update ${this.s.version} and restarting`);
    try { beforeQuit(); } catch (e) { this.log('error', 'before update: ' + (e && e.stack || e)); }
    // silent (/S) and start Kolonka again afterwards (--force-run); a per-user installation needs no UAC
    this.u.quitAndInstall(true, true);
    return true;
  }
}

function errorText(e) {
  const m = String(e && e.message || e || 'unknown error');
  return m.split('\n')[0].slice(0, 300);
}

module.exports = { Updater, PHASES };
