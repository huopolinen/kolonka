'use strict';
// The last N characters of a session's output, each chunk tagged with its sequence number.
// `wait --since SEQ` reads what arrived after SEQ from here, so output that came between
// `type` and `wait` is not lost.

class OutputLog {
  constructor(limit = 256 * 1024) {
    this.limit = limit;
    this.chunks = []; // [{ seq, data }], oldest first
    this.size = 0;
    this.lost = 0; // output with seq <= lost has been dropped, fully or in part
  }

  append(data, seq) {
    if (!data) return;
    this.chunks.push({ seq, data });
    this.size += data.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const old = this.chunks.shift();
      this.size -= old.data.length;
      this.lost = Math.max(this.lost, old.seq);
    }
    if (this.size > this.limit) {
      // a single chunk bigger than the limit: keep its tail
      const only = this.chunks[0];
      only.data = only.data.slice(-this.limit);
      this.size = only.data.length;
      this.lost = Math.max(this.lost, only.seq);
    }
  }

  // Output with seq > `seq`. `complete` is false when some of it has already been dropped.
  since(seq) {
    const parts = [];
    for (const c of this.chunks) if (c.seq > seq) parts.push(c.data);
    return { data: parts.join(''), complete: seq >= this.lost };
  }
}

module.exports = { OutputLog };
