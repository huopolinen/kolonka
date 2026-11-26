'use strict';
// Where Kolonka keeps its data, and whether this is a separate instance.
// KOLONKA_DATA pointing at another folder makes an isolated instance (own state, own single-instance
// lock). KOLONKA_DATA equal to the default folder is the normal instance: tabs inherit the variable,
// so Kolonka started from its own tab (or by the installer) must still find the running one.
const path = require('path');

function samePath(a, b, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const norm = (p) => {
    let r = P.resolve(p);
    if (r.length > 1) r = r.replace(/[\\/]+$/, '');
    return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// -> { dir, isolated }
function resolveDataDir(env, appData, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const def = P.join(appData, 'Kolonka');
  const custom = env.KOLONKA_DATA;
  if (!custom || samePath(custom, def, platform)) return { dir: def, isolated: false };
  return { dir: P.resolve(custom), isolated: true };
}

module.exports = { resolveDataDir, samePath };
