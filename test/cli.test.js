'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse, unescape } = require('../bin/kolonka.js');

const CLI = path.join(__dirname, '..', 'bin', 'kolonka.js');

test('parse: positional arguments', () => {
  assert.deepEqual(parse(['ws', 'new', 'my', 'space']), { pos: ['ws', 'new', 'my', 'space'], opt: {}, rest: null });
});

test('parse: boolean flags', () => {
  const { pos, opt } = parse(['tree', '--json']);
  assert.deepEqual(pos, ['tree']);
  assert.deepEqual(opt, { json: true });
  assert.deepEqual(parse(['new', '--no-select', '--force']).opt, { 'no-select': true, force: true });
});

test('parse: options with a separate value and with =', () => {
  assert.deepEqual(parse(['new', '--name', 'build', '--shell', 'cmd']).opt, { name: 'build', shell: 'cmd' });
  assert.deepEqual(parse(['new', '--name=build', '--cwd=C:\\a=b']).opt, { name: 'build', cwd: 'C:\\a=b' });
});

test('parse: short options', () => {
  assert.deepEqual(parse(['text', '-t', 's3', '-n', '20']).opt, { target: 's3', lines: '20' });
  assert.deepEqual(parse(['-h']).opt, { help: true });
});

test('parse: everything after -- is the command', () => {
  const r = parse(['new', '--name', 'srv', '--', 'npm', 'run', '--watch']);
  assert.deepEqual(r.pos, ['new']);
  assert.deepEqual(r.opt, { name: 'srv' });
  assert.deepEqual(r.rest, ['npm', 'run', '--watch']);
});

test('unescape: escape sequences', () => {
  assert.equal(unescape('a\\nb'), 'a\nb');
  assert.equal(unescape('\\r\\t'), '\r\t');
  assert.equal(unescape('\\e[A'), '\x1b[A');
  assert.equal(unescape('\\x41\\x7f'), 'A\x7f');
  assert.equal(unescape('back\\\\slash'), 'back\\slash');
  assert.equal(unescape('plain text'), 'plain text');
});

test('requiring the CLI does not run a command', () => {
  // with main() running on require, "no-such-command" would exit with an error
  const script = `process.argv = [process.argv[0], 'kolonka.js', 'no-such-command']; require(${JSON.stringify(CLI)});`;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out, '');
});

test('running the CLI prints the help', () => {
  const out = execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' });
  assert.match(out, /^kolonka — control the Kolonka terminal/);
});
