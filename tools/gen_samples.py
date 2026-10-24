"""Synthesize the bundled demo loops (royalty-free, made from scratch).

Usage: python3 tools/gen_samples.py public/samples
Requires numpy and ffmpeg on PATH.
"""
import os
import subprocess
import sys
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(7)


def t_axis(sec):
    return np.arange(int(sec * SR)) / SR


def biquad(x, kind, f, q=0.707):
    w0 = 2 * np.pi * f / SR
    a = np.sin(w0) / (2 * q)
    c = np.cos(w0)
    if kind == "lp":
        b = [(1 - c) / 2, 1 - c, (1 - c) / 2]
    elif kind == "hp":
        b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    else:  # bandpass, constant peak gain
        b = [a, 0, -a]
    a0, a1, a2 = 1 + a, -2 * c, 1 - a
    b0, b1, b2 = b[0] / a0, b[1] / a0, b[2] / a0
    a1, a2 = a1 / a0, a2 / a0
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(len(x)):
        xi = x[i]
        yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, xi, y1, yi
        y[i] = yi
    return y


def onepole_lp_env(x, cutoff_env):
    """One-pole lowpass with a per-sample cutoff (fast enough in a loop)."""
    y = np.zeros_like(x)
    s = 0.0
    k = 1 - np.exp(-2 * np.pi * cutoff_env / SR)
    for i in range(len(x)):
        s += k[i] * (x[i] - s)
        y[i] = s
    return y


def saw(freq, t, detune=0.0):
    ph = (freq * (1 + detune) * t) % 1.0
    return 2 * ph - 1


def place(buf, sound, at):
    i = int(at * SR)
    n = min(len(sound), len(buf) - i)
    if n > 0:
        buf[i:i + n] += sound[:n]


def kick():
    t = t_axis(0.5)
    f = 45 + 110 * np.exp(-t * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 7) * 1.0


def snare():
    t = t_axis(0.3)
    noise = rng.standard_normal(len(t))
    noise = biquad(noise, "hp", 1500)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)
    return (noise * 0.5 * np.exp(-t * 16) + tone * 0.6)


def hat(open_=False):
    t = t_axis(0.25 if open_ else 0.06)
    noise = biquad(rng.standard_normal(len(t)), "hp", 7000)
    return noise * np.exp(-t * (12 if open_ else 70)) * 0.35


def clap():
    t = t_axis(0.25)
    n = biquad(rng.standard_normal(len(t)), "bp", 1200, 1.2)
    env = np.zeros_like(t)
    for o in (0, 0.01, 0.02):
        env += np.where(t >= o, np.exp(-(t - o) * 60), 0)
    env += np.exp(-t * 14) * 0.6
    return n * env * 1.2


def mtof(m):
    return 440 * 2 ** ((m - 69) / 12)


def stereo(mono, width=0.0, delay_ms=0.0):
    d = int(delay_ms * SR / 1000)
    left = mono.copy()
    right = np.concatenate([np.zeros(d), mono[: len(mono) - d]]) if d else mono.copy()
    return np.stack([left * (1 - width * 0.3), right * (1 + width * 0.3) * (1 - width * 0.3)])


def feedback_delay(st, sec, fb=0.4, mix=0.35):
    d = int(sec * SR)
    out = st.copy()
    for k in range(1, 6):
        g = mix * fb ** (k - 1)
        sh = d * k
        if sh >= st.shape[1]:
            break
        # ping-pong
        ch = k % 2
        out[ch, sh:] += st[(ch + 1) % 2, : st.shape[1] - sh] * g
    return out


def normalize(st, peak=0.89):
    return st / (np.max(np.abs(st)) + 1e-9) * peak


def beat():
    bpm = 96
    beat_s = 60 / bpm
    bars = 4
    L = bars * 4 * beat_s
    buf = np.zeros(int(L * SR) + SR)
    k, s, h, ho = kick(), snare(), hat(), hat(True)
    kicks = [0, 1.5, 2.5, 2.75]
    for b in range(bars):
        base = b * 4 * beat_s
        for kb in kicks + ([3.5] if b % 2 else []):
            place(buf, k, base + kb * beat_s)
        for sb in (1, 3):
            place(buf, s * 0.8, base + sb * beat_s)
        for i in range(8):
            swing = 0.06 * beat_s if i % 2 else 0
            sound = ho if (i == 7 and b % 2) else h * (1 if i % 2 == 0 else 0.6)
            place(buf, sound, base + i * beat_s / 2 + swing)
    buf = np.tanh(buf * 1.3)
    st = stereo(buf, 0.0)
    return normalize(st[:, : int(L * SR)])


def arp():
    bpm = 118
    step = 60 / bpm / 4
    prog = [[57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67], [52, 56, 59, 64]]
    pattern = [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2]
    L = len(prog) * 16 * step * 2
    buf = np.zeros(int(L * SR) + SR)
    n = 0
    for rep in range(2):
        for chord in prog:
            for i in range(16):
                m = chord[pattern[i]] + (12 if (i % 8 == 7) else 0)
                t = t_axis(step * 1.6)
                f = mtof(m)
                osc = saw(f, t) * 0.6 + saw(f, t, 0.006) * 0.4 + np.sign(np.sin(2 * np.pi * f / 2 * t)) * 0.2
                cutoff = 300 + 4500 * np.exp(-t * 14) * (0.6 + 0.4 * np.sin(n / 9))
                tone = onepole_lp_env(onepole_lp_env(osc, cutoff), cutoff)
                env = np.minimum(1, t * 400) * np.exp(-t * 6)
                place(buf, tone * env, n * step)
                n += 1
    st = stereo(buf, 0.2)
    st = feedback_delay(st, step * 3, 0.45, 0.4)
    return normalize(st[:, : int(L * SR)])


def bass():
    bpm = 104
    beat_s = 60 / bpm
    step = beat_s / 4
    notes = [36, None, 36, 48, None, 36, 43, None, 46, None, 36, None, 41, 43, None, 34]
    bars = 4
    L = bars * 16 * step
    buf = np.zeros(int(L * SR) + SR)
    drums = np.zeros_like(buf)
    k, c, h = kick(), clap(), hat()
    for b in range(bars):
        for i, m in enumerate(notes):
            at = (b * 16 + i) * step
            if m is not None:
                mm = m + (3 if b == 2 else 0) + (-2 if b == 3 else 0)
                t = t_axis(step * 0.95)
                f = mtof(mm)
                osc = np.sign(np.sin(2 * np.pi * f * t)) * 0.5 + saw(f, t) * 0.5
                cutoff = 120 + 2400 * np.exp(-t * 22)
                tone = onepole_lp_env(onepole_lp_env(osc, cutoff), cutoff)
                env = np.minimum(1, t * 600) * np.minimum(1, (step * 0.95 - t) * 300)
                place(buf, tone * env * 1.4, at)
            if i % 4 == 0:
                place(drums, k * 0.8, at)
            if i in (4, 12):
                place(drums, c * 0.6, at)
            if i % 2 == 1:
                place(drums, h * 0.7, at)
    mix = np.tanh(buf * 1.8) * 0.8 + drums
    st = stereo(mix, 0.0)
    return normalize(st[:, : int(L * SR)])


def chords():
    sec_per = 4.0
    prog = [[50, 57, 62, 65, 69], [46, 53, 58, 62, 65], [43, 50, 55, 58, 62], [45, 52, 57, 61, 64]]
    L = sec_per * len(prog)
    buf_l = np.zeros(int(L * SR) + SR * 2)
    buf_r = np.zeros_like(buf_l)
    for ci, chord in enumerate(prog):
        t = t_axis(sec_per + 1.5)
        env = np.minimum(1, t / 0.8) * np.clip((sec_per + 1.5 - t) / 1.5, 0, 1)
        for vi, m in enumerate(chord):
            f = mtof(m)
            for d, side in ((-0.004, 0), (0.0, None), (0.005, 1)):
                v = saw(f, t + rng.random(), d) * 0.12
                v = v * env
                if side in (0, None):
                    place(buf_l, v, ci * sec_per)
                if side in (1, None):
                    place(buf_r, v, ci * sec_per)
    # slow filter sweep
    tt = np.arange(len(buf_l)) / SR
    cutoff = 500 + 1800 * (0.5 + 0.5 * np.sin(2 * np.pi * tt / 8))
    l = onepole_lp_env(onepole_lp_env(buf_l, cutoff), cutoff)
    r = onepole_lp_env(onepole_lp_env(buf_r, cutoff), cutoff)
    st = np.stack([l, r])
    st = feedback_delay(st, 0.375, 0.5, 0.3)
    return normalize(st[:, : int(L * SR)])


def vox():
    """Formant-synth 'singer' — great for hearing the pitch/speed split."""
    formants = {
        "a": [(800, 1.0, 80), (1150, 0.5, 90), (2900, 0.25, 120)],
        "o": [(450, 1.0, 70), (800, 0.4, 80), (2830, 0.15, 100)],
        "e": [(400, 1.0, 60), (1700, 0.4, 90), (2600, 0.25, 100)],
        "u": [(325, 1.0, 50), (700, 0.2, 60), (2530, 0.1, 100)],
    }
    melody = [(62, "o", 0.6), (64, "a", 0.3), (65, "a", 0.9), (69, "e", 0.6), (67, "o", 0.6),
              (65, "a", 1.2), (64, "u", 0.6), (62, "o", 0.6), (60, "a", 0.6), (62, "e", 1.8),
              (57, "o", 0.6), (60, "a", 0.6), (62, "a", 0.9), (65, "e", 0.3), (64, "o", 1.2), (62, "a", 2.4)]
    L = sum(d for _, _, d in melody) + 1.0
    out = np.zeros(int(L * SR) + SR)
    at = 0.0
    for m, vowel, dur in melody:
        t = t_axis(dur + 0.25)
        f0 = mtof(m) * (1 + 0.012 * np.sin(2 * np.pi * 5.2 * t) * np.minimum(1, t / 0.4))
        ph = np.cumsum(f0) / SR
        src = (ph % 1.0)
        src = 1 - 2 * src  # bright buzz
        src += rng.standard_normal(len(t)) * 0.04
        y = np.zeros_like(t)
        for f, g, bw in formants[vowel]:
            y += biquad(src, "bp", f, f / bw) * g
        env = np.minimum(1, t / 0.06) * np.clip((dur + 0.25 - t) / 0.25, 0, 1)
        place(out, y * env, at)
        at += dur
    st = stereo(out, 0.3, 11)
    st = feedback_delay(st, 0.31, 0.45, 0.25)
    return normalize(st[:, : int(L * SR)])


def write_mp3(st, path):
    pcm = (np.clip(st.T, -1, 1) * 32767).astype("<i2")
    wav = path.replace(".mp3", ".wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", "192k", path], check=True)
    os.remove(wav)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "public/samples"
    os.makedirs(out, exist_ok=True)
    for name, fn in [("beat", beat), ("arp", arp), ("bass", bass), ("chords", chords), ("vox", vox)]:
        print("rendering", name)
        write_mp3(fn(), os.path.join(out, f"{name}.mp3"))
