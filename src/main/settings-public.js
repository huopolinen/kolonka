'use strict';
// The copy of settings.json the window gets. Secrets (dictation API keys and anything named like one)
// stay in the main process: the renderer only learns whether a key is set.
const SECRET_KEY = /(api[-_]?key|token|secret|password)$/i;

function publicSettings(settings) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && typeof x === 'string') { out[k] = ''; out[k + 'Set'] = !!x; } else out[k] = walk(x);
    }
    return out;
  };
  const out = walk(settings || {});
  // user-defined shells may carry tokens in their environment; the window only needs the labels
  if (out.shells && typeof out.shells === 'object') {
    for (const k of Object.keys(out.shells)) {
      const sh = out.shells[k];
      if (sh && typeof sh === 'object') out.shells[k] = { label: sh.label };
    }
  }
  return out;
}

// Every secret value in settings, for scrubbing problem reports.
function settingsSecrets(settings) {
  const found = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && typeof x === 'string' && x) found.push(x); else walk(x);
    }
  };
  walk(settings || {});
  return found;
}

module.exports = { publicSettings, settingsSecrets };
