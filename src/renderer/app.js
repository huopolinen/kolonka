'use strict';
/* global Terminal, FitAddon, WebglAddon, SearchAddon, WebLinksAddon, Unicode11Addon, ICONS, I18N, Dictation, UiLogic */

const api = window.kolonka;
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const THEME = {
  background: '#0f1218', foreground: '#d4d9e3', cursor: '#8fb3ff', cursorAccent: '#0f1218',
  selectionBackground: 'rgba(122,162,255,0.30)', selectionInactiveBackground: 'rgba(122,162,255,0.16)',
  black: '#1c212b', red: '#ef6f7a', green: '#97d38a', yellow: '#e8c27a', blue: '#7aa2ff', magenta: '#c39bf5', cyan: '#6fd1e0', white: '#c7cdd8',
  brightBlack: '#5a6374', brightRed: '#ff8d96', brightGreen: '#b2e6a5', brightYellow: '#f3d495', brightBlue: '#9dbbff', brightMagenta: '#d7b8ff', brightCyan: '#95e3ee', brightWhite: '#eef1f6',
  scrollbarSliderBackground: 'rgba(255,255,255,0.08)', scrollbarSliderHoverBackground: 'rgba(255,255,255,0.16)', scrollbarSliderActiveBackground: 'rgba(255,255,255,0.22)',
};
let t = I18N.make('en');
const statusLabel = (st) => t('status.' + st);

let S = { state: { workspaces: [], active: null }, settings: {}, shells: {}, defaultShell: 'bash', api: null };
const terms = new Map();   // id -> { term, fit, search, host, ready, queue, webgl, exited }
let fontSize = 14;
let renameLock = false;
let pendingRender = false;
let dragInfo = null;

// =============== init ===============
(async function init() {
  S = Object.assign(S, await api.init());
  t = I18N.make(S.lang);
  window.t = t;
  applyStaticI18n();
  // a zoom / sidebar width picked in the window is kept until settings.json sets another value
  fontSize = UiLogic.storedSize(localStorage, 'fontSize', S.settings.fontSize, 14) || S.settings.fontSize || 14;
  if (!S.settings.backgroundMaterial || S.settings.backgroundMaterial === 'none') document.body.classList.add('no-material');
  const w = UiLogic.storedSize(localStorage, 'sidebarW', S.settings.sidebarWidth, 264) || S.settings.sidebarWidth;
  if (w) document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  if (localStorage.getItem('sidebarHidden') === '1') document.body.classList.add('sidebar-hidden');

  api.onState((st) => { S.state = st; render(); });
  api.onData((id, data, seq) => {
    const x = terms.get(id);
    if (!x) return;
    if (!x.ready) x.queue.push([data, seq]);
    else x.term.write(data);
  });
  api.onExit((id, code) => markExited(terms.get(id), code));
  api.onClosed((id) => disposeTerm(id));
  api.onToast(showToast);
  api.onWindowFocus((f) => document.body.classList.toggle('focused', f));
  api.onWindowAction((a) => { if (a === 'toggle-sidebar') toggleSidebar(); });

  Dictation.init(S.dictation, { toast: (title, text) => showToast({ title, text }), t });
  if (S.settingsError) showToast({ title: t('settings.errorTitle'), text: S.settingsError, sticky: true });
  window.addEventListener('error', (e) => api.log('error', `renderer: ${e.message} @ ${e.filename}:${e.lineno}`, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => api.log('error', 'renderer unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  wireChrome();
  render();
})().catch((e) => { try { api.log("error", "renderer init failed: " + (e && e.stack || e)); } catch { /* ignore */ } console.error(e); });

// =============== terminals ===============
function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const host = el('div', 'term-host');
  host.dataset.id = id;
  $('#terms').appendChild(host);
  const sess = findSession(id);
  const term = new Terminal({
    // the pty's size, not xterm's 80×24: a background tab must render the output the way it was laid out
    cols: (sess && sess.cols) || 120, rows: (sess && sess.rows) || 32,
    fontFamily: S.settings.fontFamily, fontSize, lineHeight: S.settings.lineHeight || 1.15,
    cursorStyle: S.settings.cursorStyle || 'bar', cursorBlink: S.settings.cursorBlink !== false, cursorWidth: 2,
    scrollback: S.settings.scrollback || 10000, theme: THEME, allowProposedApi: true, allowTransparency: false,
    macOptionIsMeta: true, rightClickSelectsWord: false, drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1, smoothScrollDuration: 0, fastScrollModifier: 'shift',
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => {
    if (ev.ctrlKey) api.cmd('open.external', { url: uri });
    else toastHint(t('term.ctrlClick'));
  }));
  term.open(host);
  term.onData((d) => {
    const x = terms.get(id);
    if (x && x.exited) { if (d === '\r') restartSession(id); return; }
    api.input(id, d);
  });
  term.onBinary((d) => api.input(id, d));
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));
  term.attachCustomKeyEventHandler((e) => {
    const handled = handleTermKey(e, id);
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    return !handled;
  });
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) { copySelection(id); term.clearSelection(); } else paste(id);
  });
  search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
    $('#find-count').textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : (findQuery() ? '0/0' : '');
  });
  const rec = { term, fit, search, host, ready: false, queue: [], webgl: null, exited: false };
  terms.set(id, rec);
  api.snapshot(id).then((snap) => {
    if (terms.get(id) !== rec) return;
    if (snap) term.write(snap.data);
    for (const [d, seq] of rec.queue) if (!snap || seq > snap.seq) term.write(d);
    rec.queue = [];
    rec.ready = true;
  });
  // already exited (the shell failed to start, or the window was reloaded): Enter restarts it
  if (sess && sess.exited) markExited(rec, sess.exitCode);
  return rec;
}

function markExited(x, code) {
  if (!x || x.exited) return;
  x.exited = true;
  const note = `\r\n\x1b[2m${t('term.exited', { code })}\x1b[0m\r\n`;
  if (x.ready) x.term.write(note);
  else x.queue.push([note, Infinity]); // after the snapshot
}

function disposeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  try { t.webgl && t.webgl.dispose(); } catch { /* ignore */ }
  t.term.dispose();
  t.host.remove();
  terms.delete(id);
  // a restarted session gets a new terminal under the same id: it must be fitted and focused again
  if (shownId === id) shownId = null;
}

let shownId = null;
function showActive() {
  const id = S.state.active;
  const sess = findSession(id);
  $('#empty').hidden = !!sess;
  for (const [tid, t] of terms) {
    const vis = tid === id;
    t.host.classList.toggle('visible', vis);
    if (!vis && t.webgl) { try { t.webgl.dispose(); } catch { /* ignore */ } t.webgl = null; }
  }
  if (!sess) { shownId = null; return; }
  const t = ensureTerm(id);
  if (!t.webgl) {
    try {
      const w = new WebglAddon.WebglAddon();
      w.onContextLoss(() => { try { w.dispose(); } catch { /* ignore */ } t.webgl = null; });
      t.term.loadAddon(w);
      t.webgl = w;
    } catch { /* fallback DOM renderer */ }
  }
  if (shownId !== id) {
    shownId = id;
    requestAnimationFrame(() => { fitActive(); if (!isOverlayOpen()) t.term.focus(); });
    if (!$('#findbar').hidden) runFind(0);
  }
}

function fitActive() {
  const t = terms.get(S.state.active);
  if (!t || !t.host.classList.contains('visible')) return;
  try {
    const dims = t.fit.proposeDimensions();
    if (dims && dims.cols && dims.rows && (dims.cols !== t.term.cols || dims.rows !== t.term.rows)) t.term.resize(dims.cols, dims.rows);
    else if (dims) api.resize(S.state.active, t.term.cols, t.term.rows);
  } catch { /* not ready */ }
}
new ResizeObserver(() => requestAnimationFrame(fitActive)).observe($('#terms'));

function setFontSize(n) {
  fontSize = Math.max(8, Math.min(32, n));
  UiLogic.storeSize(localStorage, 'fontSize', fontSize, S.settings.fontSize);
  for (const t of terms.values()) t.term.options.fontSize = fontSize;
  requestAnimationFrame(fitActive);
}

// =============== sidebar render ===============
function findSession(id) {
  for (const w of S.state.workspaces) for (const s of w.sessions) if (s.id === id) return Object.assign({ ws: w }, s);
  return null;
}
function allSessions() { return S.state.workspaces.flatMap((w) => w.sessions.map((s) => Object.assign({ ws: w }, s))); }

function shortPath(p) {
  if (!p) return '';
  const home = (S.home || '').toLowerCase();
  let out = p;
  const m = /^([A-Za-z]):\\Users\\[^\\]+(\\.*)?$/.exec(p);
  if (m) out = '~' + (m[2] || '').replace(/\\/g, '/');
  else out = p.replace(/\\/g, '/');
  void home;
  return out;
}

function glyphHtml(s) {
  if (s.exited) return `<span class="glyph g-exited">${ICONS.close}</span>`;
  if (s.status === 'done') return `<span class="glyph g-done">${ICONS.check}</span>`;
  return `<span class="glyph g-${s.status}"></span>`;
}

function render() {
  if (renameLock) { pendingRender = true; return; }
  pendingRender = false;
  // create / dispose xterm instances to match the session list
  const list = allSessions();
  const ids = new Set(list.map((s) => s.id));
  for (const id of [...terms.keys()]) if (!ids.has(id)) disposeTerm(id);
  for (const s of list) {
    const x = ensureTerm(s.id);
    if (s.exited) markExited(x, s.exitCode);
  }

  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  let n = 0;
  for (const w of S.state.workspaces) {
    const wsEl = el('div', 'ws' + (w.collapsed ? ' collapsed' : ''));
    wsEl.dataset.ws = w.id;
    const head = el('div', 'ws-head');
    head.draggable = true;
    const flags = w.sessions.some((s) => s.status === 'blocked') ? 'blocked'
      : w.sessions.some((s) => s.status === 'active') ? 'active'
        : w.sessions.some((s) => s.unread) ? 'unread' : '';
    head.innerHTML = `
      <span class="ws-chev">${ICONS.chevron}</span>
      <span class="ws-name">${esc(w.name)}</span>
      ${w.collapsed && flags ? `<span class="ws-badge ${flags}"></span>` : ''}
      <span class="ws-count">${w.sessions.length || ''}</span>
      <button class="ws-act" data-act="add" title="${esc(t('ws.newSessionHere'))}">${ICONS.plus}</button>
      <button class="ws-act" data-act="more" title="${esc(t('ws.more'))}">${ICONS.more}</button>`;
    head.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add') return newSession({ workspace: w.id });
      if (act === 'more') return wsMenu(w, e.target.closest('button'));
      api.cmd('workspace.update', { id: w.id, collapsed: !w.collapsed });
    });
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) { e.preventDefault(); renameWorkspace(w.id); } });
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); wsMenu(w, { x: e.clientX, y: e.clientY }); });
    wireWsDnD(head, wsEl, w);
    wsEl.appendChild(head);

    const body = el('div', 'ws-body');
    if (!w.sessions.length) body.appendChild(el('div', 'ws-empty', esc(t('ws.empty'))));
    for (const s of w.sessions) {
      n++;
      const row = el('div', 'sess');
      row.dataset.id = s.id;
      row.draggable = true;
      row.classList.toggle('active', s.id === S.state.active);
      row.classList.toggle('unread', !!s.unread && s.id !== S.state.active);
      row.classList.toggle('exited', !!s.exited);
      row.classList.add('st-' + s.status);
      const sub = s.title && !/\\|\/|^[A-Z]:/.test(s.title) && !/^(MINGW|bash|pwsh|powershell|cmd)/i.test(s.title)
        ? s.title : shortPath(s.cwd);
      row.title = `${s.name}  ·  ${s.id}\n${s.cwd}\n${S.shells[s.shell]?.label || s.shell}  ·  ${statusLabel(s.status)}`;
      row.innerHTML = `
        ${glyphHtml(s)}
        <div class="sess-text"><div class="sess-name">${esc(s.name)}</div><div class="sess-sub"><bdi>${esc(sub)}</bdi></div></div>
        ${s.unread && s.id !== S.state.active ? '<span class="sess-unread"></span>' : (n <= 9 ? `<span class="sess-key">${n}</span>` : '')}
        <button class="sess-close" title="${esc(t('sess.closeTip'))}">${ICONS.close}</button>`;
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('.sess-close')) return;
        if (s.id !== S.state.active) api.cmd('session.select', { id: s.id });
      });
      row.addEventListener('click', (e) => {
        if (e.target.closest('.sess-close')) return closeSession(s.id);
        terms.get(s.id)?.term.focus();
      });
      row.addEventListener('auxclick', (e) => { if (e.button === 1) closeSession(s.id); });
      row.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) renameSession(s.id); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); sessMenu(s, { x: e.clientX, y: e.clientY }); });
      wireSessDnD(row, s, w);
      body.appendChild(row);
    }
    wsEl.appendChild(body);
    tree.appendChild(wsEl);
  }
  tree.scrollTop = scroll;
  renderCrumbs();
  showActive();
}

function renderCrumbs() {
  const s = findSession(S.state.active);
  const c = $('#crumbs');
  if (!s) { c.innerHTML = ''; document.title = 'Kolonka'; return; }
  const st = s.exited ? `<span class="chip exited">${esc(t('chip.exited', { code: s.exitCode }))}</span>`
    : s.status !== 'idle' ? `<span class="chip st-${s.status}">${statusLabel(s.status)}</span>` : '';
  c.innerHTML = `
    <span class="crumb-ws">${esc(s.ws.name)}</span>
    <span class="crumb-sep">${ICONS.chevron}</span>
    <span class="crumb-name">${esc(s.name)}</span>
    <span class="chip cwd" title="${esc(s.cwd)}">${ICONS.folder}<span>${esc(shortPath(s.cwd))}</span></span>
    <span class="chip">${esc(S.shells[s.shell]?.label || s.shell)}</span>
    ${st}`;
  c.querySelector('.cwd').addEventListener('dblclick', () => api.cmd('open.path', { id: s.id }));
  document.title = `${s.name} — Kolonka`;
}

// =============== drag & drop ===============
function clearDropMarks() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach((e) => e.classList.remove('drop-before', 'drop-after', 'drop-into'));
}
function wireSessDnD(row, s) {
  row.addEventListener('dragstart', (e) => {
    dragInfo = { kind: 'sess', id: s.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', s.id);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  row.addEventListener('dragend', () => { dragInfo = null; row.classList.remove('dragging'); clearDropMarks(); });
  row.addEventListener('dragover', (e) => {
    if (!dragInfo || dragInfo.kind !== 'sess' || dragInfo.id === s.id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    clearDropMarks();
    row.classList.add(before ? 'drop-before' : 'drop-after');
  });
  row.addEventListener('drop', (e) => {
    if (!dragInfo || dragInfo.kind !== 'sess') return;
    e.preventDefault();
    const before = row.classList.contains('drop-before');
    clearDropMarks();
    const ws = S.state.workspaces.find((w) => w.sessions.some((x) => x.id === s.id));
    let index = ws.sessions.findIndex((x) => x.id === s.id) + (before ? 0 : 1);
    const fromIdx = ws.sessions.findIndex((x) => x.id === dragInfo.id);
    if (fromIdx >= 0 && fromIdx < index) index--;
    api.cmd('session.update', { id: dragInfo.id, workspace: ws.id, index });
  });
}
function wireWsDnD(head, wsEl, w) {
  head.addEventListener('dragstart', (e) => {
    dragInfo = { kind: 'ws', id: w.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', w.id);
    requestAnimationFrame(() => wsEl.classList.add('dragging'));
  });
  head.addEventListener('dragend', () => { dragInfo = null; wsEl.classList.remove('dragging'); clearDropMarks(); });
  head.addEventListener('dragover', (e) => {
    if (!dragInfo) return;
    if (dragInfo.kind === 'ws' && dragInfo.id === w.id) return;
    e.preventDefault();
    clearDropMarks();
    if (dragInfo.kind === 'sess') head.classList.add('drop-into');
    else wsEl.classList.add('drop-before');
  });
  head.addEventListener('drop', (e) => {
    if (!dragInfo) return;
    e.preventDefault();
    clearDropMarks();
    if (dragInfo.kind === 'sess') api.cmd('session.update', { id: dragInfo.id, workspace: w.id });
    else {
      let index = S.state.workspaces.findIndex((x) => x.id === w.id);
      const from = S.state.workspaces.findIndex((x) => x.id === dragInfo.id);
      if (from < index) index--;
      api.cmd('workspace.update', { id: dragInfo.id, index });
    }
  });
  // an empty workspace accepts dropped sessions too
  wsEl.addEventListener('dragover', (e) => {
    if (dragInfo?.kind === 'sess' && e.target.closest('.ws-empty')) { e.preventDefault(); clearDropMarks(); head.classList.add('drop-into'); }
  });
  wsEl.addEventListener('drop', (e) => {
    if (dragInfo?.kind === 'sess' && e.target.closest('.ws-empty')) { e.preventDefault(); clearDropMarks(); api.cmd('session.update', { id: dragInfo.id, workspace: w.id }); }
  });
}

// =============== actions ===============
async function newSession(args = {}) {
  const r = await api.cmd('session.create', args);
  if (r && r.error) toastError(r.error);
}
async function newWorkspace() {
  const id = await api.cmd('workspace.create', { name: '' });
  if (id && !id.error) {
    await api.cmd('session.create', { workspace: id });
    setTimeout(() => renameWorkspace(id), 30);
  }
}
async function closeSession(id) {
  await api.cmd('session.close', { id });
}
function restartSession(id) { api.cmd('session.restart', { id }); }
function setStatus(id, status) { api.cmd('session.update', { id, status }); }

function inlineEdit(target, value, onDone) {
  renameLock = true;
  const input = el('input', 'rename-input');
  input.value = value;
  const orig = target.innerHTML;
  target.innerHTML = '';
  target.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (save) => {
    if (finished) return; finished = true;
    renameLock = false;
    const v = input.value.trim();
    target.innerHTML = orig;
    if (save && v && v !== value) onDone(v);
    else render();
    if (pendingRender) render();
    terms.get(S.state.active)?.term.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}
function renameSession(id) {
  const row = document.querySelector(`.sess[data-id="${id}"] .sess-name`);
  const s = findSession(id);
  if (!row || !s) return;
  inlineEdit(row, s.name, (v) => api.cmd('session.update', { id, name: v }));
}
function renameWorkspace(id) {
  const t = document.querySelector(`.ws[data-ws="${id}"] .ws-name`);
  const w = S.state.workspaces.find((x) => x.id === id);
  if (!t || !w) return;
  inlineEdit(t, w.name, (v) => api.cmd('workspace.update', { id, name: v }));
}
async function deleteWorkspace(w) {
  if (w.sessions.length) {
    const ok = await api.cmd('confirm', { message: t('ws.deleteQ', { name: w.name }), detail: t('ws.deleteDetail', { n: w.sessions.length }), ok: t('btn.delete') });
    if (!ok) return;
  }
  api.cmd('workspace.delete', { id: w.id });
}

function cycle(delta) {
  const list = allSessions().filter((s) => !s.ws.collapsed || s.id === S.state.active);
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === S.state.active);
  const next = list[(i + delta + list.length) % list.length];
  api.cmd('session.select', { id: next.id });
}
function selectNth(n) {
  const s = allSessions()[n - 1];
  if (s) api.cmd('session.select', { id: s.id });
}
function moveActive(delta) {
  const s = findSession(S.state.active);
  if (!s) return;
  const idx = s.ws.sessions.findIndex((x) => x.id === s.id);
  const to = idx + delta;
  if (to < 0 || to >= s.ws.sessions.length) return;
  api.cmd('session.update', { id: s.id, index: to });
}
function toggleSidebar() {
  document.body.classList.toggle('sidebar-hidden');
  localStorage.setItem('sidebarHidden', document.body.classList.contains('sidebar-hidden') ? '1' : '0');
  requestAnimationFrame(fitActive);
}

async function copySelection(id) {
  const x = terms.get(id);
  if (!x || !x.term.hasSelection()) return false;
  await api.cmd('clipboard.write', { text: x.term.getSelection().replace(/[ \t]+$/gm, '') });
  return true;
}
async function paste(id) {
  const x = terms.get(id);
  if (!x) return;
  const text = await api.cmd('clipboard.read');
  if (typeof text === 'string' && text) x.term.paste(text.replace(/\r?\n/g, '\r'));
}

// =============== keyboard ===============
function dictTarget(id) {
  return {
    id,
    write: (d) => api.input(id, d),
    paste: (text) => { const x = terms.get(id); if (x && !x.exited) { x.term.paste(text); x.term.focus(); } },
  };
}

function handleTermKey(e, id) {
  if (UiLogic.isComposing(e)) return false; // an IME is composing: the key is the IME's
  if (Dictation.handleKey(e, dictTarget(id))) return true;
  if (e.type !== 'keydown') return false;
  const x = terms.get(id);
  // by physical key: works on the Russian (and any other) layout
  const act = UiLogic.clipboardAction(e, !!(x && x.term.hasSelection()));
  if (act === 'copy-clear') { copySelection(id); x.term.clearSelection(); return true; }
  if (act === 'copy') { copySelection(id); return true; }
  if (act === 'paste') { paste(id); return true; }
  return handleGlobalKey(e);
}

function handleGlobalKey(e) {
  if (e.type !== 'keydown') return false;
  const k = e.key.toLowerCase();
  const code = e.code;
  const cs = e.ctrlKey && e.shiftKey && !e.altKey;
  const c = e.ctrlKey && !e.shiftKey && !e.altKey;
  const id = S.state.active;
  if (cs && code === 'KeyT') { newSession(); return true; }
  if (cs && code === 'KeyW') { if (id) closeSession(id); return true; }
  if (cs && code === 'KeyN') { newWorkspace(); return true; }
  if (cs && code === 'KeyP') { openPalette(); return true; }
  if (cs && code === 'KeyR') { if (id) renameSession(id); return true; }
  if (cs && code === 'KeyB') { toggleSidebar(); return true; }
  if (cs && code === 'KeyF') { openFind(); return true; }
  if (e.key === 'F2' && !e.ctrlKey && !e.altKey) { if (id) renameSession(id); return true; }
  if (e.ctrlKey && !e.altKey && k === 'tab') { cycle(e.shiftKey ? -1 : 1); return true; }
  if (c && k === 'pagedown') { cycle(1); return true; }
  if (c && k === 'pageup') { cycle(-1); return true; }
  if (cs && k === 'pagedown') { moveActive(1); return true; }
  if (cs && k === 'pageup') { moveActive(-1); return true; }
  if (c && /^Digit[1-9]$/.test(code)) { selectNth(Number(code.slice(5))); return true; }
  if (c && (k === '=' || k === '+')) { setFontSize(fontSize + 1); return true; }
  if (c && k === '-') { setFontSize(fontSize - 1); return true; }
  if (c && k === '0') { setFontSize(S.settings.fontSize || 14); return true; }
  return false;
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('.xterm')) return; // already handled by xterm
  if (!$('#palette').hidden || !$('#menu').hidden) return;
  if (e.target.tagName === 'INPUT') return;
  if (handleGlobalKey(e)) e.preventDefault();
}, true);

// =============== find ===============
function findQuery() { return $('#find-input').value; }
function openFind() {
  const fb = $('#findbar');
  fb.hidden = false;
  const x = terms.get(S.state.active);
  if (x && x.term.hasSelection()) $('#find-input').value = x.term.getSelection().split('\n')[0];
  $('#find-input').focus();
  $('#find-input').select();
  runFind(0);
}
function closeFind() {
  $('#findbar').hidden = true;
  for (const x of terms.values()) { x.search.clearDecorations(); }
  terms.get(S.state.active)?.term.focus();
}
const FIND_DECOR = { matchBackground: '#3a4a6e', matchBorder: '#3a4a6e', matchOverviewRuler: '#7aa2ff', activeMatchBackground: '#e8c27a', activeMatchBorder: '#e8c27a', activeMatchColorOverviewRuler: '#e8c27a' };
function runFind(dir) {
  const x = terms.get(S.state.active);
  if (!x) return;
  const q = findQuery();
  if (!q) { x.search.clearDecorations(); $('#find-count').textContent = ''; return; }
  const opts = { decorations: FIND_DECOR, incremental: dir === 0 };
  if (dir < 0) x.search.findPrevious(q, opts); else x.search.findNext(q, opts);
}

// =============== palette ===============
let palItems = [];
let palSel = 0;
function isOverlayOpen() { return !$('#palette').hidden || !$('#menu').hidden; }
function openPalette(prefill = '') {
  closeMenu();
  $('#palette').hidden = false;
  const inp = $('#pal-input');
  inp.value = prefill;
  inp.focus();
  palSel = 0;
  renderPalette();
}
function closePalette() {
  $('#palette').hidden = true;
  terms.get(S.state.active)?.term.focus();
}
function fuzzy(q, text) {
  if (!q) return { score: 0, html: esc(text) };
  const tl = text.toLowerCase();
  const ql = q.toLowerCase();
  const idx = tl.indexOf(ql);
  if (idx >= 0) {
    return { score: 100 - idx, html: esc(text.slice(0, idx)) + '<b>' + esc(text.slice(idx, idx + q.length)) + '</b>' + esc(text.slice(idx + q.length)) };
  }
  let ti = 0; let html = ''; let score = 0; let last = -2;
  for (const ch of ql) {
    const found = tl.indexOf(ch, ti);
    if (found < 0) return null;
    html += esc(text.slice(ti, found)) + '<b>' + esc(text[found]) + '</b>';
    score += found === last + 1 ? 3 : 1;
    last = found; ti = found + 1;
  }
  html += esc(text.slice(ti));
  return { score, html };
}
function paletteSource() {
  const items = [];
  allSessions().forEach((s, i) => items.push({
    group: t('pal.sessions'), icon: s.status === 'blocked' ? '<span class="glyph g-blocked"></span>' : ICONS.terminal,
    label: `${s.ws.name} / ${s.name}`, hint: i < 9 ? `Ctrl+${i + 1}` : shortPath(s.cwd), run: () => api.cmd('session.select', { id: s.id }),
  }));
  const cur = findSession(S.state.active);
  const G = t('pal.commands');
  for (const [key, sh] of Object.entries(S.shells)) {
    items.push({ group: G, icon: ICONS.plus, label: t('pal.newSessionShell', { shell: sh.label }), hint: key === S.defaultShell ? 'Ctrl+Shift+T' : '', run: () => newSession({ shell: key }) });
  }
  items.push({ group: G, icon: ICONS.folder, label: t('pal.newWorkspace'), hint: 'Ctrl+Shift+N', run: newWorkspace });
  if (cur) {
    items.push({ group: G, icon: ICONS.edit, label: t('pal.renameSession'), hint: 'F2', run: () => renameSession(cur.id) });
    items.push({ group: G, icon: ICONS.restart, label: t('pal.restartSession'), run: () => restartSession(cur.id) });
    items.push({ group: G, icon: ICONS.close, label: t('pal.closeSession'), hint: 'Ctrl+Shift+W', run: () => closeSession(cur.id) });
    for (const st of ['idle', 'active', 'blocked', 'done']) {
      items.push({ group: G, icon: ICONS.dot, label: t('pal.status', { s: statusLabel(st) }), run: () => setStatus(cur.id, st) });
    }
    for (const w of S.state.workspaces) if (w.id !== cur.ws.id) {
      items.push({ group: G, icon: ICONS.move, label: t('pal.moveTo', { name: w.name }), run: () => api.cmd('session.update', { id: cur.id, workspace: w.id }) });
    }
  }
  items.push({ group: G, icon: ICONS.search, label: t('pal.find'), hint: 'Ctrl+Shift+F', run: openFind });
  items.push({ group: G, icon: ICONS.collapse, label: t('pal.toggleSidebar'), hint: 'Ctrl+Shift+B', run: toggleSidebar });
  items.push({ group: G, icon: ICONS.gear, label: t('pal.openSettings'), run: () => api.cmd('open.settings') });
  items.push({ group: G, icon: ICONS.open, label: t('pal.openData'), run: () => api.cmd('open.data') });
  items.push({ group: G, icon: ICONS.mic, label: Dictation.enabled() ? t('pal.voiceOff') : t('pal.voiceOn'),
    run: () => showToast({ title: Dictation.toggle() ? t('voice.onToast') : t('voice.offToast'), text: t('voice.hint') }) });
  items.push({ group: G, icon: ICONS.bolt, label: t('pal.hooksInstall'), run: installHooks });
  items.push({ group: G, icon: ICONS.bolt, label: t('pal.hooksRemove'), run: () => installHooks(true) });
  if (S.api) items.push({ group: G, icon: ICONS.api, label: t('pal.copyApi'), hint: S.api.url, run: () => api.cmd('clipboard.write', { text: S.api.url }) });
  items.push({ group: G, icon: ICONS.bug, label: t('pal.report'), run: () => api.cmd('report') });
  return items;
}
function renderPalette() {
  const q = $('#pal-input').value.trim();
  const src = paletteSource();
  palItems = [];
  for (const it of src) {
    const f = fuzzy(q, it.label);
    if (f) palItems.push(Object.assign({}, it, f));
  }
  if (q) palItems.sort((a, b) => b.score - a.score);
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  const list = $('#pal-list');
  list.innerHTML = '';
  if (!palItems.length) { list.appendChild(el('div', 'pal-empty', esc(t('pal.nothing')))); return; }
  let group = null;
  palItems.forEach((it, i) => {
    if (!q && it.group !== group) { group = it.group; list.appendChild(el('div', 'pal-group', esc(group))); }
    const row = el('div', 'pal-item' + (i === palSel ? ' sel' : ''),
      `<span class="pal-ico">${it.icon}</span><span class="pal-label">${it.html}</span><span class="pal-hint">${esc(it.hint || '')}</span>`);
    row.addEventListener('mousemove', () => { if (palSel !== i) { palSel = i; markPal(); } });
    row.addEventListener('click', () => runPal(i));
    list.appendChild(row);
  });
  markPal();
}
function markPal() {
  const rows = [...document.querySelectorAll('.pal-item')];
  rows.forEach((r, i) => r.classList.toggle('sel', i === palSel));
  rows[palSel]?.scrollIntoView({ block: 'nearest' });
}
function runPal(i) {
  const it = palItems[i];
  closePalette();
  if (it) it.run();
}

// =============== context menu ===============
function openMenu(items, at) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(el('div', 'msep')); continue; }
    if (it.head) { m.appendChild(el('div', 'mhead', esc(it.head))); continue; }
    if (it.row) {
      const r = el('div', 'mrow');
      for (const b of it.row) {
        const btn = el('button', 'st' + (b.on ? ' on' : ''), b.html);
        btn.title = b.title;
        btn.addEventListener('click', () => { closeMenu(); b.run(); });
        r.appendChild(btn);
      }
      m.appendChild(r);
      continue;
    }
    const mi = el('div', 'mi' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''),
      `<span class="mi-ico">${it.icon || ''}</span><span>${esc(it.label)}</span>${it.hint ? `<span class="mi-hint">${esc(it.hint)}</span>` : ''}`);
    mi.addEventListener('click', () => { closeMenu(); it.run(); });
    m.appendChild(mi);
  }
  m.hidden = false;
  let x, y;
  if (at instanceof Element) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 4; } else { x = at.x; y = at.y; }
  const mr = m.getBoundingClientRect();
  x = Math.min(x, window.innerWidth - mr.width - 8);
  y = Math.min(y, window.innerHeight - mr.height - 8);
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = Math.max(8, y) + 'px';
}
function closeMenu() { $('#menu').hidden = true; }
document.addEventListener('mousedown', (e) => { if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

function sessMenu(s, at) {
  const items = [
    { icon: ICONS.edit, label: t('menu.rename'), hint: 'F2', run: () => renameSession(s.id) },
    { head: t('menu.status') },
    { row: ['idle', 'active', 'blocked', 'done'].map((st) => ({
      html: st === 'done' ? `<span class="glyph g-done">${ICONS.check}</span>` : `<span class="glyph g-${st}"></span>`,
      title: statusLabel(st), on: s.status === st, run: () => setStatus(s.id, st),
    })) },
  ];
  const others = S.state.workspaces.filter((w) => w.id !== s.ws.id);
  if (others.length) {
    items.push({ head: t('menu.moveTo') });
    for (const w of others) items.push({ icon: ICONS.folder, label: w.name, run: () => api.cmd('session.update', { id: s.id, workspace: w.id }) });
  }
  items.push('-',
    { icon: ICONS.plus, label: t('menu.newNext'), run: () => newSession({ workspace: s.ws.id, cwd: s.cwd, shell: s.shell, after: s.id }) },
    { icon: ICONS.open, label: t('menu.openFolder'), run: () => api.cmd('open.path', { id: s.id }) },
    { icon: ICONS.copy, label: t('menu.copyId'), hint: s.id, run: () => api.cmd('clipboard.write', { text: s.id }) },
    { icon: ICONS.restart, label: t('menu.restart'), run: () => restartSession(s.id) },
    '-',
    { icon: ICONS.close, label: t('menu.close'), hint: 'Ctrl+Shift+W', danger: true, run: () => closeSession(s.id) });
  openMenu(items, at);
}
function wsMenu(w, at) {
  const shellItems = Object.entries(S.shells).map(([key, sh]) => ({ icon: ICONS.terminal, label: sh.label, run: () => newSession({ workspace: w.id, shell: key }) }));
  openMenu([
    { head: t('menu.newSession') }, ...shellItems, '-',
    { icon: ICONS.edit, label: t('menu.rename'), run: () => renameWorkspace(w.id) },
    { icon: ICONS.collapse, label: w.collapsed ? t('menu.expand') : t('menu.collapse'), run: () => api.cmd('workspace.update', { id: w.id, collapsed: !w.collapsed }) },
    { icon: ICONS.copy, label: t('menu.copyId'), hint: w.id, run: () => api.cmd('clipboard.write', { text: w.id }) },
    '-',
    { icon: ICONS.trash, label: t('menu.deleteWs'), danger: true, run: () => deleteWorkspace(w) },
  ], at);
}
async function installHooks(remove = false) {
  const r = await api.cmd('hooks.install', { remove });
  if (r && r.error) toastError(r.error);
  else if (r === true) showToast({ title: remove ? t('hooks.removed') : t('hooks.installed'), text: remove ? '' : t('hooks.restartHint') });
}
async function settingsMenu(at) {
  const hooksOn = await api.cmd('hooks.status');
  openMenu([
    { icon: ICONS.bolt, label: hooksOn ? t('menu.hooksOn') : t('menu.hooksOff'), checked: hooksOn, run: () => installHooks(hooksOn) },
    { icon: ICONS.gear, label: t('pal.openSettings'), run: () => api.cmd('open.settings') },
    { icon: ICONS.open, label: t('menu.dataFolder'), run: () => api.cmd('open.data') },
    '-',
    ...(S.api ? [{ icon: ICONS.api, label: t('pal.copyApi'), hint: S.api.url.replace('http://', ''), run: () => api.cmd('clipboard.write', { text: S.api.url }) }] : []),
    { icon: ICONS.collapse, label: t('menu.hideSidebar'), hint: 'Ctrl+Shift+B', run: toggleSidebar },
    { icon: ICONS.bug, label: t('pal.report'), run: () => api.cmd('report') },
    '-',
    { icon: ICONS.bolt, label: `Kolonka ${S.version}`, run: () => {} },
  ], at);
}

// =============== toasts ===============
function showToast({ title, text, session, sticky }) {
  const node = el('div', 'toast', `<span class="t-ico">${ICONS.bolt}</span><div><div class="t-title">${esc(title || 'Kolonka')}</div>${text ? `<div class="t-text">${esc(text)}</div>` : ''}</div>`);
  node.addEventListener('click', () => { if (session) api.cmd('session.select', { id: session }); dismiss(); });
  const dismiss = () => { node.classList.add('out'); setTimeout(() => node.remove(), 220); };
  $('#toasts').appendChild(node);
  setTimeout(dismiss, sticky ? 30000 : 6000);
}
function toastError(msg) { showToast({ title: t('toast.error'), text: msg }); }
let hintShown = 0;
function toastHint(msg) { if (Date.now() - hintShown > 4000) { hintShown = Date.now(); showToast({ title: msg }); } }

// =============== static strings ===============
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  document.documentElement.lang = S.lang || 'en';
}

// =============== chrome wiring ===============
function wireChrome() {
  $('#btn-new-session').addEventListener('click', () => newSession());
  $('#btn-new-session').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = findSession(S.state.active)?.ws || S.state.workspaces[0];
    if (w) wsMenu(w, e.currentTarget);
  });
  $('#btn-new-ws').addEventListener('click', newWorkspace);
  $('#btn-palette').addEventListener('click', () => openPalette());
  $('#btn-settings').addEventListener('click', (e) => settingsMenu(e.currentTarget));
  $('#empty').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'new-session') newSession();
    if (a === 'new-ws') newWorkspace();
  });

  const inp = $('#pal-input');
  inp.addEventListener('input', () => { palSel = 0; renderPalette(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { palSel = Math.min(palItems.length - 1, palSel + 1); markPal(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); markPal(); e.preventDefault(); }
    else if (e.key === 'Enter') { runPal(palSel); e.preventDefault(); }
    else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
  });
  $('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

  const fi = $('#find-input');
  fi.addEventListener('input', () => runFind(0));
  fi.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { runFind(e.shiftKey ? -1 : 1); e.preventDefault(); }
    if (e.key === 'Escape') { closeFind(); e.preventDefault(); }
  });
  $('#find-next').addEventListener('click', () => runFind(1));
  $('#find-prev').addEventListener('click', () => runFind(-1));
  $('#find-close').addEventListener('click', closeFind);

  // sidebar resizing
  const rz = $('#resizer');
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      const w = Math.max(190, Math.min(520, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      UiLogic.storeSize(localStorage, 'sidebarW', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10), S.settings.sidebarWidth);
      fitActive();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  rz.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--sidebar-w', (S.settings.sidebarWidth || 264) + 'px');
    localStorage.removeItem('sidebarW');
    fitActive();
  });
  document.body.classList.add('focused');
}
