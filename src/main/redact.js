'use strict';
// Remove personal data (home path, user and host names, tokens) from text before it goes into an issue report.
// Pure function: the caller passes the machine's home, user and host, so it can be tested without Electron.
function redact(text, { home, user, host } = {}) {
  let out = String(text || '');
  const variants = home ? [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'), '/' + home[0].toLowerCase() + home.slice(2).replace(/\\/g, '/')] : [];
  for (const v of variants) if (v && v.length > 3) out = out.split(v).join('~');
  if (user && user.length > 2) out = out.replace(new RegExp(escapeRe(user), 'gi'), '<user>');
  if (host && host.length > 2) out = out.replace(new RegExp(escapeRe(host), 'gi'), '<host>');
  out = out.replace(/(Bearer|token["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-.]{12,}/gi, '$1<redacted>');
  out = out.replace(/(sk|gsk|gho|ghp)_[A-Za-z0-9_\-]{10,}/g, '<redacted>');
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { redact };
