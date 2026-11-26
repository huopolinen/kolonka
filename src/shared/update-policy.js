'use strict';
// Decisions of the auto-updater, without Electron: whether this process checks for updates, what the
// sidebar shows, and what "Restart to update" and quitting do. Used by src/main/updater.js and by the
// window (src/renderer/update.js), and covered by test/update-policy.test.js.
(function (root) {
  const MODES = ['auto', 'notify', 'off'];
  const CHECK_DELAY_MS = 30 * 1000;            // first check after start, off the window's startup path
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;   // then every 6 hours

  // The only feed: published (not draft, not prerelease) releases of this repository, over https.
  const FEED = Object.freeze({ provider: 'github', owner: 'huopolinen', repo: 'kolonka' });

  // settings.json "updates" -> { mode, warning }. A value Kolonka does not know is read as "notify":
  // it tells about a new version but does not download or install anything on its own.
  function parseMode(value) {
    if (value === undefined || value === null) return { mode: 'auto', warning: null };
    if (MODES.includes(value)) return { mode: value, warning: null };
    return {
      mode: 'notify',
      warning: `settings.json: "updates" must be one of ${MODES.join(', ')}, not ${JSON.stringify(value)}; using "notify"`,
    };
  }

  // Whether this process checks for updates -> { on, reason }. reason: dev | env | setting | isolated.
  // An instance with its own data folder (KOLONKA_DATA) shares the installation with the main one, so
  // only the main instance updates it; the test feed (see testFeed) lifts that for the end-to-end test.
  function shouldRun({ isPackaged, mode, env = {}, isolated = false, testFeed = null }) {
    if (!isPackaged) return { on: false, reason: 'dev' };
    if (env.KOLONKA_NO_UPDATE && env.KOLONKA_NO_UPDATE !== '0') return { on: false, reason: 'env' };
    if (mode === 'off') return { on: false, reason: 'setting' };
    if (isolated && !testFeed) return { on: false, reason: 'isolated' };
    return { on: true, reason: null };
  }

  // KOLONKA_UPDATE_TEST_FEED: a feed on this computer for test/smoke/updater.js -> { feed, error }.
  // Only a loopback address is accepted, so it cannot point Kolonka at another server; the download is
  // still checked against the sha512 in that feed's latest.yml.
  function testFeed(value) {
    if (!value) return { feed: null, error: null };
    let u;
    try { u = new URL(value); } catch { return { feed: null, error: `KOLONKA_UPDATE_TEST_FEED is not a URL: ${value}` }; }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!/^https?:$/.test(u.protocol) || !loopback) {
      return { feed: null, error: `KOLONKA_UPDATE_TEST_FEED ignored: only http(s)://127.0.0.1 or localhost is accepted, not ${value}` };
    }
    return { feed: { provider: 'generic', url: u.href.endsWith('/') ? u.href : u.href + '/' }, error: null };
  }

  // What Kolonka does when it finds a newer version: download it in the background, or only show it.
  function onAvailable(mode) { return mode === 'auto' ? 'download' : 'show'; }

  // electron-updater's autoInstallOnAppQuit: a downloaded update is installed on a normal quit only in auto.
  function installOnQuit(mode) { return mode === 'auto'; }

  // The sidebar bar for an updater state -> null | { kind: 'available' | 'downloading' | 'ready', version, percent }.
  // In auto mode the download runs in the background and the bar appears once the update is ready,
  // unless the user asked for the check (then the progress is shown too).
  function bar(state) {
    if (!state) return null;
    const version = state.version || '';
    switch (state.phase) {
      case 'available': return { kind: 'available', version };
      case 'downloading':
        return state.mode !== 'auto' || state.manual ? { kind: 'downloading', version, percent: Math.max(0, Math.min(100, Math.floor(state.percent || 0))) } : null;
      case 'downloaded': return { kind: 'ready', version };
      default: return null;
    }
  }

  // A session that is doing something the user would lose on a restart: an agent working or waiting for an answer.
  function isBusy(s) { return !!s && !s.exited && (s.status === 'active' || s.status === 'blocked'); }

  // "Restart to update" -> { action: 'confirm' | 'install' | 'none', busy }: ask first when sessions are busy.
  function restartPlan(state, sessions) {
    if (!state || state.phase !== 'downloaded') return { action: 'none', busy: 0 };
    const busy = (sessions || []).filter(isBusy).length;
    return { action: busy ? 'confirm' : 'install', busy };
  }

  const UpdatePolicy = { MODES, CHECK_DELAY_MS, CHECK_EVERY_MS, FEED, parseMode, shouldRun, testFeed, onAvailable, installOnQuit, bar, isBusy, restartPlan };
  if (typeof module === 'object' && module.exports) module.exports = UpdatePolicy;
  else root.UpdatePolicy = UpdatePolicy;
})(typeof window !== 'undefined' ? window : globalThis);
