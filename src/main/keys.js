'use strict';
// Key names accepted by POST /api/sessions/:s/keys and `kolonka keys`, mapped to terminal input sequences.
const { ApiError } = require('./errors');

const KEYS = {
  enter: '\r', return: '\r', tab: '\t', 'shift+tab': '\x1b[Z', esc: '\x1b', escape: '\x1b',
  backspace: '\x7f', space: ' ', delete: '\x1b[3~', del: '\x1b[3~', insert: '\x1b[2~',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pgup: '\x1b[5~', pagedown: '\x1b[6~', pgdn: '\x1b[6~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~',
  f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};

function keyToSeq(k) {
  const key = String(k).toLowerCase().trim();
  if (KEYS[key] !== undefined) return KEYS[key];
  let m = /^(?:ctrl|c)[+-]([a-z@\[\\\]^_])$/.exec(key);
  if (m) return String.fromCharCode(m[1].toUpperCase().charCodeAt(0) & 0x1f);
  m = /^(?:alt|meta|m)[+-](.+)$/.exec(key);
  if (m) return '\x1b' + (KEYS[m[1]] !== undefined ? KEYS[m[1]] : m[1]);
  if (key.length === 1) return k;
  throw new ApiError(400, `unknown key: ${k}`);
}

module.exports = { KEYS, keyToSeq };
