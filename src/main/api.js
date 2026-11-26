'use strict';
// Local HTTP control API (127.0.0.1 + bearer token). See README.md.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ApiError } = require('./errors');
const { keyToSeq } = require('./keys');

function startApi({ model, dataDir, port, hooks }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const sse = new Set();

  model.on('event', (ev) => {
    const line = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of sse) if (c.kind === 'events') c.res.write(line);
    // a closed session's output stream ends (a restarted one keeps streaming under the same id)
    if (ev.type === 'session.closed') {
      for (const c of [...sse]) if (c.kind === 'stream' && c.id === ev.session) { sse.delete(c); c.close(); }
    }
  });
  model.on('data', (id, data) => {
    for (const c of sse) if (c.kind === 'stream' && c.id === id) c.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });

  const routes = [];
  const route = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, fn });
  };

  const sinfo = (s) => s.info();

  route('GET', '/api', () => ({ name: 'kolonka', version: hooks.version, pid: process.pid }));
  route('GET', '/api/tree', () => model.tree());
  route('GET', '/api/shells', () => Object.fromEntries(Object.entries(model.shells).map(([k, v]) => [k, { label: v.label, file: v.file }])));

  route('GET', '/api/workspaces', () => model.tree().workspaces);
  // one workspace by any target (id, name, 1-based position, current), in the shape of /api/tree
  route('GET', '/api/workspaces/:w', ({ p }) => {
    const ws = model.resolveWorkspace(p.w);
    return model.tree().workspaces.find((w) => w.id === ws.id);
  });
  route('POST', '/api/workspaces', ({ body }) => {
    const ws = model.createWorkspace(body);
    return { id: ws.id, name: ws.name };
  });
  route('PATCH', '/api/workspaces/:w', ({ p, body }) => {
    const ws = model.updateWorkspace(p.w, body);
    return { id: ws.id, name: ws.name, collapsed: ws.collapsed };
  });
  route('DELETE', '/api/workspaces/:w', ({ p, q }) => model.deleteWorkspace(p.w, { force: q.force === '1' || q.force === 'true' }));

  route('GET', '/api/sessions', ({ q }) => {
    let list = model.orderedSessionIds().map((id) => model.sessions.get(id).info());
    if (q.workspace) { const ws = model.resolveWorkspace(q.workspace); list = list.filter((s) => s.workspace === ws.id); }
    return list;
  });
  route('POST', '/api/sessions', ({ body }) => sinfo(model.createSession(body)));
  route('GET', '/api/sessions/:s', ({ p }) => sinfo(model.resolveSession(p.s)));
  route('PATCH', '/api/sessions/:s', ({ p, body }) => sinfo(model.updateSession(p.s, body)));
  route('DELETE', '/api/sessions/:s', ({ p }) => model.closeSession(p.s));
  route('POST', '/api/sessions/:s/select', ({ p }) => { const s = model.selectSession(p.s); hooks.focus(); return sinfo(s); });
  route('POST', '/api/sessions/:s/restart', ({ p }) => sinfo(model.restartSession(p.s)));
  // seq: the last output seq before the input; pass it to wait as `since` to see all the output it caused
  route('POST', '/api/sessions/:s/type', ({ p, body }) => {
    let text = String(body.text ?? '');
    if (body.enter) text += '\r';
    text = text.replace(/\r?\n/g, '\r');
    const s = model.type(p.s, text);
    return { ok: true, bytes: text.length, session: s.id, seq: s.seq };
  });
  route('POST', '/api/sessions/:s/keys', ({ p, body }) => {
    const keys = Array.isArray(body.keys) ? body.keys : [body.keys];
    const s = model.type(p.s, keys.map(keyToSeq).join(''));
    return { ok: true, session: s.id, seq: s.seq };
  });
  route('GET', '/api/sessions/:s/text', async ({ p, q }) => {
    const s = model.resolveSession(p.s);
    const text = await s.text({ lines: q.lines ? Number(q.lines) : undefined, all: q.all === '1' || q.all === 'true' });
    return { id: s.id, text, cursor: s.cursor(), cols: s.cols, rows: s.rows };
  });
  route('POST', '/api/sessions/:s/wait', ({ p, body, res }) => {
    // the client gave up (Ctrl+C, its own timeout): drop the wait and its listeners
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    return model.wait(p.s, Object.assign({}, body, { signal: ac.signal }));
  });
  route('POST', '/api/notify', ({ body }) => {
    let s = null;
    if (body.session) s = model.resolveSession(body.session);
    hooks.notify({ title: body.title, text: String(body.text || ''), session: s && s.id });
    return { ok: true };
  });
  // remote control: hosts that may open tabs (settings.json allowHosts + "Always for this host")
  route('GET', '/api/remote', () => {
    const cfg = model._remoteCfg();
    return { enabled: cfg.enabled !== false, allowHosts: cfg.allowHosts || [], remembered: model.remoteAllowed.slice() };
  });
  // `kolonka remote connect`: trust the server (as "Always for this host") and open a tab to it; the
  // CLI has changed the ssh config itself
  route('POST', '/api/remote/connect', ({ body }) => model.connectServer({
    destination: body.destination, options: body.options, cmd: body.cmd, name: body.name, workspace: body.workspace,
    open: body.open !== false, select: body.select !== false,
  }));
  route('DELETE', '/api/remote/hosts/:h', ({ p }) => {
    if (!model.forgetRemoteHost(p.h)) throw new ApiError(404, `not a remembered host: ${p.h}`);
    return { ok: true };
  });
  route('POST', '/api/screenshot', ({ body }) => hooks.screenshot(body.path));
  route('POST', '/api/window', ({ body }) => hooks.window(body.action || 'focus') || { ok: true });
  route('GET', '/api/window', () => hooks.window('bounds'));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // header only: a token in the query string ends up in logs and shell history
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(given, token)) return send(res, 401, { error: 'token required (Authorization: Bearer …), see control.json' });
    if (req.headers.origin) return send(res, 403, { error: 'browser requests are not allowed' });

    const q = Object.fromEntries(url.searchParams);
    // SSE
    if (req.method === 'GET' && url.pathname === '/api/events') return openSse(req, res, { kind: 'events' });
    let m = /^\/api\/sessions\/([^/]+)\/stream\/?$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const s = model.resolveSession(decodeURIComponent(m[1]));
      return openSse(req, res, { kind: 'stream', id: s.id });
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const mm = r.re.exec(url.pathname);
      if (!mm) continue;
      const p = {};
      r.keys.forEach((k, i) => { p[k] = decodeURIComponent(mm[i + 1]); });
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const result = await r.fn({ p, q, body, req, res });
      return send(res, 200, result);
    }
    send(res, 404, { error: `no such endpoint: ${req.method} ${url.pathname}` });
  }

  function openSse(req, res, c) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': kolonka\n\n');
    const client = Object.assign({ res }, c);
    sse.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    client.close = () => { clearInterval(ping); res.end(); };
    req.on('close', () => { clearInterval(ping); sse.delete(client); });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      // URIError: a malformed %-escape in the path
      const code = e instanceof ApiError ? e.code : (e instanceof SyntaxError || e instanceof URIError ? 400 : 500);
      send(res, code, { error: e.message });
    });
  });

  // Any failure on the configured port (busy, forbidden, invalid) falls back to a random one;
  // if that fails too the promise rejects, so the caller is never left waiting.
  const controlFile = path.join(dataDir, 'control.json');
  return new Promise((resolve, reject) => {
    const listen = (p) => {
      const onError = (e) => {
        server.off('listening', onListening);
        if (p !== 0) { console.error(`api: port ${p} failed (${e.code || e.message}), using a random port`); listen(0); } else reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', (e) => console.error('api error', e));
        try {
          const actual = server.address().port;
          const info = { url: `http://127.0.0.1:${actual}`, port: actual, token, pid: process.pid };
          fs.writeFileSync(controlFile, JSON.stringify(info, null, 2));
          resolve(Object.assign({ server, controlFile }, info));
        } catch (e) { server.close(); reject(e); }
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try { server.listen(p, '127.0.0.1'); } catch (e) { onError(e); }
    };
    const want = Number(port);
    listen(Number.isInteger(want) && want >= 0 && want < 65536 ? want : 0);
  });
}

// Constant-time comparison. Both sides are hashed first, so the lengths match and the length of the
// real token does not leak either.
function tokenMatches(given, token) {
  if (typeof given !== 'string' || !given || !token) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new ApiError(400, 'invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj === undefined ? { ok: true } : obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

module.exports = { startApi, keyToSeq, tokenMatches };
