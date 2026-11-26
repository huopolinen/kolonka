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

Sessions
  new [--ws W] [--name N] [--cwd DIR] [--shell bash|pwsh|powershell|cmd]
      [--after T] [--no-select] [-- COMMAND...]   create, prints the id
  select [-t T]                     switch to it
  rename NAME [-t T]                rename
  mv --ws W [-t T] [--index N]      move to a workspace / position
  close [-t T]                      close
  restart [-t T]                    restart the shell
  info [-t T]                       session details as JSON
  status [idle|active|blocked|done] [-t T] [--quiet]   status glyph (no argument: print it)

Input and output
  type TEXT [-t T] [--enter]        type text (\\n → Enter)
  run CMD... [-t T]                 same as type "CMD" --enter
  keys KEY... [-t T]                keys: enter tab esc up down ctrl+c alt+x f5 …
  text [-t T] [--lines N] [--all]   read the screen (--all includes scrollback)
  wait [-t T] (--pattern RE [--screen] | --idle MS | --exit) [--timeout MS]
                                    wait for a regex in new output / on screen, silence, or exit
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

function parse(argv) {
  const pos = []; const opt = {}; let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      const flag = ['json', 'all', 'enter', 'no-select', 'force', 'quiet', 'screen', 'exit', 'help'].includes(k);
      if (v !== undefined) opt[k] = v;
      else if (flag) opt[k] = true;
      else opt[k] = argv[++i];
    } else if (a === '-t') opt.target = argv[++i];
    else if (a === '-n') opt.lines = argv[++i];
    else if (a === '-h') opt.help = true;
    else pos.push(a);
  }
  return { pos, opt, rest };
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

const hooks = require('./hooks');

// ---------- main ----------
async function main() {
  const { pos, opt, rest } = parse(process.argv.slice(2));
  const cmd = pos.shift();
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
      if (rest && rest.length) body.command = rest.join(' ');
      else if (pos.length) body.command = pos.join(' ');
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
    case 'type': {
      const text = unescape(pos.join(' '));
      await request('POST', `/api/sessions/${tgt(opt)}/type`, { text, enter: !!opt.enter }); return;
    }
    case 'run': {
      const text = (rest && rest.length ? rest : pos).join(' ');
      await request('POST', `/api/sessions/${tgt(opt)}/type`, { text, enter: true }); return;
    }
    case 'keys': await request('POST', `/api/sessions/${tgt(opt)}/keys`, { keys: pos }); return;
    case 'text': {
      const q = new URLSearchParams();
      if (opt.lines) q.set('lines', opt.lines);
      if (opt.all) q.set('all', '1');
      const r = await request('GET', `/api/sessions/${tgt(opt)}/text?${q}`);
      if (opt.json) return json(r);
      return process.stdout.write(r.text + '\n');
    }
    case 'wait': {
      const body = { timeout: Number(opt.timeout || 30000) };
      if (opt.pattern) body.pattern = opt.pattern;
      if (opt.screen) body.screen = true;
      if (opt.idle) body.idle = Number(opt.idle);
      if (opt.exit) body.exit = true;
      if (!body.pattern && !body.idle && !body.exit) die('pass --pattern, --idle or --exit');
      try {
        const r = await request('POST', `/api/sessions/${tgt(opt)}/wait`, body);
        if (r.matched !== undefined) process.stdout.write(r.matched + '\n');
        if (r.exitCode !== undefined) process.stdout.write(String(r.exitCode) + '\n');
      } catch (e) { die(e.message, e.status === 408 ? 2 : 1); }
      return;
    }
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

module.exports = { parse, unescape };

if (require.main === module) main().catch((e) => die(e.message));
