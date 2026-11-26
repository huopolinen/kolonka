'use strict';
// control.json holds the API token. Under %APPDATA% it inherits the profile's ACL (the user, SYSTEM and
// Administrators only). KOLONKA_DATA can point anywhere, e.g. a shared folder that every local user can
// read; there the file gets an explicit ACL with inheritance removed and full control for the current user.
const path = require('path');
const { execFile } = require('child_process');

function isInside(dir, root) {
  if (!dir || !root) return false;
  const a = path.resolve(dir).toLowerCase();
  const b = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '');
  return a === b || a.startsWith(b + path.sep);
}

// Whether a data directory needs its own ACL on the token file.
function needsPrivateAcl(dataDir, home) {
  return !isInside(dataDir, home);
}

// icacls arguments: drop inherited entries, grant only the current user. The user is DOMAIN\name so
// a local account and a domain account with the same name are not confused.
function icaclsArgs(file, { user, domain } = {}) {
  if (!user) throw new Error('unknown user name');
  const who = domain ? `${domain}\\${user}` : user;
  return [file, '/inheritance:r', '/grant:r', `${who}:F`];
}

// Restrict the file to the current user. Resolves to true on success, false on other platforms;
// rejects if icacls fails, so the caller can log it.
function restrictToUser(file, { env = process.env, platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(false);
  const args = icaclsArgs(file, { user: env.USERNAME, domain: env.USERDOMAIN });
  const exe = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  return new Promise((resolve, reject) => {
    run(exe, args, { windowsHide: true, timeout: 10000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`icacls failed: ${String(stderr || err.message).trim()}`)); else resolve(true);
    });
  });
}

module.exports = { needsPrivateAcl, icaclsArgs, restrictToUser, isInside };
