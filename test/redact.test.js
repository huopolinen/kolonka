'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/main/redact');

const ME = { home: 'C:\\Users\\alice', user: 'alice', host: 'WORKSTATION7' };

test('the home directory is replaced in all its spellings', () => {
  assert.equal(redact('at C:\\Users\\alice\\app\\x.js:1', ME), 'at ~\\app\\x.js:1');
  assert.equal(redact('cwd C:/Users/alice/work', ME), 'cwd ~/work');
  assert.equal(redact('"C:\\\\Users\\\\alice\\\\x"', ME), '"~\\\\x"');
  assert.equal(redact('bash: /c/Users/alice/bin', ME), 'bash: ~/bin');
});

test('user and host names are replaced, case-insensitively', () => {
  assert.equal(redact('user Alice on workstation7', ME), 'user <user> on <host>');
});

test('short user and host names are left alone', () => {
  assert.equal(redact('al on pc', { home: 'C:\\Users\\al', user: 'al', host: 'pc' }), 'al on pc');
});

test('tokens are redacted', () => {
  assert.equal(redact('{"token":"abcdefghijklmnop"}', {}), '{"token":"<redacted>"}');
  assert.equal(redact('token=abcdefghijklmnop', {}), 'token=<redacted>');
  assert.equal(redact('key ghp_0123456789abcdef', {}), 'key <redacted>');
  assert.equal(redact('key sk_0123456789abcdef', {}), 'key <redacted>');
});

test('empty input gives an empty string', () => {
  assert.equal(redact(undefined, ME), '');
  assert.equal(redact(null, ME), '');
});
