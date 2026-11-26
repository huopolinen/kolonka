'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I18N = require('../src/shared/i18n');
const { STATUSES } = require('../src/main/model');

const SRC = path.join(__dirname, '..', 'src');
const { en, ru } = I18N.D;

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('en and ru have the same keys', () => {
  const missingInRu = Object.keys(en).filter((k) => !(k in ru));
  const missingInEn = Object.keys(ru).filter((k) => !(k in en));
  assert.deepEqual(missingInRu, [], 'keys missing in ru');
  assert.deepEqual(missingInEn, [], 'keys missing in en');
});

test('en and ru use the same placeholders', () => {
  const diff = Object.keys(en)
    .filter((k) => k in ru && placeholders(en[k]).join() !== placeholders(ru[k]).join())
    .map((k) => `${k}: en {${placeholders(en[k])}} ru {${placeholders(ru[k])}}`);
  assert.deepEqual(diff, []);
});

test('every key used in the source is defined', () => {
  const used = new Set();
  for (const f of sourceFiles(SRC)) {
    const text = fs.readFileSync(f, 'utf8');
    // t('key') and this.t('key'), but not set('x') or split('x')
    for (const m of text.matchAll(/(?<![\w$])t\(\s*'([^'\\]+)'\s*[,)]/g)) used.add(m[1]);
    // the key is picked by a ternary: t(cond ? 'a' : 'b')
    for (const m of text.matchAll(/(?<![\w$])t\([^'()]*\?\s*'([^'\\]+)'\s*:\s*'([^'\\]+)'/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of text.matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)) used.add(m[1]);
  }
  // built from a prefix at runtime: t('status.' + st)
  for (const st of STATUSES) used.add('status.' + st);

  assert.ok(used.size > 50, `expected to find many keys, found ${used.size}`);
  const missing = [...used].filter((k) => !(k in en)).sort();
  assert.deepEqual(missing, []);
});

test('make() fills placeholders and falls back to English, then to the key', () => {
  const t = I18N.make('ru');
  assert.equal(I18N.make('en')('chip.exited', { code: 3 }), 'exited · 3');
  assert.notEqual(t('btn.cancel'), en['btn.cancel']);
  assert.equal(I18N.make('xx')('btn.cancel'), en['btn.cancel']);
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('pickLang uses the setting, then the system language', () => {
  assert.equal(I18N.pickLang('ru', ['en-US']), 'ru');
  assert.equal(I18N.pickLang('auto', ['ru-RU', 'en-US']), 'ru');
  assert.equal(I18N.pickLang(undefined, ['de-DE']), 'en');
  assert.equal(I18N.pickLang('auto', []), 'en');
});
