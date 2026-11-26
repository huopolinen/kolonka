#!/usr/bin/env node
'use strict';
// kolonka — CLI for the control API of a running Kolonka. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.KOLONKA_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Kolonka');
const CONTROL = path.join(DATA_DIR, 'control.json');

const HELP = `kolonka — control the Kolonka terminal from the command line

Target (-t/--target): an id (s3), a name, "workspace/name", a 1-based position or "current".
Default: the session the command runs in ($KOLONKA_SESSION), otherwise the active one.

Tree
  tree [--json]                     workspaces and sessions
  ls [--ws W] [--json]              list sessions

Workspaces
  ws new NAME                       create, prints the id
  ws rename W NAME                  rename
  ws rm W [--force]                 delete (--force closes the sessions inside)
  ws fold W | ws unfold W           collapse / expand

Options go before the text for new, type and run: everything from the first word of the
command on is taken as is (kolonka run grep -h x types "grep -h x"). -- also starts it.
run and type refuse a command that contains their own options (-t --enter --wait --timeout
--json --skip-echo) to catch a misplaced option; pass such a command after --:
  kolonka run -t s3 -- docker build . -t img

Sessions
  new [--ws W] [--name N] [--cwd DIR] [--shell bash|pwsh|powershell|cmd]
      [--after T] [--no-select] [COMMAND...]      create, prints the id; Restart runs COMMAND again
  select [-t T]                     switch to it
  rename NAME [-t T]                rename
  mv --ws W [-t T] [--index N]      move to a workspace / position
  close [-t T]                      close
  restart [-t T]                    restart the shell
  info [-t T]                       session details as JSON
  status [idle|active|blocked|done] [-t T] [--quiet]   status glyph (no argument: print it)

Input and output
  type [-t T] [--enter] TEXT...     type text (\\n → Enter)
  run [-t T] [--wait RE] CMD...     same as type --enter "CMD"; --wait RE waits for RE in the
                                    output of this command (its echo line is skipped)
  keys [-t T] KEY...                keys: enter tab esc up down ctrl+c alt+x f5 …
      type, run and keys take --wait RE [--timeout MS], or --json to print {"seq": N}
  text [-t T] [--lines N] [--all]   read the screen (--all includes scrollback)
  wait [-t T] (--pattern RE [--screen] | --idle MS | --exit) [--timeout MS]
       [--since SEQ] [--skip-echo]  wait for a regex in new output / on screen, silence, or exit;
                                    --since SEQ also searches output after SEQ (from type --json),
                                    --skip-echo ignores its first line, --timeout 0 = no limit
  stream [-t T]                     raw session output (SSE) to stdout
  events                            event stream (created, status, exited…)

Other
  notify TEXT [--title T] [-t T]    notification (click jumps to the session)
  focus                             bring the window to front
  screenshot [FILE.png]             save a PNG of the window
  api                               API address and token (for curl)
  hooks print|status|install|uninstall   Claude Code status hooks (~/.claude/settings.json)
`;

function die(msg, code = 1) { process.stderr.write('kolonka: ' + msg + '\n'); process.exit(code); }

// Commands whose arguments are a command line or text to type: once their first argument starts,
// everything after it is taken as is, so `kolonka run grep -h x` types `grep -h x`.
const RAW_COMMANDS = ['run', 'type', 'new'];

// Options of run / type that, found among the words of the command, were most likely meant for Kolonka.
const RUN_OPTIONS = ['-t', '--target', '--enter', '--wait', '--timeout', '--json', '--skip-echo'];

// dashdash: the command was started with an explicit --
function parse(argv) {
  const pos = []; const opt = {}; let rest = null; let dashdash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); dashdash = true; break; }
    const isOption = a.startsWith('--') || a === '-t' || a === '-n' || a === '-h';
    if (pos.length === 1 && RAW_COMMANDS.includes(pos[0]) && !isOption) { rest = argv.slice(i); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      const flag = ['json', 'all', 'enter', 'no-select', 'force', 'quiet', 'screen', 'exit', 'help', 'skip-echo'].includes(k);
      if (v !== undefined) opt[k] = v;
      else if (flag) opt[k] = true;
      else opt[k] = argv[++i];
    } else if (a === '-t') opt.target = argv[++i];
    else if (a === '-n') opt.lines = argv[++i];
    else if (a === '-h') opt.help = true;
    else pos.push(a);
  }
  return { pos, opt, rest, dashdash };
}

// The first word of a run / type command that is a Kolonka option (`run npm test -t s3`), or null.
// With an explicit -- everything is the command's own (`run -- docker build . -t img`).
function strayOption(cmd, rest, dashdash) {
  if (dashdash || !rest || (cmd !== 'run' && cmd !== 'type')) return null;
  return rest.find((w) => RUN_OPTIONS.includes(w.split('=')[0])) || null;
}

function control() {
  try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { return null; }
}

function request(method, url, body, { quiet } = {}) {
  const c = control();
  if (!c) { if (quiet) process.exit(0); die('Kolonka is not running (no ' + CONTROL + ')'); }
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(c.url + url, {
      method,
      headers: Object.assign({ authorization: 'Bearer ' + c.token }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let j; try { j = JSON.parse(raw); } catch { j = { raw }; }
        if (res.statusCode >= 400) { const e = new Error(j.error || ('HTTP ' + res.statusCode)); e.status = res.statusCode; reject(e); } else resolve(j);
      });
    });
    req.on('error', (e) => {
      if (quiet) process.exit(0);
      reject(new Error(e.code === 'ECONNREFUSED' ? 'Kolonka is not responding (closed?)' : e.message));
    });
    if (data) req.write(data);
    req.end();
  });
}

function sse(url) {
  const c = control();
  if (!c) die('Kolonka is not running');
  http.get(c.url + url, { headers: { authorization: 'Bearer ' + c.token } }, (res) => {
    if (res.statusCode !== 200) { res.resume(); die('HTTP ' + res.statusCode); }
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const dataLine = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!dataLine) continue;
        if (url.endsWith('/stream')) process.stdout.write(JSON.parse(dataLine));
        else process.stdout.write(dataLine + '\n');
      }
    });
    res.on('end', () => process.exit(0));
  }).on('error', (e) => die(e.message));
}

const enc = encodeURIComponent;
const tgt = (opt) => enc(opt.target || process.env.KOLONKA_SESSION || 'current');

function unescape(s) {
  return s.replace(/\\(n|r|t|e|\\|x[0-9a-fA-F]{2})/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', e: '\x1b', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c.slice(1), 16))));
}

function printTree(t) {
  const glyph = { idle: '○', active: '◐', blocked: '●', done: '✓' };
  for (const w of t.workspaces) {
    process.stdout.write(`${w.name}  [${w.id}]${w.collapsed ? '  (collapsed)' : ''}\n`);
    for (const s of w.sessions) {
      const mark = s.id === t.active ? '›' : ' ';
      const g = s.exited ? '×' : glyph[s.status];
      process.stdout.write(`  ${mark} ${g} ${s.id.padEnd(5)} ${s.name.padEnd(20)} ${s.cwd}${s.unread ? '  •' : ''}\n`);
    }
  }
}

function toNumber(name, v) {
  const n = Number(v);
  if (v === true || v === undefined || String(v).trim() === '' || !Number.isFinite(n) || n < 0) die(`${name} needs a number, got "${v}"`);
  return n;
}

// wait / run --wait: prints what matched (or the exit code); exit code 2 = timeout.
async function waitCmd(opt, { target, pattern, since, skipEcho }) {
  // --timeout 0 = no time limit
  const body = { timeout: opt.timeout !== undefined ? toNumber('--timeout', opt.timeout) : 30000 };
  if (pattern !== undefined) {
    if (pattern === true || pattern === '') die('--pattern / --wait needs a regular expression');
    body.pattern = pattern;
  }
  if (opt.screen) body.screen = true;
  if (opt.idle !== undefined) body.idle = toNumber('--idle', opt.idle);
  if (opt.exit) body.exit = true;
  if (since !== undefined) body.since = since;
  if (skipEcho) body.skipEcho = true;
  if (!body.pattern && !body.idle && !body.exit) die('pass --pattern, --idle or --exit');
  try {
    const r = await request('POST', `/api/sessions/${target ? enc(target) : tgt(opt)}/wait`, body);
    if (r.matched !== undefined) process.stdout.write(r.matched + '\n');
    if (r.exitCode !== undefined) process.stdout.write(String(r.exitCode) + '\n');
  } catch (e) { die(e.message, e.status === 408 ? 2 : 1); }
}

const hooks = require('./hooks');

// ---------- main ----------
async function main() {
  const { pos, opt, rest, dashdash } = parse(process.argv.slice(2));
  const cmd = pos.shift();
  const stray = strayOption(cmd, rest, dashdash);
  if (stray) die(`"${stray}" comes after the command; put options before the command, or use -- to pass it to the command: kolonka ${cmd} [options] -- ${rest.join(' ')}`);
  const words = pos.concat(rest || []); // positional arguments, including those after --
  if (!cmd || opt.help || cmd === 'help') { process.stdout.write(HELP); return; }
  const json = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

  switch (cmd) {
    case 'tree': {
      const t = await request('GET', '/api/tree');
      return opt.json ? json(t) : printTree(t);
    }
    case 'ls': {
      const list = await request('GET', '/api/sessions' + (opt.ws ? '?workspace=' + enc(opt.ws) : ''));
      if (opt.json) return json(list);
      for (const s of list) process.stdout.write(`${s.id}\t${s.workspace}\t${s.status}\t${s.name}\t${s.cwd}\n`);
      return;
    }
    case 'ws': case 'workspace': {
      const sub = pos.shift();
      if (sub === 'new') { const r = await request('POST', '/api/workspaces', { name: pos.join(' ') }); return process.stdout.write(r.id + '\n'); }
      if (sub === 'rename') { const w = pos.shift(); await request('PATCH', '/api/workspaces/' + enc(w), { name: pos.join(' ') }); return; }
      if (sub === 'rm' || sub === 'delete') { await request('DELETE', '/api/workspaces/' + enc(pos[0]) + (opt.force ? '?force=1' : '')); return; }
      if (sub === 'fold' || sub === 'unfold') { await request('PATCH', '/api/workspaces/' + enc(pos[0] || 'current'), { collapsed: sub === 'fold' }); return; }
      if (sub === 'ls' || !sub) { const t = await request('GET', '/api/workspaces'); for (const w of t) process.stdout.write(`${w.id}\t${w.name}\t${w.sessions.length}\n`); return; }
      return die('unknown ws subcommand ' + sub);
    }
    case 'new': {
      const body = { workspace: opt.ws, name: opt.name, cwd: opt.cwd ? path.resolve(opt.cwd) : undefined, shell: opt.shell, select: !opt['no-select'], after: opt.after };
      if (words.length) body.command = words.join(' ');
      const r = await request('POST', '/api/sessions', body);
      return process.stdout.write(r.id + '\n');
    }
    case 'select': case 'focus-session': await request('POST', `/api/sessions/${tgt(opt)}/select`); return;
    case 'rename': await request('PATCH', `/api/sessions/${tgt(opt)}`, { name: pos.join(' ') }); return;
    case 'mv': case 'move': {
      const body = {};
      if (opt.ws) body.workspace = opt.ws;
      if (opt.index !== undefined) body.index = Number(opt.index);
      await request('PATCH', `/api/sessions/${tgt(opt)}`, body); return;
    }
    case 'close': case 'rm': await request('DELETE', `/api/sessions/${tgt(opt)}`); return;
    case 'restart': await request('POST', `/api/sessions/${tgt(opt)}/restart`); return;
    case 'info': return json(await request('GET', `/api/sessions/${tgt(opt)}`));
    case 'status': {
      if (opt.quiet && !opt.target && !process.env.KOLONKA_SESSION) return; // hook outside Kolonka: stay silent
      if (!pos[0]) { const s = await request('GET', `/api/sessions/${tgt(opt)}`); return process.stdout.write(s.status + '\n'); }
      try { await request('PATCH', `/api/sessions/${tgt(opt)}`, { status: pos[0] }, { quiet: opt.quiet }); } catch (e) { if (!opt.quiet) throw e; }
      return;
    }
    case 'type': case 'run': case 'keys': {
      const r = cmd === 'keys'
        ? await request('POST', `/api/sessions/${tgt(opt)}/keys`, { keys: words })
        : await request('POST', `/api/sessions/${tgt(opt)}/type`, cmd === 'run'
          ? { text: words.join(' '), enter: true }
          : { text: unescape(words.join(' ')), enter: !!opt.enter });
      if (opt.wait !== undefined) {
        // wait for output caused by this input only: since = the seq right before it.
        // `run` skips the echo of the command line, so a pattern that also occurs in the command still works.
        return waitCmd(opt, { target: r.session, since: r.seq, pattern: opt.wait, skipEcho: cmd === 'run' || !!opt['skip-echo'] });
      }
      if (opt.json) json(r);
      return;
    }
    case 'text': {
      const q = new URLSearchParams();
      if (opt.lines) q.set('lines', opt.lines);
      if (opt.all) q.set('all', '1');
      const r = await request('GET', `/api/sessions/${tgt(opt)}/text?${q}`);
      if (opt.json) return json(r);
      return process.stdout.write(r.text + '\n');
    }
    case 'wait': return waitCmd(opt, {
      pattern: opt.pattern,
      since: opt.since !== undefined ? toNumber('--since', opt.since) : undefined,
      skipEcho: !!opt['skip-echo'],
    });
    case 'stream': return sse(`/api/sessions/${tgt(opt)}/stream`);
    case 'events': return sse('/api/events');
    case 'notify': await request('POST', '/api/notify', { text: pos.join(' '), title: opt.title, session: opt.target || process.env.KOLONKA_SESSION }); return;
    case 'focus': await request('POST', '/api/window', { action: 'focus' }); return;
    case 'screenshot': {
      const file = path.resolve(pos[0] || 'kolonka.png');
      const r = await request('POST', '/api/screenshot', { path: file });
      return process.stdout.write(r.path + '\n');
    }
    case 'sidebar': await request('POST', '/api/window', { action: 'toggle-sidebar' }); return;
    case 'api': {
      const c = control();
      if (!c) die('Kolonka is not running');
      if (opt.json) return json(c);
      process.stdout.write(`url:   ${c.url}\ntoken: ${c.token}\nfile:  ${CONTROL}\n\ncurl -H "Authorization: Bearer ${c.token}" ${c.url}/api/tree\n`);
      return;
    }
    case 'hooks': {
      const sub = pos[0] || 'print';
      if (sub === 'print') return json({ hooks: hooks.plan() });
      if (sub === 'status') return process.stdout.write((hooks.installed() ? 'installed' : 'not installed') + ' — ' + hooks.settingsFile() + '\n');
      if (sub === 'install' || sub === 'uninstall') {
        const f = hooks.install(sub === 'uninstall');
        return process.stdout.write((sub === 'uninstall' ? 'Hooks removed from ' : 'Hooks installed into ') + f + ' (backup: settings.json.kolonka-backup)\n');
      }
      return die('hooks print|status|install|uninstall');
    }
    default: die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

module.exports = { parse, unescape, strayOption };

if (require.main === module) main().catch((e) => die(e.message));
