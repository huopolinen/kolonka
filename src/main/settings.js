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

// -> { settings, user, error }. A broken file is left as it is: the defaults are used and the error is reported.
function loadSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { settings: normalize({}), user: {}, error: `${file}: ${e.message}` };
    try { fs.writeFileSync(file, TEMPLATE); } catch { /* read-only folder: defaults */ }
    return { settings: normalize({}), user: {}, error: null };
  }
  try {
    const user = parseSettings(text);
    return { settings: normalize(user), user, error: null };
  } catch (e) {
    return { settings: normalize({}), user: {}, error: `${file}: ${e.message}` };
  }
}

module.exports = { DEFAULT_SETTINGS, TEMPLATE, stripJsonc, parseSettings, normalize, loadSettings };
