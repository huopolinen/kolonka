'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_SETTINGS, TEMPLATE, TEMPLATE_AUTO, stripJsonc, parseSettings, normalize, loadSettings } = require('../src/main/settings');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'settings.json');
}

test('comments and trailing commas are accepted, like the README example', () => {
  const text = `{
    "language": "ru",                       // en | ru | auto
    /* a block
       comment */
    "fontSize": 16,
    "shells": { "nu": { "label": "Nushell", "args": [], }, },
    "dictation": { "key": "ControlRight", },
  }`;
  assert.deepEqual(parseSettings(text), {
    language: 'ru', fontSize: 16,
    shells: { nu: { label: 'Nushell', args: [] } },
    dictation: { key: 'ControlRight' },
  });
});

test('comment markers and commas inside strings are kept', () => {
  const text = '{ "fontFamily": "a // b, /* c */", "path": "C:\\\\x\\\\", "q": "say \\"hi\\" // no", }';
  assert.deepEqual(parseSettings(text), { fontFamily: 'a // b, /* c */', path: 'C:\\x\\', q: 'say "hi" // no' });
  assert.equal(stripJsonc('["a,]", ]'), '["a,]" ]');
});

test('a BOM and an empty file are fine', () => {
  assert.deepEqual(parseSettings('\uFEFF{ "fontSize": 12 }'), { fontSize: 12 });
  assert.deepEqual(parseSettings('// nothing yet\n'), {});
});

test('broken JSON or a non-object is an error', () => {
  assert.throws(() => parseSettings('{ "fontSize": }'), SyntaxError);
  assert.throws(() => parseSettings('[1, 2]'), /must contain an object/);
  assert.throws(() => parseSettings('{ /* never closed '), /unterminated/);
});

test('the first-run template parses to an empty object: the defaults stay in code', () => {
  assert.deepEqual(parseSettings(TEMPLATE), {});
});

test('normalize: user values over the defaults, dictation merged one level deep', () => {
  const s = normalize({ fontSize: 18, dictation: { key: 'ControlRight' } });
  assert.equal(s.fontSize, 18);
  assert.equal(s.scrollback, DEFAULT_SETTINGS.scrollback);
  assert.equal(s.dictation.key, 'ControlRight');
  assert.equal(s.dictation.enabled, true, 'the other dictation defaults are kept');
  assert.equal(s.dictation.holdMs, DEFAULT_SETTINGS.dictation.holdMs);
  assert.equal(normalize({ dictation: 'nonsense' }).dictation.key, 'Space');
});

test('loadSettings on the first run writes the template, not a copy of the defaults', (t) => {
  const file = tmpFile(t);
  const r = loadSettings(file);
  assert.equal(r.error, null);
  assert.deepEqual(r.settings, normalize({}));
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(written, TEMPLATE);
  assert.doesNotMatch(written, /^\s*"language"/m, 'no option is set by the template');
});

test('loadSettings reports a broken file and keeps it untouched', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '{ "fontSize": 16 "language": "ru" }');
  const r = loadSettings(file);
  assert.match(r.error, /settings\.json/);
  assert.equal(r.settings.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "fontSize": 16 "language": "ru" }');
});

test('loadSettings reads a commented file', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '// mine\n{ "language": "auto", // follow Windows\n }');
  const r = loadSettings(file);
  assert.equal(r.error, null);
  assert.equal(r.settings.language, 'auto');
  assert.deepEqual(r.user, { language: 'auto' });
});

// What Kolonka 0.1.0 wrote on the first run: JSON.stringify(DEFAULT_SETTINGS, null, 2) of its main.js
// (language "auto" in e38f3d5, "en" from 402662b).
function dump010(language) {
  return JSON.stringify({
    language,
    defaultShell: 'bash',
    fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.15,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 10000,
    apiPort: 47811,
    notifications: true,
    closeOnExit: false,
    backgroundMaterial: 'mica',
    startDir: null,
    sidebarWidth: 264,
    dictation: { enabled: true, key: 'Space', holdMs: 300, engine: 'local', language: 'auto', device: '', autoEnter: false },
  }, null, 2);
}

test('migration: an untouched 0.1.0 dump with "en" becomes the template, with a backup', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, dump010('en'));
  const r = loadSettings(file);
  assert.equal(r.error, null);
  assert.equal(fs.readFileSync(file, 'utf8'), TEMPLATE);
  assert.equal(fs.readFileSync(file + '.bak-0.1.0', 'utf8'), dump010('en'));
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.deepEqual(r.user, {});
  assert.equal(r.settings.language, 'en');
  assert.match(r.log.join('\n'), /0\.1\.0/);
});

test('migration: an untouched 0.1.0 dump with "auto" keeps "language": "auto" explicitly', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, dump010('auto'));
  const r = loadSettings(file);
  assert.equal(fs.readFileSync(file, 'utf8'), TEMPLATE_AUTO);
  assert.deepEqual(parseSettings(fs.readFileSync(file, 'utf8')), { language: 'auto' });
  assert.equal(r.settings.language, 'auto');
  assert.ok(fs.existsSync(file + '.bak-0.1.0'));
  // the next start reads the template as it is
  const again = loadSettings(file);
  assert.equal(fs.readFileSync(file, 'utf8'), TEMPLATE_AUTO);
  assert.deepEqual(again.log, []);
});

test('migration: an edited dump or one with comments is left alone', (t) => {
  const edited = dump010('en').replace('"fontSize": 14', '"fontSize": 16');
  const commented = '// mine\n' + dump010('en');
  const extra = dump010('en').replace('"fontSize": 14', '"fontSize": 14,\n  "closeOnExit2": true');
  for (const text of [edited, commented, extra, dump010('ru')]) {
    const file = tmpFile(t);
    fs.writeFileSync(file, text);
    const r = loadSettings(file);
    assert.equal(r.error, null);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'unchanged');
    assert.equal(fs.existsSync(file + '.bak-0.1.0'), false, 'no backup');
  }
  const file = tmpFile(t);
  fs.writeFileSync(file, edited);
  assert.match(loadSettings(file).log.join('\n'), /left as it is/, 'a line in the log');
});
