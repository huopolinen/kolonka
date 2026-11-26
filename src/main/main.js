'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell, Notification, nativeImage, dialog, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Model } = require('./model');
const { detectShells } = require('./shells');
const { startApi } = require('./api');
const { Dictation } = require('./dictation');
const { Crash } = require('./crash');
const { openableDir } = require('./paths');
const { displayCmd, validKey } = require('./remote');
const { publicSettings, settingsSecrets } = require('./settings-public');
const { needsPrivateAcl, restrictToUser } = require('./acl');
const { loadSettings } = require('./settings');
const { resolveDataDir } = require('./datadir');
const { Updater } = require('./updater');
const UpdatePolicy = require('../shared/update-policy');
const I18N = require('../shared/i18n');

const pkg = require('../../package.json');
const ROOT = path.join(__dirname, '..', '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const BIN_DIR = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'bin');
// "Connect a server": the ssh config side, shared with the CLI (which runs under plain node, outside app.asar)
const sshconfig = require(path.join(BIN_DIR, 'sshconfig.js'));

app.setName('Kolonka');
nativeTheme.themeSource = 'dark'; // dark Mica regardless of the Windows theme
app.setAppUserModelId('dev.kolonka.terminal');
const { dir: DATA_DIR, isolated: ISOLATED } = resolveDataDir(process.env, app.getPath('appData'));
fs.mkdirSync(DATA_DIR, { recursive: true });
// An instance with its own data folder is a separate instance: the single-instance lock lives in
// userData, so without this a second Kolonka with KOLONKA_DATA would just focus the first one and exit.
// KOLONKA_DATA equal to the default folder (inherited from a Kolonka tab) is the normal instance and keeps
// the normal lock, so it focuses the running Kolonka instead of opening the same state twice.
if (ISOLATED) app.setPath('userData', path.join(DATA_DIR, 'chromium'));
// tabs of the normal instance need no KOLONKA_DATA: the CLI and the hooks find %APPDATA%\Kolonka by default
else delete process.env.KOLONKA_DATA;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const loaded = loadSettings(path.join(DATA_DIR, 'settings.json'));
const settings = loaded.settings;
const settingsError = loaded.error; // shown in the window once it is up
let lang = 'en';
let t = I18N.make(lang);
let win = null;
let api = null;
let shells = null;
let model = null;
let dictation = null;

const crash = new Crash({
  dataDir: DATA_DIR,
  pkg,
  t: (...a) => t(...a),
  getWin: () => (win && !win.isDestroyed() ? win : null),
  info: () => ({
    Shells: Object.keys(shells || {}).join(', '),
    'Default shell': model ? model.defaultShellKey() : '?',
    Sessions: model ? model.sessions.size : 0,
    Dictation: dictation ? `${dictation.cfg.engine}${dictation.cfg.engine === 'local' ? '/' + dictation.build() : ''}` : '?',
    Material: settings.backgroundMaterial,
  }),
  // literal secrets scrubbed from problem reports, whatever format they have
  secrets: () => [api && api.token, ...settingsSecrets(settings), ...(dictation ? dictation.secrets() : [])],
  // a fatal error can end the process with app.exit, which skips before-quit
  beforeExit: () => { if (dictation) dictation.stopServer(); },
});
crash.start();
if (settingsError) crash.log('error', 'settings.json could not be read, using the defaults: ' + settingsError);
for (const line of loaded.log || []) crash.log('info', line);

shells = detectShells(DATA_DIR);
Object.assign(shells, settings.shells || {}); // user-defined shells from settings.json
model = new Model({ dataDir: DATA_DIR, settings, shells, env: ISOLATED ? { KOLONKA_DATA: DATA_DIR } : {}, pathPrepend: BIN_DIR });
dictation = new Dictation({
  settings,
  baseDir: path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Kolonka', 'whisper'),
});
dictation.on('progress', (p) => send('dictation:progress', p));
dictation.detectBuild(); // GPU probe in the background, off the IPC path
dictation.killOrphan().then((k) => k && crash.log('info', 'stopped a whisper-server left from a previous run'), (e) => crash.log('warn', 'orphan check: ' + e.message));
// last resort: the process is exiting without before-quit (app.exit, a fatal error)
process.on('exit', () => { try { dictation.stopServer(); } catch { /* ignore */ } });
// updates from GitHub releases ("updates" in settings.json); off in development builds
const updater = new Updater({ mode: settings.updates, version: pkg.version, log: (level, msg) => crash.log(level, msg), isPackaged: app.isPackaged, isolated: ISOLATED });
updater.on('state', (s) => send('update:state', s));
updater.on('download-failed', (f) => send('toast', { title: t('update.downloadFailed'), text: f.checksum ? t('update.badChecksum') : f.message }));
let winState = {};
const winStateFile = path.join(DATA_DIR, 'window.json');
try { winState = JSON.parse(fs.readFileSync(winStateFile, 'utf8')); } catch { /* defaults */ }

// ---------- window ----------
function createWindow() {
  const b = winState.bounds;
  const visible = b && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  const material = settings.backgroundMaterial && settings.backgroundMaterial !== 'none' ? settings.backgroundMaterial : null;
  win = new BrowserWindow({
    width: visible ? b.width : 1280,
    height: visible ? b.height : 800,
    x: visible ? b.x : undefined,
    y: visible ? b.y : undefined,
    minWidth: 560,
    minHeight: 340,
    show: false,
    title: 'Kolonka',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: material ? '#00000000' : '#0b0d12',
    backgroundMaterial: material || undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#9aa3b5', height: 38 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, perm, cb, details) => cb(perm === 'media' && (!details.mediaTypes || details.mediaTypes.every((m) => m === 'audio'))));
  ses.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  if (winState.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    setTimeout(() => crash.checkPrevious().catch((e) => crash.log('error', e.stack)), 800);
  });
  // Windows is logging off or shutting down: before-quit may never come, save now
  win.on('session-end', () => { shutdown(); });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    winState = { bounds: win.isMaximized() ? (winState.bounds || win.getBounds()) : win.getBounds(), maximized: win.isMaximized() };
    try { fs.writeFileSync(winStateFile, JSON.stringify(winState)); } catch { /* ignore */ }
  };
  win.on('resize', debounce(saveBounds, 400));
  win.on('move', debounce(saveBounds, 400));
  win.on('close', saveBounds);
  win.on('focus', () => send('window:focus', true));
  win.on('blur', () => send('window:focus', false));
  win.on('closed', () => { win = null; });
  win.on('unresponsive', () => crash.log('warn', 'window unresponsive'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    // DevTools give full access to the renderer (and the clipboard); development builds only
    if (input.type === 'keyDown' && input.key === 'F12' && input.control && input.shift && (!app.isPackaged || process.env.KOLONKA_DEBUG)) win.webContents.toggleDevTools();
  });
}

function send(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- model ↔ window ----------
const pending = new Map(); // id -> batched output
let flushTimer = null;
model.on('data', (id, data, seq) => {
  let p = pending.get(id);
  if (!p) { p = { data: '', seq }; pending.set(id, p); }
  p.data += data; p.seq = seq;
  if (!flushTimer) flushTimer = setTimeout(flushData, 8);
});
function flushData() {
  flushTimer = null;
  for (const [id, p] of pending) send('pty:data', id, p.data, p.seq);
  pending.clear();
}
model.on('change', () => send('state', model.tree()));
model.on('exit', (id, code) => { flushData(); send('pty:exit', id, code); });
model.on('closed', (id) => { pending.delete(id); send('pty:closed', id); });
model.on('status', (s, status) => {
  if (!settings.notifications) return;
  const away = !win || !win.isFocused() || model.activeId !== s.id;
  if (away && (status === 'blocked' || status === 'done')) {
    notify({
      title: t(status === 'blocked' ? 'notify.blocked' : 'notify.done', { name: s.name }),
      text: t(status === 'blocked' ? 'notify.blockedText' : 'notify.doneText'),
      session: s.id,
    });
  }
});

// ---------- remote control over ssh (see src/main/remote.js) ----------
model.on('log', (level, msg) => crash.log(level, msg));
// a notification asked for by a program in a tab (OSC 7711 notify, OSC 9, OSC 777)
model.on('notify', ({ title, text, session }) => notify({ title, text, session }));
const REMOTE_NOTICES = {
  'no-ssh': 'remote.noSsh', 'not-ssh': 'remote.notSsh', 'no-ssh-exe': 'remote.noSshExe',
  'ssh-options': 'remote.sshOptions', 'too-many': 'remote.tooMany',
};
model.on('remote-notice', ({ reason, session, name, host, options }) => {
  const key = REMOTE_NOTICES[reason];
  if (key) {
    send('toast', {
      title: t('remote.refusedTitle'),
      text: t(key, { name, host: host || '', options: (options || []).join(' '), max: model._remoteCfg().maxTabs }),
      session,
    });
  }
});
// The permission dialog. The tab's name is shown only if the server did not set it; the command as it
// will run (runs of spaces collapsed). "Always" only for a request with the tab's own token.
model.askRemote = async ({ session, name, from, host, cmd, same, verified }) => {
  if (!win || win.isDestroyed()) return 'none';
  if (!win.isFocused()) win.flashFrame(true);
  const tab = name ? t('remote.tabNamed', { name, id: session }) : t('remote.tabUnnamed', { id: session });
  const answers = verified ? ['once', 'always', 'deny', 'deny-tab'] : ['once', 'deny', 'deny-tab'];
  const label = { once: t('remote.allowOnce'), always: t('remote.allowAlways'), deny: t('remote.deny'), 'deny-tab': t('remote.denyTab') };
  const shown = displayCmd(cmd);
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Kolonka',
    buttons: answers.map((a) => label[a]),
    defaultId: answers.indexOf('deny'),
    cancelId: answers.indexOf('deny'),
    noLink: true,
    message: same || !from ? t('remote.askSame', { tab, host }) : t('remote.askOther', { tab, from, host }),
    detail: (shown || t('remote.askLogin')) + (verified ? '' : '\n\n' + t('remote.unverified')),
  });
  win.flashFrame(false);
  if (!model.sessions.has(session)) return 'none';
  return answers[r.response] || 'deny';
};

const notifications = new Set();
function notify({ title, text, session, force }) {
  const s = session && model.sessions.get(session);
  const ttl = title || (s ? s.name : 'Kolonka');
  // window focused: in-app toast, otherwise a Windows notification
  if (win && win.isFocused() && !force) { send('toast', { title: ttl, text, session }); return; }
  if (Notification.isSupported()) {
    const n = new Notification({ title: ttl, body: text || '', icon: fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined });
    // keep a reference until the notification is gone: a collected one never delivers its click
    // (a timed-out toast still sits in the Action Center and can be clicked there; the oldest are dropped)
    notifications.add(n);
    if (notifications.size > 20) notifications.delete(notifications.values().next().value);
    const forget = () => notifications.delete(n);
    n.on('click', () => { forget(); if (s && model.sessions.has(s.id)) model.selectSession(s.id); focusWindow(); });
    n.on('close', (_e, details) => { if (!details || details.reason !== 'timedOut') forget(); });
    n.on('failed', forget);
    n.show();
  } else send('toast', { title: ttl, text, session });
}

// ---------- IPC ----------
ipcMain.handle('init', async () => ({
  state: model.tree(),
  settings: publicSettings(settings), // API keys stay in the main process
  settingsError,
  lang,
  shells: Object.fromEntries(Object.entries(shells).map(([k, v]) => [k, { label: v.label }])),
  defaultShell: model.defaultShellKey(),
  api: await apiForWindow(),
  version: pkg.version,
  platform: process.platform,
  dictation: dictation.publicConfig(),
  update: updater.state(),
  // the empty screen and the first start offer "Connect a server…" while nothing is connected
  firstRun: model.firstRun,
  connected: connectedServers().length,
  connect: connectArg(process.argv), // Kolonka.exe --connect=<address>: the dialog opens filled in
}));
ipcMain.on('log', (_e, level, msg) => crash.log(String(level || 'info'), String(msg || '').slice(0, 4000)));
ipcMain.handle('dictation:warm', () => { dictation.warm(); return dictation.publicConfig(); });
ipcMain.handle('dictation:install', async () => {
  try { await dictation.install(); dictation.warm(); return { ok: true }; } catch (e) { crash.log('error', 'dictation install: ' + e.stack); return { error: e.message }; }
});
ipcMain.handle('dictation:transcribe', async (_e, wav) => {
  try { return { text: await dictation.transcribe(wav) }; } catch (e) { crash.log('error', 'dictation: ' + e.stack); return { error: e.message }; }
});
ipcMain.handle('snapshot', async (_e, id) => {
  const s = model.sessions.get(id);
  if (!s) return null;
  // send the batched output first: every batch the window gets before the snapshot then has
  // seq <= snapshot.seq and is dropped, every later one is newer — nothing is shown twice
  flushData();
  return s.snapshot();
});
ipcMain.on('pty:input', (_e, id, data) => { const s = model.sessions.get(id); if (s) s.write(data); });
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  const s = model.sessions.get(id);
  if (s) s.resize(cols, rows);
  if (cols > 10 && rows > 3) model.lastSize = { cols, rows };
});
ipcMain.handle('cmd', async (_e, name, args = {}) => {
  try {
    switch (name) {
      case 'session.create': return model.createSession(args).info();
      case 'session.select': model.selectSession(args.id); return true;
      case 'session.close': return model.closeSession(args.id);
      case 'session.restart': model.restartSession(args.id); return true;
      case 'session.update': model.updateSession(args.id, args); return true;
      case 'workspace.create': return model.createWorkspace(args).id;
      case 'workspace.update': model.updateWorkspace(args.id, args); return true;
      case 'workspace.delete': return model.deleteWorkspace(args.id, { force: true });
      // asynchronous since Electron 44 (W3C-style clipboard API): await, so a failure reaches the catch below
      case 'clipboard.read': return await clipboard.readText();
      case 'clipboard.write': await clipboard.writeText(String(args.text || '')); return true;
      case 'hooks.status': return require(path.join(BIN_DIR, 'hooks.js')).installed();
      case 'hooks.install': {
        const hooks = require(path.join(BIN_DIR, 'hooks.js'));
        const remove = !!args.remove;
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: [remove ? t('hooks.btnRemove') : t('hooks.btnInstall'), t('btn.cancel')], defaultId: 0, cancelId: 1,
          message: remove ? t('hooks.removeQ') : t('hooks.installQ'),
          detail: t('hooks.detail', { file: hooks.settingsFile() }),
        });
        if (r.response !== 0) return false;
        hooks.install(remove);
        return true;
      }
      case 'report': crash.report({ title: 'Problem report' }); return true;
      case 'update.check': return await updater.check({ manual: true });
      case 'update.download': return await updater.download({ manual: true });
      case 'update.install': return await installUpdate();
      case 'open.settings': shell.openPath(path.join(DATA_DIR, 'settings.json')); return true;
      case 'open.data': shell.openPath(DATA_DIR); return true;
      case 'open.external': if (/^https?:\/\//.test(args.url)) shell.openExternal(args.url); return true;
      case 'open.path': {
        // by session id: the main process picks the folder, the renderer cannot name a file or a UNC path
        const dir = openableDir(model, args.id);
        if (!dir) return { error: 'not a local folder' };
        shell.openPath(dir);
        return true;
      }
      case 'connect.preview': return connectPreview(args.address);
      case 'connect.run': return await connectServer(args);
      case 'connect.servers': return connectedServers();
      case 'connect.disconnect': return await disconnectServer(args.key);
      case 'confirm': {
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: [args.ok || t('btn.yes'), t('btn.cancel')], defaultId: 0, cancelId: 1, message: args.message, detail: args.detail });
        return r.response === 0;
      }
      default: throw new Error('unknown cmd ' + name);
    }
  } catch (e) {
    crash.log('warn', `cmd ${name}: ${e.message}`);
    return { error: e.message };
  }
});

// ---------- connect a server (bin/sshconfig.js, model.connectServer) ----------
// Kolonka.exe --connect=<address> (or --connect <address>): an administrator's shortcut for a colleague.
// It only fills in the dialog; nothing changes until the user presses Connect in it. The = form is the
// one to use: Chromium may move a separate value away from its switch in the second instance's argv.
const connectArg = sshconfig.connectArg;

const sameKey = (a, b) => a.toLowerCase() === b.toLowerCase();

// Servers with Kolonka's block in the ssh config or trusted with "Always": [{ key, config, trusted }]
function connectedServers() {
  const inConfig = sshconfig.readKeys(sshconfig.configFile());
  const keys = [...inConfig];
  for (const k of model.remoteAllowed) if (!keys.some((x) => sameKey(x, k))) keys.push(k);
  return keys.map((key) => ({ key, config: inConfig.some((x) => sameKey(x, key)), trusted: model.remoteAllowed.some((x) => sameKey(x, key)) }));
}

function configErrorText(e, file) {
  const key = 'connect.cfg.' + e.code;
  return I18N.D.en[key] ? t(key, { file: e.file || file }) : t('connect.cfgFailed', { file: e.file || file, msg: e.message });
}

// What the dialog shows under the address: the block that goes into the ssh config, or why the address is wrong.
function connectPreview(address) {
  const tg = sshconfig.parseTarget(address);
  if (tg.error) return { invalid: t('connect.err.' + tg.error) };
  const file = sshconfig.configFile();
  return {
    key: tg.key, file, block: sshconfig.blockLines(tg).join('\n'),
    inConfig: sshconfig.readKeys(file).some((k) => sameKey(k, tg.key)), trusted: model.remoteHostAllowed(tg.key),
  };
}

async function connectServer({ address, name, open }) {
  const tg = sshconfig.parseTarget(address);
  if (tg.error) return { error: t('connect.err.' + tg.error) };
  const file = sshconfig.configFile();
  let r;
  try { r = await sshconfig.connectConfig(tg, { file }); } catch (e) {
    crash.log('warn', `connect ${tg.key}: ${e.message}`);
    return { error: configErrorText(e, file) };
  }
  crash.log('info', `connect ${tg.key}: ssh config ${r.changed ? 'changed' + (r.backup ? ', copy ' + path.basename(r.backup) : '') : 'already had the block'}`);
  try {
    const res = model.connectServer({ destination: tg.destination, options: tg.options, name, open: open !== false });
    return { key: res.host, session: res.session, configChanged: r.changed, backup: r.backup ? path.basename(r.backup) : null, file };
  } catch (e) {
    return { error: t('connect.trustFailed', { key: tg.key, msg: e.message }) };
  }
}

// key: as listed by connect.servers; a key remembered from a server's request that the address parser
// would not take (it is stricter) is used as it is, if it is a valid key
async function disconnectServer(raw) {
  const tg = sshconfig.parseTarget(raw);
  if (tg.error && !validKey(raw)) return { error: t('connect.err.' + tg.error) };
  const key = tg.error ? raw : tg.key;
  const file = sshconfig.configFile();
  const r0 = await dialog.showMessageBox(win, {
    type: 'question', buttons: [t('connect.btnDisconnect'), t('btn.cancel')], defaultId: 0, cancelId: 1,
    message: t('connect.disconnectQ', { key }), detail: t('connect.disconnectDetail', { file }),
  });
  if (r0.response !== 0) return false;
  let r;
  try { r = await sshconfig.disconnectConfig(key, { file }); } catch (e) { return { error: configErrorText(e, file) }; }
  const forgot = model.forgetRemoteHost(key);
  if (forgot) model.saveNow();
  crash.log('info', `disconnect ${key}: ssh config ${r.changed ? 'block removed' : 'had no block'}, trust ${forgot ? 'removed' : 'was not there'}`);
  return { key, configChanged: r.changed, forgot, backup: r.backup ? path.basename(r.backup) : null };
}

// ---------- lifecycle ----------
app.on('second-instance', (_e, argv) => {
  focusWindow();
  const address = connectArg(argv || []);
  if (address) send('window:action', { connect: address });
});

// The window does not depend on the API: it opens right away, and init waits for the API briefly.
let apiStarting = null;
async function apiForWindow() {
  const a = api || await Promise.race([
    (apiStarting || Promise.resolve(null)).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 3000)),
  ]);
  return a ? { url: a.url, controlFile: a.controlFile } : null;
}

app.whenReady().then(async () => {
  lang = I18N.pickLang(settings.language, app.getPreferredSystemLanguages());
  t = I18N.make(lang);
  model.load();
  createWindow();
  updater.start(); // the first check comes 30 s later, the window does not wait for it
  // hooks written by older versions call `node`, which fails on every Claude Code action without node in PATH
  if (app.isPackaged) { try { require(path.join(BIN_DIR, 'hooks.js')).migrate(); } catch (e) { crash.log('warn', 'hooks migrate: ' + e.message); } }
  try {
    // control.json is protected before the API writes the token into it
    api = await (apiStarting = protectControlFile().then(() => startApi({
      model, dataDir: DATA_DIR, port: settings.apiPort,
      hooks: {
        version: pkg.version,
        focus: focusWindow,
        notify,
        screenshot: async (file) => {
          if (!win) throw new Error('no window');
          const img = await win.webContents.capturePage();
          const png = img.toPNG();
          if (file) { fs.writeFileSync(file, png); return { path: file, width: img.getSize().width, height: img.getSize().height }; }
          return { png: png.toString('base64') };
        },
        window: (action) => {
          if (action === 'bounds') return win ? Object.assign(win.getContentBounds(), { maximized: win.isMaximized(), focused: win.isFocused() }) : null;
          if (action && action.eval && process.env.KOLONKA_DEBUG && win) return win.webContents.executeJavaScript(action.eval).then((r) => ({ result: r }));
          if (action === 'focus') focusWindow();
          else if (action === 'quit') setTimeout(() => app.quit(), 50);
          else if (action === 'reload') { if (win) win.reload(); }
          else if (action === 'crash-test' && process.env.KOLONKA_DEBUG) setTimeout(() => { throw new Error('crash test'); }, 10);
          else send('window:action', action);
        },
      },
    })));
  } catch (e) { crash.log('error', 'API failed to start: ' + (e && e.stack || e)); }
});

// control.json holds the API token. Outside the user profile (KOLONKA_DATA on a shared drive) it would
// inherit a folder ACL other users can read, so it is created first and limited to the current user;
// the API then overwrites it in place, which keeps that ACL.
async function protectControlFile() {
  if (!needsPrivateAcl(DATA_DIR, app.getPath('home'))) return;
  const file = path.join(DATA_DIR, 'control.json');
  try {
    fs.writeFileSync(file, '{}');
    await restrictToUser(file);
    crash.log('info', 'control.json limited to the current user (data folder is outside the profile)');
  } catch (e) {
    crash.log('warn', `could not limit access to ${file}; other users of this folder may read the API token: ${e.message}`);
  }
}

// "Restart to update": ask first if sessions are working or waiting for an answer, then quit the way a normal
// quit does (state saved, shells and whisper-server stopped) and let the installer start Kolonka again.
let updateAsking = null;
function installUpdate() {
  if (!updateAsking) updateAsking = confirmAndInstall().finally(() => { updateAsking = null; });
  return updateAsking; // a second click while the question is open gets the same answer
}
async function confirmAndInstall() {
  const plan = UpdatePolicy.restartPlan(updater.state(), [...model.sessions.values()].map((s) => s.info()));
  if (plan.action === 'none') return { error: t('update.notReady') };
  if (plan.action === 'confirm') {
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: [t('update.btnRestart'), t('btn.cancel')], defaultId: 1, cancelId: 1,
      message: t('update.busyQ', { n: plan.busy }), detail: t('update.busyDetail', { version: updater.state().version }),
    });
    if (r.response !== 0) return false;
  }
  if (!updater.installNow({ beforeQuit: shutdown })) return { error: t('update.notReady') };
  // quitAndInstall quits as soon as the installer has started. If it could not start it, the shells are
  // already stopped: start this version again rather than leave a window of dead tabs.
  setTimeout(() => { crash.log('error', 'the update installer did not start; restarting Kolonka'); app.relaunch(); app.exit(0); }, 15000).unref();
  return true;
}

let quitting = false;
function shutdown() {
  if (quitting) return;
  quitting = true;
  updater.stop();
  model.shutdown();
  dictation.stopServer();
  if (api) { try { fs.unlinkSync(api.controlFile); } catch { /* ignore */ } }
  crash.log('info', 'quit');
  crash.cleanExit();
}
app.on('before-quit', shutdown);
app.on('window-all-closed', () => app.quit());

function debounce(fn, ms) {
  let tm;
  return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); };
}
