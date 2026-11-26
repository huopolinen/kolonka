'use strict';
// Strip terminal escape sequences and control characters from pty output.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

// The start of an escape sequence that has not been terminated yet.
const PARTIAL_RE = /^\x1b(?:\[[0-?]*[ -/]*|[\]PX^_][^\x07\x1b]*)?$/;
// An OSC / DCS / APC string whose terminator (ESC \) was cut right after the ESC.
const PARTIAL_ST_RE = /^\x1b[\]PX^_][^\x07\x1b]*\x1b$/;
const MAX_HOLD = 4096;

// stripAnsi for a stream: a sequence cut between two chunks is held back until the next one,
// so its tail does not leak into the text as if it were output.
class AnsiStream {
  constructor() { this.hold = ''; }

  push(chunk) {
    let s = this.hold + chunk;
    this.hold = '';
    const last = s.lastIndexOf('\x1b');
    if (last >= 0) {
      const prev = last > 0 ? s.lastIndexOf('\x1b', last - 1) : -1;
      let from = -1;
      if (prev >= 0 && PARTIAL_ST_RE.test(s.slice(prev))) from = prev;
      else if (PARTIAL_RE.test(s.slice(last))) from = last;
      if (from >= 0 && s.length - from <= MAX_HOLD) { this.hold = s.slice(from); s = s.slice(0, from); }
    }
    return stripAnsi(s);
  }
}

module.exports = { stripAnsi, AnsiStream };
