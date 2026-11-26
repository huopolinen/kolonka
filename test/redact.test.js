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

test('Bearer tokens are redacted, with any whitespace', () => {
  assert.equal(redact('authorization: Bearer abc.def-ghi_jkl', {}), 'authorization: Bearer <redacted>');
  assert.equal(redact('Authorization: Bearer   Zm9vYmFyYmF6cXV4+/=', {}), 'Authorization: Bearer   <redacted>');
});

test('well-known API key formats are redacted', () => {
  const keys = [
    'sk-0123456789abcdefABCDEF',
    'sk-proj-AbCdEf0123456789_xyz-QRS',
    'sk-ant-api03-AbCdEf0123456789xyz_QRS-tuv',
    'gsk_0123456789abcdefABCDEF0123',
    'ghp_0123456789abcdefABCDEF0123456789abcd',
    'gho_0123456789abcdefABCDEF',
    'ghu_0123456789abcdefABCDEF',
    'ghs_0123456789abcdefABCDEF',
    'ghr_0123456789abcdefABCDEF',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'xoxb-1234567890-abcdefghij',
    'xoxp-1234567890-abcdefghij',
    'xoxa-1234567890-abcdefghij',
  ];
  for (const k of keys) assert.equal(redact(`key=${k} end`, {}), 'key=<redacted> end', k);
});

test('a login is replaced only as a whole word', () => {
  const me = { home: 'C:\\Users\\dev', user: 'dev', host: 'box' };
  assert.equal(redact('device dev developer /dev/null', me), 'device <user> developer /<user>/null');
  assert.equal(redact('DEV logged in', me), '<user> logged in');
});

test('a host name is replaced only as a whole word', () => {
  assert.equal(redact('on build7 not rebuild7s', { host: 'build7' }), 'on <host> not rebuild7s');
});

test('non-Latin user names are replaced as whole words', () => {
  assert.equal(redact('Иван и Иванов', { user: 'Иван' }), '<user> и Иванов');
});

test('known secrets are removed literally, whatever their format', () => {
  const secrets = ['Xy7-not-a-known-format-42', 'q9W2e8R7t6Y5u4I3'];
  assert.equal(redact('k=Xy7-not-a-known-format-42 and "q9W2e8R7t6Y5u4I3"', { secrets }), 'k=<redacted> and "<redacted>"');
});

test('short or empty known secrets are ignored', () => {
  assert.equal(redact('a b c', { secrets: ['', 'a', null, undefined] }), 'a b c');
});
