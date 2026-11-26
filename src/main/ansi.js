'use strict';
// Strip terminal escape sequences and control characters from pty output.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

module.exports = { stripAnsi };
