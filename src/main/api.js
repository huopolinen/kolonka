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
  route('POST', '/api/sessions/:s/type', ({ p, body }) => {
    let text = String(body.text ?? '');
    if (body.enter) text += '\r';
    text = text.replace(/\r?\n/g, '\r');
    model.type(p.s, text);
    return { ok: true, bytes: text.length };
  });
  route('POST', '/api/sessions/:s/keys', ({ p, body }) => {
    const keys = Array.isArray(body.keys) ? body.keys : [body.keys];
    model.type(p.s, keys.map(keyToSeq).join(''));
    return { ok: true };
  });
  route('GET', '/api/sessions/:s/text', async ({ p, q }) => {
    const s = model.resolveSession(p.s);
    const text = await s.text({ lines: q.lines ? Number(q.lines) : undefined, all: q.all === '1' || q.all === 'true' });
    return { id: s.id, text, cursor: s.cursor(), cols: s.cols, rows: s.rows };
  });
  route('POST', '/api/sessions/:s/wait', ({ p, body }) => model.wait(p.s, body));
  route('POST', '/api/notify', ({ body }) => {
    let s = null;
    if (body.session) s = model.resolveSession(body.session);
    hooks.notify({ title: body.title, text: String(body.text || ''), session: s && s.id });
    return { ok: true };
  });
  route('POST', '/api/screenshot', ({ body }) => hooks.screenshot(body.path));
  route('POST', '/api/window', ({ body }) => hooks.window(body.action || 'focus') || { ok: true });
  route('GET', '/api/window', () => hooks.window('bounds'));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization || '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
    if (given !== token) return send(res, 401, { error: 'token required (Authorization: Bearer …), see control.json' });
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
      const result = await r.fn({ p, q, body, req });
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
    req.on('close', () => { clearInterval(ping); sse.delete(client); });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const code = e instanceof ApiError ? e.code : (e instanceof SyntaxError ? 400 : 500);
      send(res, code, { error: e.message });
    });
  });

  const controlFile = path.join(dataDir, 'control.json');
  return new Promise((resolve) => {
    const listen = (p) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && p !== 0) listen(0);
        else console.error('api error', e);
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        const info = { url: `http://127.0.0.1:${actual}`, port: actual, token, pid: process.pid };
        fs.writeFileSync(controlFile, JSON.stringify(info, null, 2));
        resolve(Object.assign({ server, controlFile }, info));
      });
    };
    listen(port);
  });
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

module.exports = { startApi, keyToSeq };
