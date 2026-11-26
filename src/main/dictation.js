'use strict';
// Voice input: speech recognition locally (whisper.cpp server) or through a cloud API.
// The renderer sends a WAV (16 kHz mono) and gets the text back.
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const childProcess = require('child_process');
const { EventEmitter } = require('events');

// Every download is pinned: a fixed whisper.cpp release and a fixed Hugging Face commit, each file
// with its SHA-256. A file that does not match is deleted and never used.
const WHISPER_RELEASE = 'b5907';
const RELEASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}`;
const BUILDS = {
  cuda: {
    url: `${RELEASE_URL}/whisper-bin-win-cuda-12.4.0-x64.zip`,
    sha256: '34f872ce724ca1ff0a4afca481853e5ee74250f8cb22153e499f953562846039',
    files: ['ggml-cuda.dll', 'cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'],
  },
  cpu: {
    url: `${RELEASE_URL}/whisper-blas-bin-x64.zip`,
    sha256: '98a4691eb23a3a2afe91b0773bea5b2b4bcd5e7432a49e588724e84268711f11',
    files: ['ggml-blas.dll', 'libopenblas.dll'],
  },
};
// Files whisper-server.exe needs next to it in both builds.
const COMMON_FILES = ['whisper.dll', 'ggml.dll', 'ggml-base.dll'];

const HF_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
const HF_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_COMMIT}`;
const MODELS = {
  'large-v3-turbo-q5_0': { url: `${HF_URL}/ggml-large-v3-turbo-q5_0.bin`, size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  'large-v3-turbo': { url: `${HF_URL}/ggml-large-v3-turbo.bin`, size: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' },
  'small-q5_1': { url: `${HF_URL}/ggml-small-q5_1.bin`, size: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  'base-q5_1': { url: `${HF_URL}/ggml-base-q5_1.bin`, size: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
};

const DEFAULTS = {
  enabled: true,
  key: 'Space',            // KeyboardEvent.code of the push-to-talk key
  holdMs: 300,             // how long to hold before it counts as dictation rather than a space
  engine: 'local',         // local | openai | groq
  language: 'auto',        // auto | en | ru | de …
  device: '',              // part of a microphone name; empty = Windows default
  local: { build: 'auto', model: 'large-v3-turbo-q5_0', idleMinutes: 10, threads: 4 },
  openai: { apiKey: '', model: 'gpt-4o-mini-transcribe' },
  groq: { apiKey: '', model: 'whisper-large-v3-turbo' },
  prompt: 'Claude Code, git, commit, push, pull request, npm, SSH, Docker, deploy, API, терминал.',
  autoEnter: false,        // press Enter after inserting the text
  stripPeriod: true,       // drop the final period of a single sentence (handy for commands)
};

// Common whisper "hallucinations" on silence.
const JUNK = [
  /^продолжение следует\.*$/i, /субтитр/i, /^спасибо за просмотр/i, /^редактор субтитров/i,
  /^thanks for watching/i, /^\[?(music|музыка|blank_audio|тишина)\]?$/i, /^\.+$/, /^you$/i,
];

function mergeDeep(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? mergeDeep(base[k], v) : v;
  }
  return out;
}

// Asynchronous, so the GPU probe never blocks the main process (nvidia-smi can take seconds).
function hasNvidia() {
  return new Promise((resolve) => {
    try {
      childProcess.execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 4000 }, (err) => resolve(!err));
    } catch { resolve(false); }
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function findFile(dir, name) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_DELAYS = [100, 200, 400, 800, 1500, 2500]; // ~5.5 s in total

// fs.renameSync that waits out a short lock. On Windows an antivirus scanner (Defender) opens freshly
// written .exe/.dll files right away, and renaming their folder fails with EPERM/EACCES/EBUSY until it is done.
async function renameRetry(from, to, { rename = fs.renameSync, delays = RENAME_DELAYS } = {}) {
  for (let i = 0; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (i >= delays.length || !RETRY_CODES.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

// A write error in words the user can act on; the original code stays on the error.
function writeError(e, file) {
  const where = path.dirname(file);
  const msg = e.code === 'ENOSPC' ? `not enough free disk space for ${path.basename(file)} in ${where}`
    : `could not write ${file}: ${e.message}`;
  return Object.assign(new Error(msg), { code: e.code, cause: e });
}

// Download to dest.part, hashing on the fly; dest appears only if the SHA-256 matches.
// open (fs.createWriteStream) and rename are injectable for tests.
async function download(url, dest, { sha256, fetch: doFetch = fetch, open = fs.createWriteStream, rename } = {}, onProgress) {
  if (!sha256) throw new Error(`no checksum for ${url}`);
  const res = await doFetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = open(tmp);
  // A write error (disk full, no access) comes as an 'error' event: without a listener it would crash the
  // main process, and a write waiting for 'drain' would wait forever. Every wait below races with it.
  let failed = null;
  const failure = new Promise((_r, j) => out.once('error', (e) => { failed = writeError(e, tmp); j(failed); }));
  failure.catch(() => { /* rethrown where it is awaited */ });
  const hash = crypto.createHash('sha256');
  let got = 0;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      if (failed) throw failed;
      got += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await Promise.race([new Promise((r) => out.once('drain', r)), failure]);
      if (Date.now() - last > 250) { last = Date.now(); onProgress && onProgress(got, total); }
    }
    await Promise.race([new Promise((r, j) => out.end((e) => (e ? j(writeError(e, tmp)) : r()))), failure]);
    if (failed) throw failed;
    if (total && got !== total) throw new Error('download was interrupted');
    const actual = hash.digest('hex');
    if (actual !== sha256.toLowerCase()) {
      throw new Error(`${path.basename(dest)}: checksum mismatch (expected ${sha256}, got ${actual}). The file was deleted; try again, and report it if it keeps happening`);
    }
    await renameRetry(tmp, dest, { rename });
  } catch (e) {
    if (!out.closed) await new Promise((r) => { out.once('close', r); out.destroy(); });
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

// Windows' bsdtar can unpack zip archives. Asynchronous, so unpacking does not freeze the window.
function tar(args) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    childProcess.execFile(exe, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error('unpacking failed: ' + (String(stderr).trim() || err.message))) : resolve()));
  });
}

// The executable path of a running process, or null. Used to make sure a PID from the PID file is
// still our whisper-server before killing it (PIDs are reused).
function exePathOf(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    childProcess.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`],
      { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

class Dictation extends EventEmitter {
  // spawn, fetch, tar, hasNvidia, exePathOf, kill, rename: injectable for tests.
  constructor({ settings, baseDir, spawn, fetch: doFetch, tar: doTar, hasNvidia: probe, exePathOf: exeOf, kill, rename } = {}) {
    super();
    this.cfg = mergeDeep(DEFAULTS, settings.dictation || {});
    this.dir = baseDir;               // %LOCALAPPDATA%\Kolonka\whisper
    this.pidFile = path.join(baseDir, 'whisper-server.pid');
    this.proc = null;
    this.port = null;
    this.base = null;                 // http://127.0.0.1:<port>/<secret>
    this.ready = null;                // promise of the server start
    this.idleTimer = null;
    this.busy = false;
    this._spawn = spawn || childProcess.spawn;
    this._fetch = doFetch || ((...a) => fetch(...a));
    this._tar = doTar || tar;
    this._hasNvidia = probe || hasNvidia;
    this._exePathOf = exeOf || exePathOf;
    this._kill = kill || ((pid) => process.kill(pid));
    this._rename = rename || fs.renameSync;
    this._build = null;
    this._detecting = null;
    this._cleanup = null;
    this._gen = 0;
  }

  publicConfig() {
    const c = this.cfg;
    return { enabled: c.enabled, key: c.key, holdMs: c.holdMs, engine: c.engine, autoEnter: c.autoEnter, device: c.device, installed: this.isInstalled() };
  }

  // Probe the GPU once, in the background.
  detectBuild() {
    const b = this.cfg.local.build;
    if (b === 'cuda' || b === 'cpu') return Promise.resolve(b);
    if (!this._detecting) {
      this._detecting = Promise.resolve()
        .then(() => this._hasNvidia())
        .then((yes) => { this._build = yes ? 'cuda' : 'cpu'; }, () => { this._build = 'cpu'; })
        .then(() => this._build);
    }
    return this._detecting;
  }

  // The build to use: the one from settings, otherwise one already installed (the detected one first),
  // otherwise the detected one. Never blocks: before detection finishes it answers from the disk.
  build() {
    const b = this.cfg.local.build;
    if (b === 'cuda' || b === 'cpu') return b;
    const order = this._build === 'cpu' ? ['cpu', 'cuda'] : ['cuda', 'cpu'];
    for (const x of order) if (this.binReady(x)) return x;
    return this._build || 'cpu';
  }
  binDir(build = this.build()) { return path.join(this.dir, 'bin-' + build); }
  modelPath() { return path.join(this.dir, 'models', `ggml-${this.cfg.local.model}.bin`); }
  serverExe(build = this.build()) {
    const d = this.binDir(build);
    return fs.existsSync(d) ? findFile(d, 'whisper-server.exe') : null;
  }
  // whisper-server.exe and the libraries it needs are all in place.
  binReady(build) {
    const exe = this.serverExe(build);
    if (!exe) return false;
    const dir = path.dirname(exe);
    return [...COMMON_FILES, ...BUILDS[build].files].every((f) => fs.existsSync(path.join(dir, f)));
  }
  modelReady() {
    const p = this.modelPath();
    const m = MODELS[this.cfg.local.model];
    try {
      const st = fs.statSync(p);
      return st.isFile() && (!m || st.size === m.size);
    } catch { return false; }
  }
  isInstalled() {
    if (this.cfg.engine !== 'local') return true;
    return this.binReady(this.build()) && this.modelReady();
  }

  // Download the whisper.cpp build and the model (once).
  async install() {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      fs.mkdirSync(path.join(this.dir, 'models'), { recursive: true });
      await this.detectBuild();
      const build = this.build();
      if (!this.binReady(build)) {
        const src = BUILDS[build];
        const zip = path.join(this.dir, `whisper-${build}.zip`);
        if (fs.existsSync(zip) && (await sha256File(zip)) !== src.sha256) fs.unlinkSync(zip);
        if (!fs.existsSync(zip)) {
          await download(src.url, zip, { sha256: src.sha256, fetch: this._fetch, rename: this._rename }, (g, t) => this.emit('progress', { stage: build === 'cuda' ? 'whisper (CUDA)' : 'whisper', got: g, total: t }));
        }
        this.emit('progress', { stage: 'unpacking', got: 0, total: 0 });
        await this.unpack(zip, build);
        fs.unlinkSync(zip);
      }
      if (!this.modelReady()) {
        const m = MODELS[this.cfg.local.model];
        if (!m) throw new Error('unknown model ' + this.cfg.local.model);
        await download(m.url, this.modelPath(), { sha256: m.sha256, fetch: this._fetch, rename: this._rename }, (g, t) => this.emit('progress', { stage: 'model ' + this.cfg.local.model, got: g, total: t }));
      }
      this.emit('progress', { stage: 'done', got: 1, total: 1 });
    })();
    try { await this.installing; } finally { this.installing = null; }
  }

  // Unpack into a temporary folder, check it, then move the whole folder into place,
  // so an interrupted or broken unpack never looks like an installed build.
  async unpack(zip, build) {
    const final = this.binDir(build);
    const tmp = final + '.tmp';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await this._tar(['-xf', zip, '-C', tmp]);
      const exe = findFile(tmp, 'whisper-server.exe');
      if (!exe) throw new Error('whisper-server.exe not found in the whisper.cpp archive');
      const missing = [...COMMON_FILES, ...BUILDS[build].files].filter((f) => !fs.existsSync(path.join(path.dirname(exe), f)));
      if (missing.length) throw new Error('the whisper.cpp archive is incomplete, missing: ' + missing.join(', '));
      fs.rmSync(final, { recursive: true, force: true });
      await renameRetry(tmp, final, { rename: this._rename });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  // A whisper-server left over from a run that did not exit cleanly (crash, killed process) keeps the
  // model in memory. Kill it, but only if the PID still belongs to our whisper-server.exe.
  killOrphan() {
    if (this._cleanup) return this._cleanup;
    this._cleanup = (async () => {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')); } catch { return false; }
      const pid = Number(rec && rec.pid);
      let killed = false;
      if (Number.isInteger(pid) && pid > 0 && typeof rec.exe === 'string' && !(this.proc && this.proc.pid === pid)) {
        const ours = path.resolve(rec.exe).toLowerCase();
        const inDir = ours.startsWith(path.resolve(this.dir).toLowerCase() + path.sep);
        const actual = inDir ? await this._exePathOf(pid) : null;
        if (actual && path.resolve(actual).toLowerCase() === ours) {
          try { this._kill(pid); killed = true; } catch { /* already gone */ }
        }
      }
      if (!this.proc) this._removePid();
      return killed;
    })();
    return this._cleanup;
  }

  _writePid(pid, exe) {
    try { fs.writeFileSync(this.pidFile, JSON.stringify({ pid, exe })); } catch { /* not critical */ }
  }
  _removePid() { try { fs.unlinkSync(this.pidFile); } catch { /* none */ } }

  // Start whisper-server (the model is loaded once and kept in memory until idle).
  ensureServer() {
    if (!this.ready) {
      const ready = this._start();
      this.ready = ready;
      ready.catch(() => { if (this.ready === ready) this.ready = null; });
    }
    return this.ready;
  }

  async _start() {
    const gen = this._gen;
    if (this._cleanup) await this._cleanup.catch(() => {});
    await this.detectBuild();
    if (!this.isInstalled()) await this.install();
    const port = await freePort();
    if (gen !== this._gen) throw new Error('whisper-server start cancelled');
    // Every endpoint (/inference, /load, /health) lives under a random path: whisper-server answers any
    // local process and any web page (CORS *), and /load would let them swap the model.
    const secret = crypto.randomBytes(24).toString('hex');
    const exe = this.serverExe();
    const args = ['-m', this.modelPath(), '--host', '127.0.0.1', '--port', String(port), '-t', String(this.cfg.local.threads || 4), '--request-path', '/' + secret];
    if (this.build() === 'cpu') args.push('-ng');
    const p = this._spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.port = port;
    this.base = `http://127.0.0.1:${port}/${secret}`;
    let log = '';
    let gone = null;
    const onOut = (d) => { log = (log + d).slice(-4000); };
    if (p.stdout) p.stdout.on('data', onOut);
    if (p.stderr) p.stderr.on('data', onOut);
    p.on('error', (e) => { gone = gone || ('error: ' + e.message); this._gone(p, null); });
    p.on('exit', (code) => { gone = gone || ('code ' + code); this._gone(p, code); });
    if (p.pid) this._writePid(p.pid, exe);
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < 90000) {
        if (gone || this.proc !== p) throw new Error(`whisper-server exited (${gone || 'stopped'}): ` + log.split('\n').slice(-5).join(' '));
        if (await this._healthy(this.base)) { this.emit('server', { running: true }); return; }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('whisper-server did not start within 90 s');
    } catch (e) {
      if (this.proc === p) this.stopServer();
      throw e;
    }
  }

  // Ready means 200 and {"status":"ok"} from our own /health, not just any answer on the port.
  async _healthy(base) {
    try {
      const r = await this._fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.status !== 200) return false;
      const j = await r.json();
      return !!j && j.status === 'ok';
    } catch { return false; }
  }

  // The process ended or failed to start. Only the current process clears the state: an old one
  // exiting late must not forget a newer server.
  _gone(p, code) {
    if (this.proc !== p) return;
    clearTimeout(this.idleTimer);
    this.proc = null;
    this.ready = null;
    this.base = null;
    this._removePid();
    this.emit('server', { running: false, code });
  }

  touchIdle() {
    clearTimeout(this.idleTimer);
    const min = this.cfg.local.idleMinutes || 10;
    this.idleTimer = setTimeout(() => this.stopServer(), min * 60000);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stopServer() {
    this._gen++; // cancels a start that is still installing or picking a port
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = null;
    this.ready = null;
    this.base = null;
    if (p) {
      try { p.kill(); } catch { /* ignore */ }
      this._removePid();
    }
  }

  // Warm-up: called when dictation starts, so the model loads while the user is speaking.
  // The idle timer starts right away, so the model does not stay in memory if nothing is recognized.
  warm() {
    if (this.cfg.engine === 'local' && this.isInstalled()) this.ensureServer().then(() => this.touchIdle(), () => {});
  }

  async transcribe(wav) {
    const buf = Buffer.from(wav);
    let text;
    if (this.cfg.engine === 'local') text = await this._local(buf);
    else text = await this._cloud(buf);
    return this.clean(text);
  }

  async _local(buf) {
    await this.ensureServer();
    this.touchIdle();
    const base = this.base;
    if (!base) throw new Error('whisper-server stopped');
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    if (this.cfg.language && this.cfg.language !== 'auto') fd.append('language', this.cfg.language);
    else fd.append('language', 'auto');
    if (this.cfg.prompt) fd.append('prompt', this.cfg.prompt);
    fd.append('no_timestamps', 'true');
    try {
      const r = await this._fetch(`${base}/inference`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('whisper: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      return j.text || '';
    } finally {
      if (this.proc) this.touchIdle();
    }
  }

  async _cloud(buf) {
    const eng = this.cfg.engine;
    const c = this.cfg[eng];
    if (!c || !c.apiKey) throw new Error(`engine ${eng} needs an apiKey in settings.json → dictation.${eng}.apiKey`);
    const url = eng === 'groq' ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    fd.append('model', c.model);
    if (this.cfg.language && this.cfg.language !== 'auto') fd.append('language', this.cfg.language);
    if (this.cfg.prompt) fd.append('prompt', this.cfg.prompt);
    fd.append('response_format', 'json');
    const r = await this._fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + c.apiKey }, body: fd, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${eng}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).text || '';
  }

  clean(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (JUNK.some((re) => re.test(t))) return '';
    if (this.cfg.stripPeriod && /^[^.!?…]*\.$/.test(t)) t = t.slice(0, -1);
    return t;
  }

  // Secrets for scrubbing problem reports.
  secrets() { return [this.cfg.openai && this.cfg.openai.apiKey, this.cfg.groq && this.cfg.groq.apiKey].filter(Boolean); }
}

module.exports = { Dictation, DEFAULTS, BUILDS, MODELS, download, sha256File, renameRetry };
