'use strict';
// Incremental regex search over a session's output for `wait --pattern`.
// Escape sequences are stripped (also when one is cut between two chunks), and each new chunk is
// searched together with a short overlap before it instead of rescanning the whole buffer.
const { AnsiStream } = require('./ansi');

const KEEP = 200000;  // text kept for the search
const OVERLAP = 4096; // a match may start this far before the new text

class OutputMatcher {
  // skipLine: ignore everything up to the first line break — the echo of a command just typed.
  constructor(re, { skipLine = false } = {}) {
    this.re = re;
    this.ansi = new AnsiStream();
    this.text = '';
    this.skipping = skipLine;
  }

  // Feed raw output; returns the match or null.
  push(raw) {
    let add = this.ansi.push(raw);
    if (this.skipping) {
      const nl = add.indexOf('\n');
      if (nl < 0) return null;
      this.skipping = false;
      add = add.slice(nl + 1);
    }
    if (!add) return null;
    const before = this.text.length;
    this.text += add;
    let from = Math.max(0, before - OVERLAP);
    // start at a line boundary so that ^ in the pattern does not match in the middle of a line
    if (from > 0) {
      const nl = this.text.lastIndexOf('\n', from);
      if (nl >= 0 && from - nl <= 65536) from = nl + 1;
    }
    const m = this.re.exec(this.text.slice(from));
    if (this.text.length > KEEP) this.text = this.text.slice(-KEEP);
    return m;
  }
}

module.exports = { OutputMatcher };
