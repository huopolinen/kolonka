'use strict';
// The hold-to-talk key logic of src/renderer/dictation.js, run in a sandbox with a fake clock,
// a fake microphone and a fake window API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'dictation.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock() {
  let now = 0; let nextId = 1;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = nextId++; timers.set(id, { fn, at: now + (ms || 0), every }); return id; };
  return {
    get now() { return now; },
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms || 1),
    clear: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        const [id, tm] = next;
        now = tm.at;
        if (tm.every) tm.at += tm.every; else timers.delete(id);
        tm.fn();
      }
      now = end;
      await settle();
    },
  };
}

class FakeAudioContext {
  constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = {}; }
  createMediaStreamSource() { return { connect() {} }; }
  createScriptProcessor() { return { connect() {}, onaudioprocess: null }; }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

// opts.mic: 'now' (getUserMedia resolves at once) or 'manual' (resolve with open())
function load(cfg, { confirm = true, mic = 'now' } = {}) {
  const clock = fakeClock();
  const pill = { hidden: true, className: '', innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const store = new Map();
  const tracks = [];
  const pendingMics = [];
  const calls = { getUserMedia: 0 };
  const makeStream = () => {
    const tr = { readyState: 'live', stopped: false, stop() { this.readyState = 'ended'; this.stopped = true; } };
    tracks.push(tr);
    return { getTracks: () => [tr], getAudioTracks: () => [tr] };
  };
  const win = {
    kolonka: {
      cmd: async (name) => (name === 'confirm' ? confirm : null),
      dictation: {
        warm() {}, onProgress() {},
        install: () => new Promise(() => {}), // a download that takes a while
        transcribe: async () => ({ text: 'hello' }),
      },
    },
    addEventListener() {},
  };
  const navigator = {
    mediaDevices: {
      enumerateDevices: async () => [],
      getUserMedia: () => {
        calls.getUserMedia++;
        if (mic === 'now') return Promise.resolve(makeStream());
        return new Promise((resolve) => pendingMics.push(() => resolve(makeStream())));
      },
    },
  };
  const ctx = vm.createContext({
    window: win, document: { getElementById: () => pill },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    navigator, AudioContext: FakeAudioContext, performance: { now: () => clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear,
    ICONS: { check: '' }, console,
  });
  vm.runInContext(SRC, ctx);
  const D = win.Dictation;
  const written = [];
  const target = { id: 's1', write: (d) => written.push(d), paste: (d) => written.push(['paste', d]) };
  D.init(Object.assign({ enabled: true, key: 'Space', holdMs: 300, installed: true }, cfg), { toast() {}, t: (k) => k });
  const key = (type, code, extra) => D.handleKey(Object.assign({ type, code, key: code === 'Space' ? ' ' : '', repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, extra), target);
  return { D, clock, calls, tracks, written, key, openPendingMic: () => pendingMics.shift()() };
}

test('a short tap on Space types a space', async () => {
  const { D, key, clock, written } = load();
  assert.equal(key('keydown', 'Space'), true);
  await clock.advance(100);
  assert.equal(key('keyup', 'Space'), true);
  assert.deepEqual(written, [' ']);
  assert.equal(D.state, 'idle');
});

test('a modifier key works as the dictation key (ControlRight, AltRight)', async () => {
  const a = load({ key: 'ControlRight' });
  assert.equal(a.key('keydown', 'ControlRight', { ctrlKey: true }), true);
  assert.equal(a.D.state, 'pending');
  await a.clock.advance(300);
  assert.equal(a.D.state, 'listening');

  const b = load({ key: 'AltRight' });
  assert.equal(b.key('keydown', 'AltRight', { altKey: true, ctrlKey: true }), true, 'AltGr is Ctrl+Alt');
  assert.equal(b.D.state, 'pending');

  const c = load({ key: 'ShiftRight' });
  assert.equal(c.key('keydown', 'ShiftRight', { shiftKey: true, ctrlKey: true }), false, 'Ctrl+ShiftRight is a shortcut, not dictation');
});

test('Space with a modifier is not dictation', () => {
  const { D, key } = load();
  assert.equal(key('keydown', 'Space', { ctrlKey: true }), false);
  assert.equal(D.state, 'idle');
});

test('during an IME composition the key is not touched', () => {
  const { D, key } = load();
  assert.equal(key('keydown', 'Space', { isComposing: true }), false);
  assert.equal(key('keydown', 'Space', { keyCode: 229 }), false);
  assert.equal(D.state, 'idle');
});

test('while the model is downloading, Space is a normal space', async () => {
  const { D, key, clock } = load({ installed: false });
  key('keydown', 'Space');
  await clock.advance(300); // held: asks to download, the user agrees
  assert.equal(D.state, 'installing');
  key('keyup', 'Space');
  assert.equal(key('keydown', 'Space'), false, 'not swallowed');
  assert.equal(key('keypress', 'Space'), false);
  assert.equal(key('keyup', 'Space'), false);
});

test('released while the microphone opens: the microphone is closed later, not left open', async () => {
  const { D, key, clock, tracks, openPendingMic } = load({}, { mic: 'manual' });
  key('keydown', 'Space');
  await clock.advance(300);
  assert.equal(D.state, 'starting');
  key('keyup', 'Space');
  assert.equal(D.state, 'idle');
  openPendingMic();
  await settle();
  assert.equal(tracks.length, 1);
  await clock.advance(61000);
  assert.equal(tracks[0].stopped, true, 'the track is stopped by the idle timer');
});

test('a second press while the microphone is still opening does not open a second one', async () => {
  const { D, key, clock, calls, openPendingMic } = load({}, { mic: 'manual' });
  key('keydown', 'Space');
  await clock.advance(300);
  key('keyup', 'Space');
  key('keydown', 'Space');
  await clock.advance(300);
  assert.equal(D.state, 'starting');
  assert.equal(calls.getUserMedia, 1);
  openPendingMic();
  await settle();
  assert.equal(D.state, 'listening', 'the latest press goes on to listening');
});

test('a microphone whose track has ended is opened again', async () => {
  const { D, key, clock, calls, tracks } = load();
  key('keydown', 'Space');
  await clock.advance(300);
  assert.equal(D.state, 'listening');
  key('keyup', 'Space');
  await settle();
  assert.equal(D.state, 'idle');
  tracks[0].readyState = 'ended'; // unplugged
  key('keydown', 'Space');
  await clock.advance(300);
  assert.equal(calls.getUserMedia, 2);
  assert.equal(D.state, 'listening');
});
