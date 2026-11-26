'use strict';
// Incremental output matching for wait: escape sequences cut between chunks, the echo line,
// the recent-output log behind wait --since.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AnsiStream, stripAnsi } = require('../src/main/ansi');
const { OutputMatcher } = require('../src/main/match');
const { OutputLog } = require('../src/main/outlog');

const feed = (re, chunks, opts) => {
  const m = new OutputMatcher(re, opts);
  for (const c of chunks) { const r = m.push(c); if (r) return r[0]; }
  return null;
};

test('stripAnsi removes colours, OSC titles and control characters', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok\r\n'), 'red ok\n');
});

test('a CSI sequence cut between chunks does not leak into the text', () => {
  const a = new AnsiStream();
  assert.equal(a.push('abc\x1b[3'), 'abc');
  assert.equal(a.push('1mdone'), 'done');
  assert.equal(feed(/abcdone/, ['abc\x1b[3', '1mdone']), 'abcdone');
  assert.equal(feed(/\[31m/, ['abc\x1b[3', '1mdone']), null);
});

test('an OSC title cut between chunks does not leak into the text', () => {
  assert.equal(feed(/title|tle/, ['\x1b]0;tit', 'le\x07ready']), null);
  assert.equal(feed(/^ready/m, ['\x1b]0;tit', 'le\x07ready']), 'ready');
  // cut inside the ESC \ terminator
  assert.equal(feed(/^ok$/m, ['\x1b]9;9;C:\\x\x1b', '\\ok']), 'ok');
});

test('a lone ESC at the end is held for the next chunk', () => {
  const a = new AnsiStream();
  assert.equal(a.push('x\x1b'), 'x');
  assert.equal(a.push('[2Jy'), 'y');
});

test('a match spanning two chunks is found', () => {
  assert.equal(feed(/hello world/, ['hel', 'lo wo', 'rld']), 'hello world');
});

test('^ in the pattern still means the start of a line far into the output', () => {
  const long = 'x'.repeat(10000) + '\n';
  assert.equal(feed(/^done$/m, [long, 'undone\n']), null);
  assert.equal(feed(/^done$/m, [long, 'x\ndone\n']), 'done');
});

test('skipLine ignores the echoed command line', () => {
  assert.equal(feed(/kolonka-ok/, ['echo kolonka-ok\r\n'], { skipLine: true }), null);
  assert.equal(feed(/kolonka-ok/, ['echo kolon', 'ka-ok\r', '\nkolonka-ok\r\n'], { skipLine: true }), 'kolonka-ok');
  assert.equal(feed(/kolonka-ok/, ['echo kolonka-ok\r\n']), 'kolonka-ok', 'without skipLine the echo matches');
});

test('each chunk is searched with an overlap, not the whole buffer again', () => {
  let scanned = 0;
  const re = /never/;
  const exec = re.exec.bind(re);
  re.exec = (s) => { scanned += s.length; return exec(s); };
  const m = new OutputMatcher(re, { now: () => 1000 }); // a burst within one throttle interval
  for (let i = 0; i < 200; i++) m.push('y'.repeat(1000) + '\n');
  // a rescan of the growing buffer would read ~20 MB here
  assert.ok(scanned < 2e6, `scanned ${scanned} characters`);
});

test('a match longer than the quick-search window is still found (BEGIN[\\s\\S]*END)', () => {
  assert.equal(feed(/BEGIN[\s\S]*END/, ['BEGIN' + 'x'.repeat(5000), 'END']) !== null, true);
  assert.equal(feed(/^BEGIN$[\s\S]*^END$/m, ['BEGIN\n' + 'line\n'.repeat(3000), 'END\n']) !== null, true);
});

test('the full search is throttled and reports when it is due', () => {
  let now = 1000;
  const m = new OutputMatcher(/BEGIN[\s\S]*END/, { now: () => now });
  assert.equal(m.push('BEGIN' + 'x'.repeat(5000)), null);
  assert.equal(m.push('y'), null); // the quick window misses BEGIN: a full search runs now, nothing to find
  now = 1050;
  assert.equal(m.push('END'), null, 'too soon for another full search');
  assert.equal(m.fullScanDue(), 150);
  now = 1200;
  assert.equal(m.fullScan()[0].slice(-3), 'END');
  assert.equal(m.fullScanDue(), -1);
});

test('ESC ( B charset designations are stripped, also when cut', () => {
  assert.equal(new AnsiStream().push('a\x1b(Bb'), 'ab');
  const a = new AnsiStream();
  assert.equal(a.push('a\x1b('), 'a');
  assert.equal(a.push('Bb'), 'b');
});

test('OutputLog: output after a seq, and whether it is complete', () => {
  const log = new OutputLog(10);
  log.append('abc', 1);
  log.append('def', 2);
  assert.deepEqual(log.since(0), { data: 'abcdef', complete: true });
  assert.deepEqual(log.since(1), { data: 'def', complete: true });
  log.append('ghijk', 3); // 11 > 10: the first chunk goes
  assert.deepEqual(log.since(0), { data: 'defghijk', complete: false });
  assert.deepEqual(log.since(1), { data: 'defghijk', complete: true });
  log.append('0123456789ABC', 4); // bigger than the limit on its own: its tail is kept
  assert.deepEqual(log.since(3), { data: '3456789ABC', complete: false });
  assert.deepEqual(log.since(4), { data: '', complete: true });
});
