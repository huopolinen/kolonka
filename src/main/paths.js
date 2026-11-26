'use strict';
// Which directories Kolonka may touch. A working directory can come from terminal output (OSC 7 / OSC 9;9),
// so any program that prints an escape sequence can set it. A UNC path (\\host\share) makes Windows connect
// to that host and send the user's NTLM credentials on the first fs.stat, so only local drive paths pass.
const fs = require('fs');
const path = require('path');

// True for an absolute path on a drive letter (C:\x, d:/y). Rejects UNC (\\host, //host), device paths
// (\\?\, \\.\), URLs and other schemes, relative paths, and anything with control characters.
// On other platforms (tests, dev) any absolute POSIX path that is not a network-style //host path passes.
function isSafeLocalPath(p, platform = process.platform) {
  if (typeof p !== 'string' || !p || p.length > 32767) return false;
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) && !/^[A-Za-z]:[\\/]{2}/.test(p);
  return p.startsWith('/') && !p.startsWith('//');
}

// An existing local directory. The path is checked before fs.stat ever sees it.
function dirOk(p, platform) {
  if (!isSafeLocalPath(p, platform)) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The directory "Open folder" may open for a session: its own cwd, only if it is a local directory.
// The renderer passes a session id, never a path, so it cannot make the shell open an arbitrary file.
function openableDir(model, id, platform) {
  const s = model && model.sessions && model.sessions.get(String(id));
  if (!s || !dirOk(s.cwd, platform)) return null;
  return path.resolve(s.cwd);
}

module.exports = { isSafeLocalPath, dirOk, openableDir };
