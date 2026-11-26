'use strict';
// The working directory a session reports comes from terminal output (OSC 7 / OSC 9;9): any program can
// print one. Needs node-pty and @xterm/headless (installed in CI); skipped where they are missing.
const test = require('node:test');
const assert = require('node:assert/strict');

let Session = null;
let why = '';
try { ({ Session } = require('../src/main/session')); } catch (e) { why = 'node-pty / @xterm/headless not installed: ' + e.message.split('\n')[0]; }

// A session object without a pty: only what _setCwd and the OSC handlers use.
function bare(cwd) {
  const s = Object.create(Session.prototype);
  require('events').EventEmitter.call(s);
  s.cwd = cwd;
  s.metas = 0;
  s.on('meta', () => s.metas++);
  return s;
}

const LOCAL = process.platform === 'win32' ? 'C:\\Users\\x\\repo' : '/home/x/repo';
const START = process.platform === 'win32' ? 'C:\\Users\\x' : '/home/x';

test('_setCwd accepts a local path', { skip: !Session && why }, () => {
  const s = bare(START);
  s._setCwd(LOCAL);
  assert.equal(s.cwd, LOCAL);
  assert.equal(s.metas, 1);
});

test('_setCwd ignores UNC, device and network paths from terminal output', { skip: !Session && why }, () => {
  const s = bare(START);
  for (const p of ['\\\\attacker\\share', '//attacker/share', '\\\\?\\UNC\\attacker\\share', 'file://attacker/share', '', null]) s._setCwd(p);
  assert.equal(s.cwd, START);
  assert.equal(s.metas, 0);
});
