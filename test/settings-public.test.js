'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicSettings, settingsSecrets } = require('../src/main/settings-public');

const SETTINGS = {
  fontSize: 14,
  fontFamily: 'Cascadia Mono',
  dictation: {
    engine: 'openai',
    openai: { apiKey: 'sk-proj-SECRETSECRETSECRET', model: 'gpt-4o-mini-transcribe' },
    groq: { apiKey: '', model: 'whisper-large-v3-turbo' },
  },
  shells: { nu: { label: 'Nushell', file: 'nu.exe', args: [], env: { GITHUB_TOKEN: 'ghp_SECRETSECRETSECRET' } } },
};

test('the window never gets an API key, only whether one is set', () => {
  const pub = publicSettings(SETTINGS);
  assert.equal(pub.dictation.openai.apiKey, '');
  assert.equal(pub.dictation.openai.apiKeySet, true);
  assert.equal(pub.dictation.groq.apiKeySet, false);
  assert.equal(pub.dictation.openai.model, 'gpt-4o-mini-transcribe');
  assert.doesNotMatch(JSON.stringify(pub), /SECRET/);
});

test('user shells keep only their label', () => {
  assert.deepEqual(publicSettings(SETTINGS).shells, { nu: { label: 'Nushell' } });
});

test('the visual settings the window uses are passed through', () => {
  const pub = publicSettings(SETTINGS);
  assert.equal(pub.fontSize, 14);
  assert.equal(pub.fontFamily, 'Cascadia Mono');
});

test('the original settings object is not modified', () => {
  publicSettings(SETTINGS);
  assert.equal(SETTINGS.dictation.openai.apiKey, 'sk-proj-SECRETSECRETSECRET');
});

test('settingsSecrets lists every non-empty secret value', () => {
  assert.deepEqual(settingsSecrets({ dictation: { openai: { apiKey: 'a1' }, groq: { apiKey: '' } }, x: { token: 't1' } }), ['a1', 't1']);
});
