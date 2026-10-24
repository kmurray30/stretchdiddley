(() => {
  'use strict';

  // ---------- constants ----------
  const SAMPLES = [
    { id: 'arp', label: 'arp', file: 'samples/arp.mp3', color: '#2f6bff' },
    { id: 'beat', label: 'beat', file: 'samples/beat.mp3', color: '#12b76a' },
    { id: 'vox', label: 'vox', file: 'samples/vox.mp3', color: '#f2f0ea' },
    { id: 'bass', label: 'bass', file: 'samples/bass.mp3', color: '#ff5b00' },
    { id: 'chords', label: 'chord', file: 'samples/chords.mp3', color: '#ff2a4d' },
  ];

  // heat palette for the screen: cool white → blue → green → yellow → orange → hot pink
  const HEAT = [
    [242, 240, 234],
    [47, 107, 255],
    [18, 210, 140],
    [255, 204, 0],
    [255, 91, 0],
    [255, 34, 102],
  ];

  const NEUTRAL = { pitch: 0, speed: 1, vol: 1, cutoff: 1, q: 0.7, drive: 0, crush: 0, jitter: 0 };

  const PARAMS = [
    { key: 'pitch', label: 'pitch', color: '#2f6bff', bi: true, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + 'st', norm: (v) => v / 24 },
    { key: 'speed', label: 'speed', color: '#12b76a', bi: true, fmt: (v) => '×' + (v < 1 ? v.toFixed(2) : v.toFixed(2)), norm: (v) => Math.log2(v) / 4 },
    { key: 'vol', label: 'vol', color: '#f2f0ea', bi: false, fmt: (v) => (v < 0.003 ? '-∞' : (Math.abs(20 * Math.log10(v)) < 0.05 ? '0.0' : (20 * Math.log10(v)).toFixed(1))) + 'db', norm: (v) => v / 2 },
    { key: 'cutoff', label: 'filter', color: '#ff5b00', bi: false, fmt: (v) => fmtHz(cutoffHz(v)), norm: (v) => v },
    { key: 'drive', label: 'drive', color: '#ff2a4d', bi: false, fmt: (v) => Math.round(v * 100) + '%', norm: (v) => v },
    { key: 'crush', label: 'crush', color: '#ffc400', bi: false, fmt: (v) => (16 - v * 13).toFixed(0) + 'bit', norm: (v) => v },
  ];

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const cutoffHz = (n) => 40 * Math.pow(18000 / 40, n);
  const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + 'k' : Math.round(hz) + 'hz');
  const fmtTime = (s) => {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return String(m).padStart(2, '0') + ':' + r.toFixed(2).padStart(5, '0');
  };
  function heat(t, a = 1) {
    t = clamp(t, 0, 1) * (HEAT.length - 1);
    const i = Math.min(HEAT.length - 2, Math.floor(t));
    const f = t - i;
    const c0 = HEAT[i], c1 = HEAT[i + 1];
    return `rgba(${Math.round(lerp(c0[0], c1[0], f))},${Math.round(lerp(c0[1], c1[1], f))},${Math.round(lerp(c0[2], c1[2], f))},${a})`;
  }
  function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  // ---------- state ----------
  const state = {
    ctx: null,
    node: null,
    filter: null,
    analyser: null,
    freq: null,
    playing: false,
    hold: false,
    sample: null,
    duration: 1,
    peaks: null,
    peakMax: 1,
    posAt: 0,
    posT: 0,
    posSpeed: 1,
    base: { ...NEUTRAL },
    cur: { ...NEUTRAL },
    target: { ...NEUTRAL },
    intensity: 0,
    level: 0,
    loading: false,
  };

  // pointers: id → {sx, sy, x, y, alive, vx, vy, ghost}
  const pointers = new Map();
  let order = []; // arrival order of live pointer ids
  let gesture = null; // snapshot at gesture start
  let mouseMods = { shift: false, alt: false };

  // ---------- DOM ----------
  const stage = $('#stage');
  const sctx = stage.getContext('2d');
  const ov = $('#overview');
  const octx = ov.getContext('2d');
  let W = 0, H = 0, DPR = 1, OW = 0, OH = 0;

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    const r = stage.getBoundingClientRect();
    W = r.width; H = r.height;
    stage.width = Math.round(W * DPR);
    stage.height = Math.round(H * DPR);
    const o = ov.getBoundingClientRect();
    OW = o.width; OH = o.height;
    ov.width = Math.round(OW * DPR);
    ov.height = Math.round(OH * DPR);
  }
  window.addEventListener('resize', resize);
  resize();

  // readouts
  const roEls = {};
  const roWrap = $('#readouts');
  for (const p of PARAMS) {
    const el = document.createElement('div');
    el.className = 'ro';
    el.innerHTML = `<div class="ro-head"><span class="dot" style="background:${p.color}"></span>${p.label}</div>
      <div class="ro-val">—</div><div class="ro-bar ${p.bi ? 'bi' : ''}"><div class="ro-fill" style="background:${p.color === '#f2f0ea' ? '#141414' : p.color}"></div></div>`;
    roWrap.appendChild(el);
    roEls[p.key] = { val: el.querySelector('.ro-val'), fill: el.querySelector('.ro-fill'), p };
  }

  // sample keys
  const sampleWrap = $('#samples');
  SAMPLES.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'key';
    b.dataset.id = s.id;
    b.innerHTML = `<span class="k-top">${s.label}</span><span class="k-sub"><span class="num" style="background:${s.color}"></span>${i + 1}</span>`;
    b.addEventListener('click', () => loadSample(s));
    sampleWrap.appendChild(b);
  });

  // ---------- audio ----------
  async function initAudio() {
    if (state.ctx) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('worklet.js');
    const node = new AudioWorkletNode(ctx, 'stretch-processor', { numberOfInputs: 0, outputChannelCount: [2] });
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 18000;
    filter.Q.value = 0.7;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    node.connect(filter).connect(limiter).connect(analyser).connect(ctx.destination);
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pos') {
        state.posAt = m.at;
        state.posT = m.t;
        state.posSpeed = m.speed;
      }
    };
    Object.assign(state, { ctx, node, filter, analyser, freq: new Uint8Array(analyser.frequencyBinCount), time: new Uint8Array(analyser.fftSize) });
  }

  async function decode(arrayBuf) {
    return await new Promise((res, rej) => {
      const p = state.ctx.decodeAudioData(arrayBuf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  function computePeaks(buf) {
    const block = 128;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const n = Math.ceil(L.length / block);
    const peaks = new Float32Array(n);
    let max = 0;
    for (let b = 0; b < n; b++) {
      let m = 0;
      const end = Math.min(L.length, (b + 1) * block);
      for (let i = b * block; i < end; i++) {
        const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (v > m) m = v;
      }
      peaks[b] = m;
      if (m > max) max = m;
    }
    state.peaks = peaks;
    state.peakMax = max || 1;
    state.peakRate = buf.sampleRate / block;
  }

  async function useBuffer(buf, name) {
    computePeaks(buf);
    state.duration = buf.duration;
    const L = new Float32Array(buf.getChannelData(0));
    const R = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : new Float32Array(L);
    state.node.port.postMessage({ type: 'load', L, R, sr: buf.sampleRate }, [L.buffer, R.buffer]);
    state.posAt = 0;
    state.posT = state.ctx.currentTime;
    $('#file-name').textContent = name;
    play(true);
  }

  async function loadSample(s) {
    await powerOn();
    if (state.loading) return;
    state.loading = true;
    document.querySelectorAll('#samples .key').forEach((k) => k.classList.toggle('active', k.dataset.id === s.id));
    try {
      const res = await fetch(s.file);
      const buf = await decode(await res.arrayBuffer());
      state.sample = s.id;
      await useBuffer(buf, s.label + '.mp3');
    } catch (err) {
      console.error(err);
      $('#file-name').textContent = 'load failed';
    } finally {
      state.loading = false;
    }
  }

  async function loadFile(file) {
    if (!file) return;
    await powerOn();
    state.loading = true;
    $('#file-name').textContent = 'decoding…';
    try {
      const buf = await decode(await file.arrayBuffer());
      document.querySelectorAll('#samples .key').forEach((k) => k.classList.remove('active'));
      state.sample = null;
      await useBuffer(buf, file.name);
    } catch (err) {
      console.error(err);
      $('#file-name').textContent = "can't decode that file";
    } finally {
      state.loading = false;
    }
  }

  function play(on) {
    if (!state.node) return;
    state.playing = on;
    state.node.port.postMessage({ type: on ? 'play' : 'stop' });
    if (on && state.ctx.state !== 'running') state.ctx.resume();
    $('#play-icon').textContent = on ? '■' : '▶';
    $('#play').classList.toggle('active', on);
  }

  let powered = false;
  async function powerOn() {
    if (powered) return;
    powered = true;
    await initAudio();
    await state.ctx.resume();
    $('#splash').classList.add('gone');
    if (!state.peaks) await loadSample(SAMPLES[0]);
  }

  $('#splash').addEventListener('click', () => powerOn());
  $('#file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('#play').addEventListener('click', async () => { await powerOn(); play(!state.playing); });
  $('#hold').addEventListener('click', () => setHold(!state.hold));
  $('#reset').addEventListener('click', reset);

  function setHold(on) {
    state.hold = on;
    $('#hold').classList.toggle('active', on);
    if (!on && order.length === 0) state.base = { ...NEUTRAL };
  }
  function reset() {
    state.base = { ...NEUTRAL };
    if (order.length) gesture = snapshot();
    if (state.node) state.node.port.postMessage({ type: 'seek', at: 0 });
  }

  // drag & drop
  const drop = $('#drop');
  window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('show'); });
  window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || e.clientX <= 0 || e.clientY <= 0) drop.classList.remove('show'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('show');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') mouseMods.shift = true;
    if (e.key === 'Alt') { mouseMods.alt = true; e.preventDefault(); }
    syncGhosts();
    if (e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); powerOn().then(() => play(!state.playing)); }
    else if (e.key === 'h' || e.key === 'H') setHold(!state.hold);
    else if (e.key === 'r' || e.key === 'R') reset();
    else if (/^[1-5]$/.test(e.key)) loadSample(SAMPLES[+e.key - 1]);
    else if (!powered && e.key === 'Enter') powerOn();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') mouseMods.shift = false;
    if (e.key === 'Alt') mouseMods.alt = false;
    syncGhosts();
  });
  window.addEventListener('blur', () => { mouseMods = { shift: false, alt: false }; syncGhosts(); });

  // ---------- gestures ----------
  function localXY(e) {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function snapshot() {
    const ids = order.slice(0, 3);
    const pts = ids.map((id) => pointers.get(id));
    const g = { base: { ...state.cur }, n: ids.length, ids, start: pts.map((p) => ({ x: p.x, y: p.y })) };
    if (pts.length >= 2) {
      g.dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      g.ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    }
    if (pts.length >= 3) g.area = triArea(pts) || 1;
    return g;
  }
  function triArea(p) {
    return Math.abs((p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y)) / 2;
  }

  function addPointer(id, x, y, ghost = false) {
    pointers.set(id, { sx: x, sy: y, x, y, vx: 0, vy: 0, alive: true, ghost, born: performance.now() });
    order.push(id);
    gesture = snapshot();
  }
  function removePointer(id) {
    const p = pointers.get(id);
    if (!p) return;
    p.alive = false;
    order = order.filter((o) => o !== id);
    if (order.length === 0) {
      // let go
      if (state.hold) state.base = { ...state.cur };
      else state.base = { ...NEUTRAL };
      gesture = null;
    } else {
      gesture = snapshot();
    }
  }

  // mouse ghosts: mirror the mouse around the screen center to fake extra fingers
  let mouseId = null;
  function ghostPos(x, y, k) {
    const cx = W / 2, cy = H / 2;
    const a = k === 'g1' ? (mouseMods.alt ? (2 * Math.PI) / 3 : Math.PI) : (-2 * Math.PI) / 3;
    const dx = x - cx, dy = y - cy;
    return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
  }
  function syncGhosts() {
    if (mouseId === null) return;
    const m = pointers.get(mouseId);
    if (!m) return;
    const want = [];
    if (mouseMods.shift || mouseMods.alt) want.push('g1');
    if (mouseMods.alt) want.push('g2');
    for (const k of ['g1', 'g2']) {
      const has = pointers.has(k) && pointers.get(k).alive;
      if (want.includes(k) && !has) {
        const [gx, gy] = ghostPos(m.x, m.y, k);
        addPointer(k, gx, gy, true);
      } else if (!want.includes(k) && has) removePointer(k);
    }
    // re-anchor ghost positions when mode changes
    for (const k of want) {
      const g = pointers.get(k);
      const [gx, gy] = ghostPos(m.x, m.y, k);
      g.x = gx; g.y = gy;
    }
  }

  stage.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    if (!powered) { powerOn(); return; }
    if (state.ctx && state.ctx.state !== 'running') state.ctx.resume();
    stage.setPointerCapture(e.pointerId);
    const [x, y] = localXY(e);
    addPointer(e.pointerId, x, y);
    if (e.pointerType === 'mouse') {
      mouseId = e.pointerId;
      mouseMods.shift = e.shiftKey;
      mouseMods.alt = e.altKey;
      syncGhosts();
    }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || !p.alive) return;
    const [x, y] = localXY(e);
    p.vx = x - p.x; p.vy = y - p.y;
    p.x = x; p.y = y;
    if (e.pointerId === mouseId) {
      for (const k of ['g1', 'g2']) {
        const g = pointers.get(k);
        if (g && g.alive) {
          const [gx, gy] = ghostPos(x, y, k);
          g.vx = gx - g.x; g.vy = gy - g.y;
          g.x = gx; g.y = gy;
        }
      }
    }
  });
  const up = (e) => {
    if (e.pointerId === mouseId) {
      removePointer('g2');
      removePointer('g1');
      mouseId = null;
    }
    removePointer(e.pointerId);
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  // overview seek
  let seeking = false;
  const seek = (e) => {
    if (!state.node) return;
    const r = ov.getBoundingClientRect();
    const at = clamp((e.clientX - r.left) / r.width, 0, 0.9999);
    state.node.port.postMessage({ type: 'seek', at });
    state.posAt = at;
    state.posT = state.ctx.currentTime;
  };
  ov.addEventListener('pointerdown', async (e) => { await powerOn(); seeking = true; ov.setPointerCapture(e.pointerId); seek(e); });
  ov.addEventListener('pointermove', (e) => { if (seeking) seek(e); });
  ov.addEventListener('pointerup', () => { seeking = false; });

  // compute target params from the live gesture
  function computeTarget() {
    if (!gesture || !order.length) return { ...state.base };
    const t = { ...gesture.base };
    {
      const S = Math.min(W, H);
      const g = gesture;
      const pts = g.ids.map((id) => pointers.get(id)).filter(Boolean);
      const n = pts.length;
      if (n === 0) return t;
      let dx = 0, dy = 0;
      pts.forEach((p, i) => { dx += p.x - g.start[i].x; dy += p.y - g.start[i].y; });
      dx /= n; dy /= n;
      t.pitch = clamp(g.base.pitch + (-dy / S) * 24, -24, 24);
      t.speed = Math.pow(2, clamp(Math.log2(g.base.speed) + (dx / S) * 3, -4, 2));
      if (n >= 2) {
        const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const r = d / g.dist;
        t.vol = clamp(g.base.vol * Math.pow(r, 1.3), 0, 2);
        const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        const th = angleDiff(ang, g.ang);
        t.cutoff = clamp(g.base.cutoff - Math.abs(th) / (Math.PI * 0.7), 0, 1);
        t.q = clamp(g.base.q + Math.abs(th) * 7, 0.7, 18);
      }
      if (n >= 3) {
        const p3 = pts[2], s3 = g.start[2];
        t.drive = clamp(g.base.drive + Math.abs(p3.y - s3.y) / S * 1.8, 0, 1);
        t.crush = clamp(g.base.crush + Math.abs(p3.x - s3.x) / S * 1.5, 0, 1);
        const ar = triArea(pts) / g.area;
        t.jitter = clamp(g.base.jitter + Math.abs(Math.log2(ar || 1e-3)) * 0.4, 0, 1);
      }
      if (order.length >= 4) t.jitter = 1;
    }
    return t;
  }

  function deviation(p) {
    return (
      Math.abs(p.pitch) / 18 +
      Math.abs(Math.log2(p.speed)) / 2.5 +
      Math.abs(p.vol - 1) * 0.6 +
      (1 - p.cutoff) * 0.9 +
      p.drive * 1.1 +
      p.crush +
      p.jitter * 0.8
    );
  }

  // ---------- render loop ----------
  let lastSent = 0;
  let lastFrame = performance.now();
  let tClock = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    tClock += dt;

    // params
    const target = computeTarget();
    const k = order.length ? 0.35 : state.hold ? 0.35 : 0.12; // spring back slower when released
    for (const key in state.cur) state.cur[key] = lerp(state.cur[key], target[key], k);
    const c = state.cur;
    if (state.node && now - lastSent > 16) {
      lastSent = now;
      state.node.port.postMessage({
        type: 'params',
        p: { speed: c.speed, pitch: Math.pow(2, c.pitch / 12), gain: c.vol, drive: c.drive, crush: c.crush, jitter: c.jitter },
      });
      const ct = state.ctx.currentTime;
      state.filter.frequency.setTargetAtTime(cutoffHz(c.cutoff), ct, 0.02);
      state.filter.Q.setTargetAtTime(c.q, ct, 0.02);
    }

    // released pointers spring back to their origin (jelly)
    for (const [id, p] of pointers) {
      if (p.alive) continue;
      const ax = (p.sx - p.x) * 0.18, ay = (p.sy - p.y) * 0.18;
      p.vx = (p.vx + ax) * 0.8;
      p.vy = (p.vy + ay) * 0.8;
      p.x += p.vx; p.y += p.vy;
      if (Math.hypot(p.sx - p.x, p.sy - p.y) < 0.6 && Math.hypot(p.vx, p.vy) < 0.3) pointers.delete(id);
    }

    // intensity
    let motion = 0;
    for (const p of pointers.values()) motion += Math.hypot(p.vx, p.vy) * (p.alive ? 1 : 0.3);
    const inten = clamp(deviation(c) * 0.55 + motion / 120, 0, 1.2);
    state.intensity = lerp(state.intensity, inten, 0.15);

    // level
    if (state.analyser) {
      state.analyser.getByteTimeDomainData(state.time);
      let sum = 0;
      for (let i = 0; i < state.time.length; i += 4) { const v = (state.time[i] - 128) / 128; sum += v * v; }
      state.level = lerp(state.level, Math.sqrt(sum / (state.time.length / 4)), 0.3);
      state.analyser.getByteFrequencyData(state.freq);
    }

    drawStage();
    drawOverview();
    updateReadouts();
    requestAnimationFrame(frame);
  }

  function playheadFrac() {
    if (!state.ctx || !state.playing) return state.posAt;
    const el = state.ctx.currentTime - state.posT;
    let f = state.posAt + (el * state.posSpeed) / state.duration;
    f -= Math.floor(f);
    return f;
  }

  function drawStage() {
    const g = sctx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const I = state.intensity;
    // background, faint heat tint
    g.fillStyle = '#0a0a0a';
    g.fillRect(0, 0, W, H);
    if (I > 0.05) {
      const grd = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      grd.addColorStop(0, heat(I, 0.12 * Math.min(1, I)));
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
    }

    // dot grid
    g.fillStyle = '#1f1f1f';
    const gs = 24;
    for (let y = gs / 2; y < H; y += gs) for (let x = gs / 2; x < W; x += gs) g.fillRect(x, y, 1.2, 1.2);

    const cy = H * 0.46;
    const c = state.cur;
    const live = [...pointers.values()];
    const S = Math.min(W, H);
    const sigma = S * (0.14 + 0.03 * order.length);
    const ptsWarp = live.map((p) => ({
      x: p.x, y: p.y,
      dx: p.x - p.sx, dy: p.y - p.sy,
      mag: Math.hypot(p.x - p.sx, p.y - p.sy) / S,
      w: p.alive ? 1 : 0.8,
    }));

    // waveform window around playhead
    const barW = W < 600 ? 3 : 4, gap = 2;
    const nb = Math.floor(W / (barW + gap));
    const win = 3.2; // seconds visible
    const head = playheadFrac() * state.duration;
    const ampH = H * 0.34;
    const crushSteps = c.crush > 0.02 ? Math.max(3, Math.round(24 - c.crush * 21)) : 0;
    const driveK = 1 + c.drive * 6;
    const ripple = I * 18;
    const ph = tClock * 6 * Math.max(0.2, c.speed);
    const pr = Math.pow(2, c.pitch / 12);

    if (state.peaks) {
      for (let j = 0; j < nb; j++) {
        const x0 = j * (barW + gap) + gap;
        const rel = (j - nb / 2) / nb;
        let tt = head + rel * win;
        tt = ((tt % state.duration) + state.duration) % state.duration;
        const pi = Math.floor(tt * state.peakRate);
        const span = Math.max(1, Math.floor((win / nb) * state.peakRate));
        let a = 0;
        for (let q = 0; q < span; q++) { const v = state.peaks[(pi + q) % state.peaks.length]; if (v > a) a = v; }
        a /= state.peakMax;

        // warp field
        let yOff = 0, xOff = 0, amp = 1, h = 0;
        for (const p of ptsWarp) {
          const d = x0 - p.x;
          const gw = Math.exp(-(d * d) / (2 * sigma * sigma)) * p.w;
          yOff += p.dy * gw * 0.9;
          xOff += p.dx * gw * 0.25;
          amp *= 1 + gw * p.mag * 3.2;
          h += gw * (p.mag * 2.2 + 0.15);
        }
        yOff += Math.sin(x0 * 0.035 * pr + ph) * ripple * Math.min(1, h + I * 0.3);
        amp *= c.vol;
        let v = a * amp;
        if (c.drive > 0.01) v = Math.tanh(v * driveK) / Math.tanh(driveK);
        if (crushSteps) v = Math.round(v * crushSteps) / crushSteps;
        if (c.jitter > 0.05) v *= 1 + (Math.random() - 0.5) * c.jitter * 1.2;
        const bh = clamp(v * ampH, 1.5, H * 0.44);
        const past = rel < 0;
        const col = heat(clamp(I * 0.85 + h * 0.6, 0, 1), past ? 0.38 : 1);
        g.fillStyle = col;
        const bx = x0 + xOff;
        if (crushSteps) {
          // dot-matrix bars when crushed
          const step = 6;
          for (let yy = 0; yy < bh; yy += step) {
            g.fillRect(bx, cy + yOff - yy - 3, barW, 3);
            g.fillRect(bx, cy + yOff + yy, barW, 3);
          }
        } else {
          g.fillRect(bx, cy + yOff - bh, barW, bh * 2);
        }
      }
    } else {
      g.fillStyle = '#333';
      g.fillRect(0, cy, W, 1);
    }

    // playhead
    g.fillStyle = '#ff5b00';
    g.fillRect(W / 2 - 1, 0, 2, H * 0.82);
    g.beginPath();
    g.moveTo(W / 2 - 6, 0); g.lineTo(W / 2 + 6, 0); g.lineTo(W / 2, 8); g.closePath(); g.fill();

    // spectrum dots
    if (state.freq) {
      const cols = Math.min(64, Math.floor(W / 12));
      const base = H - 8;
      const maxRows = Math.floor((H * 0.14) / 6);
      const bins = state.freq.length;
      for (let i = 0; i < cols; i++) {
        const f0 = Math.floor(Math.pow(bins, i / cols));
        const f1 = Math.max(f0 + 1, Math.floor(Math.pow(bins, (i + 1) / cols)));
        let m = 0;
        for (let b = f0; b < f1 && b < bins; b++) m = Math.max(m, state.freq[b]);
        const rows = Math.round((m / 255) * maxRows);
        const x = (i + 0.5) * (W / cols);
        for (let r = 0; r < maxRows; r++) {
          g.fillStyle = r < rows ? heat(clamp(r / maxRows * 0.6 + I * 0.6, 0, 1)) : '#191919';
          g.fillRect(x - 2, base - r * 6, 4, 3);
        }
      }
    }

    // finger shape
    const alivePts = order.map((id) => pointers.get(id)).filter(Boolean);
    if (alivePts.length >= 2) {
      g.beginPath();
      alivePts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fillStyle = heat(I, 0.12);
      g.fill();
      g.strokeStyle = heat(I, 0.8);
      g.lineWidth = 1.5;
      g.setLineDash([4, 4]);
      g.stroke();
      g.setLineDash([]);
    }

    // finger markers
    g.font = '500 10px "IBM Plex Mono", monospace';
    g.textBaseline = 'middle';
    let idx = 0;
    for (const id of order) {
      const p = pointers.get(id);
      if (!p) continue;
      idx++;
      const col = heat(clamp(I + 0.1, 0, 1));
      // crosshair lines
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, p.y); g.lineTo(W, p.y); g.moveTo(p.x, 0); g.lineTo(p.x, H); g.stroke();
      // drag vector
      g.strokeStyle = col;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(p.sx, p.sy); g.lineTo(p.x, p.y); g.stroke();
      g.fillStyle = col;
      g.fillRect(p.sx - 2, p.sy - 2, 4, 4);
      // ring
      const rr = 22 + Math.min(30, Math.hypot(p.vx, p.vy) * 2);
      g.lineWidth = 2;
      g.beginPath(); g.arc(p.x, p.y, rr, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2f0ea';
      const lbl = (p.ghost ? 'G' : 'T') + idx + (idx === 1 ? ' pitch·speed' : idx === 2 ? ' vol·filter' : idx === 3 ? ' drive·crush' : ' chaos');
      const tw = g.measureText(lbl).width;
      const lx = p.x + rr + 6 + tw > W - 8 ? p.x - rr - 6 - tw : p.x + rr + 6;
      g.fillText(lbl.toUpperCase(), lx, p.y - rr * 0.6 + (idx - 1) * 12);
    }

    // corner readouts
    g.fillStyle = '#6b6a66';
    g.textBaseline = 'top';
    g.fillText(`${(c.pitch >= 0 ? '+' : '') + c.pitch.toFixed(1)}ST  ×${c.speed.toFixed(2)}  ${fmtHz(cutoffHz(c.cutoff)).toUpperCase()}`, 10, 10);
    g.textAlign = 'right';
    g.fillText(`${order.length} TOUCH${order.length === 1 ? '' : 'ES'}  ${state.hold ? 'HOLD' : 'SPRING'}`, W - 10, 10);
    g.textAlign = 'left';

    if (powered && order.length === 0 && I < 0.04) {
      g.fillStyle = '#4a4945';
      g.textAlign = 'center';
      g.fillText('DRAG ANYWHERE · USE 2–3 FINGERS FOR MORE', W / 2, H * 0.82 - 14);
      g.textAlign = 'left';
    }
  }

  function drawOverview() {
    const g = octx;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, OW, OH);
    if (!state.peaks) return;
    const n = Math.floor(OW / 3);
    const head = playheadFrac();
    const per = state.peaks.length / n;
    for (let i = 0; i < n; i++) {
      let m = 0;
      const s0 = Math.floor(i * per), s1 = Math.floor((i + 1) * per);
      for (let s = s0; s < s1; s++) if (state.peaks[s] > m) m = state.peaks[s];
      const h = Math.max(1, (m / state.peakMax) * (OH - 4));
      g.fillStyle = i / n < head ? '#141414' : '#a9a59c';
      g.fillRect(i * 3, (OH - h) / 2, 2, h);
    }
    g.fillStyle = '#ff5b00';
    g.fillRect(head * OW - 1, 0, 2, OH);
    $('#clock').textContent = fmtTime(head * state.duration) + ' / ' + fmtTime(state.duration);
  }

  function updateReadouts() {
    const c = state.cur;
    for (const key in roEls) {
      const { val, fill, p } = roEls[key];
      const v = c[key];
      val.textContent = p.fmt(v);
      const n = p.norm(v);
      if (p.bi) {
        const nn = clamp(n, -1, 1) * 50;
        fill.style.left = (nn < 0 ? 50 + nn : 50) + '%';
        fill.style.width = Math.abs(nn) + '%';
      } else {
        fill.style.left = '0%';
        fill.style.width = clamp(n, 0, 1) * 100 + '%';
      }
    }
    $('#led').classList.toggle('on', state.playing && state.level > 0.08);
  }

  requestAnimationFrame(frame);
})();
