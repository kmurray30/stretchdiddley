// Granular stretch engine: independent pitch + speed, plus drive / fold / crush / stutter.
class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null;
    this.R = null;
    this.len = 0;
    this.ratio = 1; // source sample rate / context sample rate
    this.pos = 0;
    this.playing = false;
    this.G = Math.round(sampleRate * 0.05); // grain length
    this.hop = this.G >> 1; // 2x overlap → hann sum = 1
    this.last = null; // previous grain, used to phase-align the next one (WSOLA)
    this.ref = new Float32Array(64);
    this.counter = 0;
    this.grains = [];
    this.win = new Float32Array(this.G);
    for (let i = 0; i < this.G; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.G);

    // targets + smoothed values
    this.t = { speed: 1, pitch: 1, gain: 1, drive: 0, crush: 0, jitter: 0 };
    this.s = { ...this.t };
    this.hold = 0;
    this.holdL = 0;
    this.holdR = 0;
    this.reportCounter = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'load') {
        this.L = m.L;
        this.R = m.R || m.L;
        this.len = this.L.length;
        this.ratio = m.sr / sampleRate;
        this.pos = 0;
        this.grains.length = 0;
        this.counter = 0;
        this.last = null;
      } else if (m.type === 'play') this.playing = true;
      else if (m.type === 'stop') this.playing = false;
      else if (m.type === 'seek') {
        this.pos = Math.max(0, Math.min(1, m.at)) * this.len;
        this.last = null;
      } else if (m.type === 'params') Object.assign(this.t, m.p);
    };
  }

  read(buf, p) {
    const n = this.len;
    p %= n;
    if (p < 0) p += n;
    const i = p | 0;
    const f = p - i;
    const a = buf[i];
    const b = buf[i + 1 < n ? i + 1 : 0];
    return a + (b - a) * f;
  }

  // Find the offset near `target` whose waveform best continues the previous grain,
  // so overlapping grains add in phase instead of cancelling.
  align(target, natural, rate) {
    const M = this.ref.length;
    const step = 4 * rate;
    const ref = this.ref;
    for (let k = 0; k < M; k++) ref[k] = this.read(this.L, natural + k * step) + this.read(this.R, natural + k * step);
    const D = Math.round(this.ratio * sampleRate * 0.012);
    let best = 0, bestScore = -Infinity;
    for (let d = -D; d <= D; d += 2) {
      let num = 0, en = 1e-9;
      const base = target + d;
      for (let k = 0; k < M; k++) {
        const v = this.read(this.L, base + k * step) + this.read(this.R, base + k * step);
        num += v * ref[k];
        en += v * v;
      }
      const sc = num / Math.sqrt(en);
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    return target + best;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const N = oL.length;
    if (!this.L || !this.playing) {
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return true;
    }
    const s = this.s, t = this.t;
    const k = 0.0025;
    for (let i = 0; i < N; i++) {
      s.speed += (t.speed - s.speed) * k;
      s.pitch += (t.pitch - s.pitch) * k;
      s.gain += (t.gain - s.gain) * k;
      s.drive += (t.drive - s.drive) * k;
      s.crush += (t.crush - s.crush) * k;
      s.jitter += (t.jitter - s.jitter) * k;

      if (--this.counter <= 0) {
        this.counter = this.hop;
        const rate = s.pitch * this.ratio;
        let start = this.pos;
        if (s.jitter > 0.05) {
          start += (Math.random() - 0.5) * s.jitter * this.G * 6;
          // stutter: sometimes re-trigger from slightly behind (repeat)
          if (s.jitter > 0.3 && Math.random() < s.jitter * 0.5) start -= this.G * 4 * s.jitter;
        } else if (this.last) {
          const natural = this.last.start + this.hop * this.last.rate;
          start = Math.abs(natural - start) < 1 ? natural : this.align(start, natural, rate);
        }
        const gr = { start, rate, t: 0 };
        this.grains.push(gr);
        this.last = gr;
      }

      let l = 0, r = 0;
      for (let g = this.grains.length - 1; g >= 0; g--) {
        const gr = this.grains[g];
        const w = this.win[gr.t];
        const p = gr.start + gr.t * gr.rate;
        l += this.read(this.L, p) * w;
        r += this.read(this.R, p) * w;
        if (++gr.t >= this.G) this.grains.splice(g, 1);
      }

      // drive → tanh saturation blending into a wavefolder
      if (s.drive > 0.002) {
        const d = 1 + s.drive * 14;
        const fold = s.drive * s.drive;
        const comp = 1 / (1 + s.drive * 1.5);
        l = (Math.tanh(l * d) * (1 - fold) + Math.sin(l * d * 1.6) * fold) * comp;
        r = (Math.tanh(r * d) * (1 - fold) + Math.sin(r * d * 1.6) * fold) * comp;
      }
      // crush → sample-rate reduction + bit depth reduction
      if (s.crush > 0.002) {
        const holdN = 1 + Math.floor(s.crush * s.crush * 40);
        if (++this.hold >= holdN) {
          this.hold = 0;
          const q = Math.pow(2, 16 - s.crush * 13);
          this.holdL = Math.round(l * q) / q;
          this.holdR = Math.round(r * q) / q;
        }
        l = this.holdL;
        r = this.holdR;
      }

      oL[i] = l * s.gain;
      if (oR !== oL) oR[i] = r * s.gain;

      this.pos += s.speed * this.ratio;
      if (this.pos >= this.len) this.pos -= this.len;
      else if (this.pos < 0) this.pos += this.len;
    }

    if (++this.reportCounter >= 4) {
      this.reportCounter = 0;
      this.port.postMessage({ type: 'pos', at: this.pos / this.len, speed: s.speed, t: currentTime });
    }
    return true;
  }
}

registerProcessor('stretch-processor', StretchProcessor);
