'use strict';
// Remove personal data (home path, user and host names, tokens) from text before it goes into an issue report.
// Pure function: the caller passes the machine's home, user and host, and the secrets it knows about
// (the API token, dictation API keys), so it can be tested without Electron.

// Well-known token formats, replaced wherever they appear.
const TOKEN_PATTERNS = [
  /\bsk-(?:proj-|ant-[A-Za-z0-9]{2,8}-)?[A-Za-z0-9_\-]{16,}/g, // OpenAI sk-, sk-proj-, Anthropic sk-ant-api03-
  /\b(?:sk|gsk)_[A-Za-z0-9_\-]{10,}/g,                        // Groq gsk_, other sk_ keys
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,                            // GitHub classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,                          // GitHub fine-grained tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                          // Slack tokens
];

function redact(text, { home, user, host, secrets } = {}) {
  let out = String(text ?? '');
  // known secrets first, literally, before any other rule could split them
  const known = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 8).sort((a, b) => b.length - a.length);
  for (const s of known) out = out.split(s).join('<redacted>');
  const variants = home ? [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'), '/' + home[0].toLowerCase() + home.slice(2).replace(/\\/g, '/')] : [];
  for (const v of variants) if (v && v.length > 3) out = out.split(v).join('~');
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '<redacted>');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9_\-.~+/=]{8,}/gi, '$1<redacted>');
  out = out.replace(/(token["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-.~+/=]{12,}/gi, '$1<redacted>');
  // names as whole words only, so a login like "dev" does not turn "device" into "<user>ice"
  if (user && user.length > 2) out = out.replace(word(user), '<user>');
  if (host && host.length > 2) out = out.replace(word(host), '<host>');
  return out;
}

// A case-insensitive whole-word match that also works for non-Latin names.
function word(s) { return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(s)}(?![\\p{L}\\p{N}_])`, 'giu'); }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { redact };
