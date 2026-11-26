'use strict';
/* Voice input: hold Space (or the key from settings.json → dictation.key) and speak.
   A short tap is a normal space. The transcript is pasted into the active tab, so it works with
   whatever runs there: bash, PowerShell, Claude Code, an ssh session on a server. */
/* global ICONS */

window.Dictation = (() => {
  const api = window.kolonka;
  let cfg = { enabled: false, key: 'Space', holdMs: 300, autoEnter: false, installed: false };
  let state = 'idle'; // idle | pending | starting | listening | processing | installing
  let holdTimer = null;
  let target = null; // { id, write(text), paste(text) }
  let startedAt = 0;
  let chunks = [];
  let peak = 0;
  let level = 0;
  let mic = null; // { stream, ctx, node }
  let micIdleTimer = null;
  let micOpening = null; // the pending openMic()
  let attempts = 0;      // presses that reached 'starting'; only the latest one may go on to listening
  let tick = null;
  let el = null;

  let t = (k) => k;
  function init(conf, hooks) {
    if (hooks && hooks.t) t = hooks.t;
    cfg = Object.assign(cfg, conf || {});
    target = null;
    Dictation.hooks = hooks;
    el = document.getElementById('dictate');
    api.dictation.onProgress((p) => {
      if (state !== 'installing') return;
      if (p.stage === 'done') return;
      const pct = p.total ? Math.floor((p.got / p.total) * 100) : null;
      const mb = (p.got / 1048576).toFixed(0);
      show('installing', t('dict.downloading', { stage: p.stage, progress: pct != null ? pct + '%' : mb + ' MB' }));
    });
    window.addEventListener('blur', () => {
      if (state === 'pending') { clearTimeout(holdTimer); state = 'idle'; }
      if (state === 'listening' || state === 'starting') stop();
    });
  }

  const enabled = () => cfg.enabled && localStorage.getItem('dictationOff') !== '1';
  function toggle() {
    const off = localStorage.getItem('dictationOff') === '1';
    localStorage.setItem('dictationOff', off ? '0' : '1');
    return off; // true = now enabled
  }

  // The modifier flags a modifier key sets on its own events; they do not count as "with a modifier"
  // when that key is the dictation key. AltRight is AltGr on many layouts: Ctrl+Alt.
  const OWN_MODS = {
    ControlLeft: ['ctrlKey'], ControlRight: ['ctrlKey'], ShiftLeft: ['shiftKey'], ShiftRight: ['shiftKey'],
    AltLeft: ['altKey'], AltRight: ['altKey', 'ctrlKey'], MetaLeft: ['metaKey'], MetaRight: ['metaKey'],
  };

  // Called from the terminal key handler. Returns true when the event is consumed.
  function handleKey(e, sess) {
    if (e.isComposing || e.keyCode === 229) return false; // an IME is composing
    if (!enabled() || e.code !== cfg.key) {
      // another key while Space is down but before the threshold: this is just typing
      if (state === 'pending' && e.type === 'keydown') flushTap();
      return false;
    }
    // busy downloading or transcribing: the key does its normal job (Space types a space)
    if (state === 'installing' || state === 'processing') return false;
    const own = OWN_MODS[cfg.key] || [];
    const mods = ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'].some((m) => e[m] && !own.includes(m));
    if (e.type === 'keydown') {
      if (mods && state === 'idle') return false;
      if (e.repeat || state !== 'idle') return state !== 'idle' || e.repeat;
      state = 'pending';
      target = sess;
      holdTimer = setTimeout(begin, cfg.holdMs);
      return true;
    }
    if (e.type === 'keyup') {
      if (state === 'pending') { flushTap(); return true; }
      if (state === 'listening' || state === 'starting') { stop(); return true; }
      return state !== 'idle';
    }
    return state !== 'idle'; // keypress
  }

  function flushTap() {
    clearTimeout(holdTimer);
    state = 'idle';
    if (target && cfg.key === 'Space') target.write(' ');
  }

  async function begin() {
    if (state !== 'pending') return;
    if (!cfg.installed) {
      state = 'idle';
      const ok = await api.cmd('confirm', {
        message: t('dict.installQ'),
        detail: t('dict.installDetail'),
        ok: t('dict.download'),
      });
      if (!ok) return;
      state = 'installing';
      show('installing', t('dict.preparing'));
      const r = await api.dictation.install();
      state = 'idle';
      if (r.error) { hide(); Dictation.hooks.toast(t('dict.title'), r.error); return; }
      cfg.installed = true;
      show('done', t('dict.ready'));
      setTimeout(() => { if (state === 'idle') hide(); }, 2500);
      return;
    }
    state = 'starting';
    const attempt = ++attempts;
    api.dictation.warm();
    show('starting', t('dict.mic'));
    try {
      await openMic();
    } catch (err) {
      if (attempt !== attempts) return; // a newer press owns the state
      state = 'idle';
      hide();
      Dictation.hooks.toast(t('dict.noMic'), t('dict.noMicDetail') + (err.message || ''));
      return;
    }
    // released while the microphone was opening (or a newer press took over): it must not stay open
    if (state !== 'starting' || attempt !== attempts) { scheduleMicClose(); return; }
    chunks = []; peak = 0; level = 0;
    startedAt = performance.now();
    state = 'listening';
    show('listening', t('dict.listening'));
    tick = setInterval(renderListening, 80);
  }

  async function stop() {
    if (state === 'starting') { state = 'idle'; hide(); return; }
    if (state !== 'listening') return;
    clearInterval(tick);
    const dur = (performance.now() - startedAt) / 1000;
    const data = chunks; chunks = [];
    state = 'processing';
    scheduleMicClose();
    if (dur < 0.35 || peak < 0.015) { state = 'idle'; flash(t('dict.silence')); return; }
    show('processing', t('dict.processing'));
    const wav = encodeWav(data, mic ? mic.ctx.sampleRate : 16000);
    const r = await api.dictation.transcribe(wav);
    state = 'idle';
    if (r.error) { hide(); Dictation.hooks.toast(t('dict.title'), r.error); return; }
    const text = (r.text || '').trim();
    if (!text) { flash(t('dict.unclear')); return; }
    hide();
    target.paste(text);
    if (cfg.autoEnter) setTimeout(() => target.write('\r'), 30);
  }

  // ---------- microphone ----------
  // A microphone that was unplugged or taken away ends its track: reopen it then.
  function micAlive() {
    return !!mic && mic.ctx.state !== 'closed' && mic.stream.getAudioTracks().some((tr) => tr.readyState === 'live');
  }
  function closeMic() {
    if (!mic) return;
    const m = mic;
    mic = null;
    try { m.stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
    try { m.ctx.close(); } catch { /* ignore */ }
  }
  // One opening at a time: a second press while getUserMedia is pending waits for the same one.
  function openMic() {
    clearTimeout(micIdleTimer);
    if (mic && micAlive()) return Promise.resolve();
    closeMic();
    if (!micOpening) micOpening = doOpenMic().finally(() => { micOpening = null; });
    return micOpening;
  }
  async function doOpenMic() {
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (cfg.device) {
      // pick a microphone by part of its name: settings.json → dictation.device, e.g. "HyperX"
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const want = String(cfg.device).toLowerCase();
      const dev = devs.find((d) => d.label.toLowerCase().includes(want));
      if (dev) audio.deviceId = { exact: dev.deviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (ev) => {
      if (state !== 'listening') return;
      const d = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      peak = Math.max(peak, rms);
      level = level * 0.6 + Math.min(1, rms * 9) * 0.4;
    };
    src.connect(node);
    node.connect(ctx.destination);
    mic = { stream, ctx, node };
  }
  // keep the microphone open for a minute after dictation so the next one starts instantly
  function scheduleMicClose() {
    clearTimeout(micIdleTimer);
    micIdleTimer = setTimeout(() => {
      if (!mic || state === 'listening' || state === 'starting') return;
      closeMic();
    }, 60000);
  }

  function encodeWav(parts, rate) {
    let len = 0;
    for (const p of parts) len += p.length;
    let pcm = new Float32Array(len);
    let o = 0;
    for (const p of parts) { pcm.set(p, o); o += p.length; }
    if (rate !== 16000) { pcm = resample(pcm, rate, 16000); rate = 16000; }
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }
  function resample(src, from, to) {
    const n = Math.round(src.length * to / from);
    const out = new Float32Array(n);
    const k = from / to;
    for (let i = 0; i < n; i++) {
      const x = i * k; const i0 = Math.floor(x); const f = x - i0;
      out[i] = (src[i0] || 0) * (1 - f) + (src[i0 + 1] || 0) * f;
    }
    return out;
  }

  // ---------- indicator ----------
  function show(kind, label) {
    if (!el) return;
    el.hidden = false;
    el.className = 'dk-' + kind;
    const icon = kind === 'listening' ? '<span class="dk-dot"></span>'
      : kind === 'done' ? `<span class="dk-ok">${ICONS.check}</span>`
        : '<span class="dk-spin"></span>';
    const bars = kind === 'listening' ? '<span class="dk-bars">' + '<i></i>'.repeat(7) + '</span>' : '';
    const time = kind === 'listening' ? '<span class="dk-time">0:00</span>' : '';
    el.innerHTML = `${icon}<span class="dk-label">${label}</span>${bars}${time}`;
  }
  function renderListening() {
    if (!el || state !== 'listening') return;
    const t = (performance.now() - startedAt) / 1000;
    const tm = el.querySelector('.dk-time');
    if (tm) tm.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const bars = el.querySelectorAll('.dk-bars i');
    bars.forEach((b, i) => {
      const center = 1 - Math.abs(i - 3) / 4;
      const h = 3 + Math.min(1, level * (0.55 + center * 0.6) * (0.75 + Math.random() * 0.5)) * 15;
      b.style.height = h.toFixed(1) + 'px';
    });
  }
  function hide() { if (el) el.hidden = true; }
  function flash(msg) {
    show('done', msg);
    el.className = 'dk-muted';
    setTimeout(() => { if (state === 'idle') hide(); }, 1300);
  }

  const Dictation = { init, handleKey, toggle, enabled, get state() { return state; }, get debug() { return { chunks: chunks.length, peak, mic: !!mic, rate: mic && mic.ctx.sampleRate }; } };
  return Dictation;
})();
