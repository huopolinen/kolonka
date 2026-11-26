'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { startApi, tokenMatches } = require('../src/main/api');

test('tokenMatches compares exactly', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc124', 'abc123'), false);
  assert.equal(tokenMatches('abc1234', 'abc123'), false);
  assert.equal(tokenMatches('', 'abc123'), false);
  assert.equal(tokenMatches(undefined, 'abc123'), false);
  assert.equal(tokenMatches('abc', ''), false);
});

// A real API server on a free port with a minimal model.
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-api-'));
  const model = Object.assign(new EventEmitter(), { tree: () => ({ active: null, workspaces: [] }), shells: {} });
  const api = await startApi({ model, dataDir: dir, port: 0, hooks: { version: 'test' } });
  t.after(() => new Promise((r) => { api.server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }));
  return api;
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('the token works in the Authorization header', async (t) => {
  const api = await serve(t);
  const r = await get(`${api.url}/api/tree`, { authorization: 'Bearer ' + api.token });
  assert.equal(r.status, 200);
});

test('a token in the query string is not accepted', async (t) => {
  const api = await serve(t);
  const r = await get(`${api.url}/api/tree?token=${encodeURIComponent(api.token)}`);
  assert.equal(r.status, 401);
  const sse = await get(`${api.url}/api/events?token=${encodeURIComponent(api.token)}`);
  assert.equal(sse.status, 401);
});

test('a wrong token is 401', async (t) => {
  const api = await serve(t);
  assert.equal((await get(`${api.url}/api/tree`, { authorization: 'Bearer ' + api.token + 'x' })).status, 401);
  assert.equal((await get(`${api.url}/api/tree`)).status, 401);
});
