'use strict';
/* global UpdatePolicy */
// The update bar at the bottom of the sidebar ("Update 0.3.0 available · Download" → progress →
// "Restart to update") and the "Check for updates" command. What is shown when is decided by
// UpdatePolicy.bar (src/shared/update-policy.js); the main process does the work (src/main/updater.js).
(function (root) {
  let api = null;
  let t = (k) => k;
  let toast = () => {};
  let current = '';
  let state = null;

  function init(initial, deps) {
    api = deps.api;
    t = deps.t;
    toast = deps.toast;
    current = deps.version || '';
    state = initial || null;
    api.onUpdate((s) => { state = s; render(); });
    render();
  }

  function button(label, run) {
    const b = document.createElement('button');
    b.className = 'ub-btn';
    b.textContent = label;
    b.addEventListener('click', run);
    return b;
  }

  function render() {
    const host = document.getElementById('update-bar');
    if (!host) return;
    const b = UpdatePolicy.bar(state);
    host.hidden = !b;
    host.dataset.kind = b ? b.kind : '';
    host.textContent = '';
    if (!b) return;
    const text = document.createElement('span');
    text.className = 'ub-text';
    host.appendChild(text);
    if (b.kind === 'available') {
      text.textContent = t('update.available', { version: b.version });
      host.appendChild(button(t('update.download'), download));
    } else if (b.kind === 'downloading') {
      text.textContent = t('update.downloading', { version: b.version, percent: b.percent });
      const bar = document.createElement('div');
      bar.className = 'ub-progress';
      const fill = document.createElement('div');
      fill.style.width = b.percent + '%';
      bar.appendChild(fill);
      host.appendChild(bar);
    } else {
      text.textContent = t('update.ready', { version: b.version });
      host.appendChild(button(t('update.restart'), restart));
    }
  }

  // a failed download is reported by the main process (a toast), whoever started it
  async function download() {
    await api.cmd('update.download');
  }

  async function restart() {
    const r = await api.cmd('update.install');
    if (r && r.error) toast(t('toast.error'), r.error);
  }

  function offReason(code) {
    if (code === 'dev') return t('update.offDev');
    if (code === 'env') return t('update.offEnv');
    if (code === 'isolated') return t('update.offIsolated');
    return t('update.offSetting');
  }

  // "Check for updates": the user asked, so every outcome is shown, a failure too
  async function check() {
    const r = await api.cmd('update.check');
    if (!r) return;
    if (r.off) toast(t('update.offTitle'), offReason(r.off));
    else if (r.error) toast(t('update.checkFailed'), r.error);
    else if (!r.available) toast(t('update.latest', { version: current }));
    else if (r.phase === 'downloaded') toast(t('update.ready', { version: r.version }), t('update.readyHint'));
    else if (r.phase === 'downloading') toast(t('update.downloadingToast', { version: r.version }));
    else toast(t('update.found', { version: r.version }), t('update.foundHint'));
  }

  const ready = () => !!state && state.phase === 'downloaded';

  root.UpdateBar = { init, check, restart, ready };
})(typeof window !== 'undefined' ? window : globalThis);
