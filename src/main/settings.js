'use strict';
// settings.json: JSON with // and /* */ comments and trailing commas, like the example in README.
// Only what the user sets is stored in the file; the defaults live here, so changing a default
// in a new version reaches everyone who has not set that option.
const fs = require('fs');

const DEFAULT_SETTINGS = {
  language: 'en',
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
  dictation: {
    enabled: true,
    key: 'Space',
    holdMs: 300,
    engine: 'local',
    language: 'auto',
    device: '',
    autoEnter: false,
  },
};

// Written on the first run instead of a copy of the defaults.
const TEMPLATE = `// Kolonka settings. Restart Kolonka to apply.
// Only the options you set here override the defaults; comments and trailing commas are fine.
// All options: https://github.com/huopolinen/kolonka#configuration
{
  // "language": "auto",          // en | ru | auto (follow Windows)
  // "defaultShell": "pwsh",      // bash | pwsh | powershell | cmd | your own key
  // "fontSize": 14,
  // "dictation": { "key": "Space", "language": "auto" },
}
`;

// The language line of the template, uncommented: a migrated 0.1.0 file that had "auto" keeps it.
const TEMPLATE_AUTO = TEMPLATE.replace('  // "language": "auto",          //', '  "language": "auto",             //');

// Kolonka 0.1.0 wrote a copy of all its defaults into settings.json on the first run (language "auto"
// in the first build, "en" after). Such a file pins every default, so a file that is exactly one of
// these dumps is replaced by the template once; a file the user edited is left as it is.
const DUMP_0_1_0 = {
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
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// 'en' / 'auto' when `user` (parsed from `text`) is an untouched 0.1.0 dump, otherwise null.
function dumpOf010(text, user) {
  if (!user || (user.language !== 'en' && user.language !== 'auto')) return null;
  if (stripJsonc(text) !== text) return null; // comments or trailing commas: written by a person
  const { language, ...rest } = user;
  return deepEqual(rest, DUMP_0_1_0) ? language : null;
}

// Every option of the 0.1.0 dump is present: probably a dump the user then edited.
function looksLikeEditedDump(user) {
  return !!user && Object.keys(DUMP_0_1_0).every((k) => k in user) && 'language' in user;
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Remove comments and trailing commas, leaving strings alone.
function stripJsonc(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('unterminated /* comment');
      out += ' ';
      i = end + 2;
    } else if (c === ',') {
      // a comma followed only by whitespace / comments and then } or ] is a trailing one
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
        if (src[j] === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
        break;
      }
      if (src[j] !== '}' && src[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseSettings(text) {
  const body = stripJsonc(String(text).replace(/^﻿/, ''));
  if (!body.trim()) return {};
  const v = JSON.parse(body);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('settings.json must contain an object { … }');
  return v;
}

// The user's settings on top of the defaults; nested objects (dictation) are merged one level deep.
function normalize(user) {
  const out = Object.assign({}, DEFAULT_SETTINGS, user);
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const d = DEFAULT_SETTINGS[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const u = user && user[k];
      out[k] = Object.assign({}, d, u && typeof u === 'object' && !Array.isArray(u) ? u : {});
    }
  }
  return out;
}

// -> { settings, user, error, log }. A broken file is left as it is: the defaults are used and the error is reported.
function loadSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { settings: normalize({}), user: {}, error: `${file}: ${e.message}`, log: [] };
    try { fs.writeFileSync(file, TEMPLATE); } catch { /* read-only folder: defaults */ }
    return { settings: normalize({}), user: {}, error: null, log: [] };
  }
  let user;
  try { user = parseSettings(text); } catch (e) {
    return { settings: normalize({}), user: {}, error: `${file}: ${e.message}`, log: [] };
  }
  const log = [];
  const lang = dumpOf010(text, user);
  if (lang) {
    const backup = file + '.bak-0.1.0';
    try {
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
      writeAtomic(file, lang === 'auto' ? TEMPLATE_AUTO : TEMPLATE);
      user = lang === 'auto' ? { language: 'auto' } : {};
      log.push(`settings.json from Kolonka 0.1.0 (a copy of the old defaults) replaced by the short template; the old file is ${backup}`);
    } catch (e) {
      log.push(`settings.json from Kolonka 0.1.0 could not be replaced by the template: ${e.message}`);
    }
  } else if (looksLikeEditedDump(user)) {
    log.push('settings.json lists every option, like the copy of the defaults Kolonka 0.1.0 wrote, but it was edited: left as it is. Options set there override new defaults; delete the lines you do not need.');
  }
  return { settings: normalize(user), user, error: null, log };
}

module.exports = { DEFAULT_SETTINGS, TEMPLATE, TEMPLATE_AUTO, DUMP_0_1_0, stripJsonc, parseSettings, normalize, loadSettings };
