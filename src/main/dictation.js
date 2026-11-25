'use strict';
// Voice input: speech recognition locally (whisper.cpp server) or through a cloud API.
// The renderer sends a WAV (16 kHz mono) and gets the text back.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const WHISPER_RELEASE = 'b5907';
const BUILDS = {
  cuda: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-win-cuda-12.4.0-x64.zip`,
  cpu: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-blas-bin-x64.zip`,
};
const MODELS = {
  'large-v3-turbo-q5_0': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  'large-v3-turbo': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  'small-q5_1': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  'base-q5_1': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
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

function hasNvidia() {
  try { execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', windowsHide: true, timeout: 4000 }); return true; } catch { return false; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
  }
  return null;
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - last > 250) { last = Date.now(); onProgress && onProgress(got, total); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (total && got !== total) throw new Error('download was interrupted');
  fs.renameSync(tmp, dest);
}

class Dictation extends EventEmitter {
  constructor({ settings, baseDir }) {
    super();
    this.cfg = mergeDeep(DEFAULTS, settings.dictation || {});
    this.dir = baseDir;               // %LOCALAPPDATA%\Kolonka\whisper
    this.proc = null;
    this.port = null;
    this.ready = null;                 // promise of the server start
    this.idleTimer = null;
    this.busy = false;
  }

  publicConfig() {
    const c = this.cfg;
    return { enabled: c.enabled, key: c.key, holdMs: c.holdMs, engine: c.engine, autoEnter: c.autoEnter, device: c.device, installed: this.isInstalled() };
  }

  build() {
    const b = this.cfg.local.build;
    if (b === 'cuda' || b === 'cpu') return b;
    if (this._build) return this._build;
    this._build = hasNvidia() ? 'cuda' : 'cpu';
    return this._build;
  }
  binDir() { return path.join(this.dir, 'bin-' + this.build()); }
  modelPath() { return path.join(this.dir, 'models', `ggml-${this.cfg.local.model}.bin`); }
  serverExe() {
    const d = this.binDir();
    return fs.existsSync(d) ? findFile(d, 'whisper-server.exe') : null;
  }
  isInstalled() {
    if (this.cfg.engine !== 'local') return true;
    return !!this.serverExe() && fs.existsSync(this.modelPath());
  }

  // Download the whisper.cpp build and the model (once).
  async install() {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      fs.mkdirSync(path.join(this.dir, 'models'), { recursive: true });
      const build = this.build();
      if (!this.serverExe()) {
        const zip = path.join(this.dir, `whisper-${build}.zip`);
        if (!fs.existsSync(zip)) {
          await download(BUILDS[build], zip, (g, t) => this.emit('progress', { stage: build === 'cuda' ? 'whisper (CUDA)' : 'whisper', got: g, total: t }));
        }
        this.emit('progress', { stage: 'unpacking', got: 0, total: 0 });
        fs.mkdirSync(this.binDir(), { recursive: true });
        // Windows' bsdtar can unpack zip archives
        execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', this.binDir()], { windowsHide: true });
        fs.unlinkSync(zip);
        if (!this.serverExe()) throw new Error('whisper-server.exe not found in the whisper.cpp archive');
      }
      if (!fs.existsSync(this.modelPath())) {
        const url = MODELS[this.cfg.local.model];
        if (!url) throw new Error('unknown model ' + this.cfg.local.model);
        await download(url, this.modelPath(), (g, t) => this.emit('progress', { stage: 'model ' + this.cfg.local.model, got: g, total: t }));
      }
      this.emit('progress', { stage: 'done', got: 1, total: 1 });
    })();
    try { await this.installing; } finally { this.installing = null; }
  }

  // Start whisper-server (the model is loaded once and kept in memory until idle).
  async ensureServer() {
    if (this.proc && this.ready) return this.ready;
    if (!this.isInstalled()) await this.install();
    this.port = await freePort();
    const exe = this.serverExe();
    const args = ['-m', this.modelPath(), '--host', '127.0.0.1', '--port', String(this.port), '-t', String(this.cfg.local.threads || 4)];
    if (this.build() === 'cpu') args.push('-ng');
    this.proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const onOut = (d) => { log = (log + d).slice(-4000); };
    this.proc.stdout.on('data', onOut);
    this.proc.stderr.on('data', onOut);
    this.proc.on('exit', (code) => { this.proc = null; this.ready = null; this.emit('server', { running: false, code }); });
    this.ready = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        if (!this.proc) throw new Error('whisper-server exited: ' + log.split('\n').slice(-5).join(' '));
        try {
          const r = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
          if (r.status < 500) { this.emit('server', { running: true }); return; }
        } catch { /* still loading */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('whisper-server did not start within 90 s');
    })();
    try { await this.ready; } catch (e) { this.stopServer(); throw e; }
    return this.ready;
  }

  touchIdle() {
    clearTimeout(this.idleTimer);
    const min = this.cfg.local.idleMinutes || 10;
    this.idleTimer = setTimeout(() => this.stopServer(), min * 60000);
  }

  stopServer() {
    clearTimeout(this.idleTimer);
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } }
    this.proc = null;
    this.ready = null;
  }

  // Warm-up: called when dictation starts, so the model loads while the user is speaking.
  warm() {
    if (this.cfg.engine === 'local' && this.isInstalled()) this.ensureServer().catch(() => {});
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
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    if (this.cfg.language && this.cfg.language !== 'auto') fd.append('language', this.cfg.language);
    else fd.append('language', 'auto');
    if (this.cfg.prompt) fd.append('prompt', this.cfg.prompt);
    fd.append('no_timestamps', 'true');
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('whisper: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return j.text || '';
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
    const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + c.apiKey }, body: fd, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${eng}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).text || '';
  }

  clean(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (JUNK.some((re) => re.test(t))) return '';
    if (this.cfg.stripPeriod && /^[^.!?…]*\.$/.test(t)) t = t.slice(0, -1);
    return t;
  }
}

module.exports = { Dictation, DEFAULTS };
