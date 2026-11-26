'use strict';
// Incremental regex search over a session's output for `wait --pattern`.
// Escape sequences are stripped (also when one is cut between two chunks). Each new chunk is searched
// together with a short overlap before it; a match that starts further back (BEGIN[\s\S]*END over a
// long output) is found by a search over the whole kept text, run at most every FULL_SCAN_MS.
const { AnsiStream } = require('./ansi');

const KEEP = 200000;      // text kept for the search
const OVERLAP = 4096;     // the quick search starts this far before the new text
const FULL_SCAN_MS = 200; // the whole kept text is searched at most this often

class OutputMatcher {
  // skipLine: ignore everything up to the first line break — the echo of a command just typed.
  constructor(re, { skipLine = false, now = Date.now } = {}) {
    this.re = re;
    this.ansi = new AnsiStream();
    this.text = '';
    this.skipping = skipLine;
    this.now = now;
    this.lastFull = 0;
    this.dirty = false; // text arrived that the quick search did not cover in full
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
    this.text += add;
    if (this.text.length > KEEP) this.text = this.text.slice(-KEEP);
    let from = Math.max(0, this.text.length - add.length - OVERLAP);
    // start at a line boundary so that ^ in the pattern does not match in the middle of a line
    if (from > 0) {
      const nl = this.text.lastIndexOf('\n', from);
      if (nl >= 0 && from - nl <= 65536) from = nl + 1;
    }
    const m = this.re.exec(this.text.slice(from));
    if (m) return m;
    if (from > 0) {
      this.dirty = true;
      if (this.now() - this.lastFull >= FULL_SCAN_MS) return this.fullScan();
    }
    return null;
  }

  // ms until a pending full search is due, or -1 when there is none.
  fullScanDue() {
    if (!this.dirty) return -1;
    return Math.max(0, this.lastFull + FULL_SCAN_MS - this.now());
  }

  fullScan() {
    this.dirty = false;
    this.lastFull = this.now();
    return this.re.exec(this.text);
  }
}

module.exports = { OutputMatcher, FULL_SCAN_MS };
