'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse, unescape, strayOption } = require('../bin/kolonka.js');

const CLI = path.join(__dirname, '..', 'bin', 'kolonka.js');

test('parse: positional arguments', () => {
  assert.deepEqual(parse(['ws', 'new', 'my', 'space']), { pos: ['ws', 'new', 'my', 'space'], opt: {}, rest: null, dashdash: false });
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

test('parse: run / type / new take everything after the first word of the command as is', () => {
  assert.deepEqual(parse(['run', 'grep', '-h', 'x']), { pos: ['run'], opt: {}, rest: ['grep', '-h', 'x'], dashdash: false });
  assert.deepEqual(parse(['run', '-t', 's3', '--wait', 'ok', 'npm', 'test', '--', '--watch']),
    { pos: ['run'], opt: { target: 's3', wait: 'ok' }, rest: ['npm', 'test', '--', '--watch'], dashdash: false });
  assert.deepEqual(parse(['type', '--enter', 'ls', '--all', '-t', 'x']), { pos: ['type'], opt: { enter: true }, rest: ['ls', '--all', '-t', 'x'], dashdash: false });
  assert.deepEqual(parse(['new', '--name', 'srv', 'npm', 'run', 'dev', '--json']), { pos: ['new'], opt: { name: 'srv' }, rest: ['npm', 'run', 'dev', '--json'], dashdash: false });
});

test('parse: other commands still read options after positional arguments', () => {
  assert.deepEqual(parse(['ws', 'rm', 'dev', '--force']), { pos: ['ws', 'rm', 'dev'], opt: { force: true }, rest: null, dashdash: false });
  assert.deepEqual(parse(['keys', 'ctrl+c', '-t', 's2']).opt, { target: 's2' });
});

test('running `run grep -h x` does not print the help', () => {
  // no Kolonka is running in the test, so the command fails to connect, but it must not be -h
  let out = '';
  try {
    out = execFileSync(process.execPath, [CLI, 'run', 'grep', '-h', 'x'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { KOLONKA_DATA: path.join(__dirname, 'no-such-dir') }),
    });
  } catch (e) { out = String(e.stdout || ''); }
  assert.doesNotMatch(out, /control the Kolonka terminal/);
});

test('strayOption: a Kolonka option among the words of run / type is caught, unless after --', () => {
  const check = (argv) => { const r = parse(argv); return strayOption(r.pos[0], r.rest, r.dashdash); };
  assert.equal(check(['run', 'npm', 'test', '-t', 's3']), '-t');
  assert.equal(check(['run', 'docker', 'build', '.', '-t', 'img']), '-t');
  assert.equal(check(['type', 'hello', '--enter']), '--enter');
  assert.equal(check(['run', 'make', '--timeout=5']), '--timeout=5');
  assert.equal(check(['run', '-t', 's3', '--', 'docker', 'build', '.', '-t', 'img']), null);
  assert.equal(check(['run', 'grep', '-h', 'x']), null);
  assert.equal(check(['run', 'ls', '--all']), null, 'not a run option');
  assert.equal(check(['new', '--name', 'x', 'top', '-t']), null, 'new is not checked');
});

test('a misplaced option makes run fail with exit code 1 and a hint, before connecting', () => {
  let err = null;
  try {
    execFileSync(process.execPath, [CLI, 'run', 'npm', 'test', '-t', 's3'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { KOLONKA_DATA: path.join(__dirname, 'no-such-dir') }),
    });
  } catch (e) { err = e; }
  assert.ok(err, 'the command failed');
  assert.equal(err.status, 1);
  assert.match(String(err.stderr), /put options before the command, or use --/);
  assert.doesNotMatch(String(err.stderr), /not running/);
});
