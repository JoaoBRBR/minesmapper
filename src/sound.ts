// Tiny synthesised sound effects (no audio files). The AudioContext is created
// lazily on the first sound, which always happens inside a user gesture, as
// browsers (especially iOS) require.

import { settings } from './settings';

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function ctx(): AudioContext | null {
  if (!settings.sound) return null;
  try {
    if (!ac) {
      ac = new AudioContext();
      master = ac.createGain();
      master.gain.value = 0.55;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') void ac.resume();
    return ac;
  } catch {
    return null;
  }
}

function tone(
  c: AudioContext,
  freq: number,
  dur: number,
  { type = 'triangle', vol = 0.2, at = 0, to }: { type?: OscillatorType; vol?: number; at?: number; to?: number } = {},
) {
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(
  c: AudioContext,
  dur: number,
  { vol = 0.2, from = 800, to = 800, kind = 'bandpass' }: { vol?: number; from?: number; to?: number; kind?: BiquadFilterType } = {},
) {
  noiseBuf ??= (() => {
    const b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  })();
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = kind;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t);
  src.stop(t + dur + 0.02);
}

export const sound = {
  /** A single cell opened. */
  tick() {
    const c = ctx();
    if (c) tone(c, 560, 0.05, { vol: 0.18, to: 420 });
  },
  /** A region opened; `ms` is roughly how long the ripple animation runs. */
  open(ms: number) {
    const c = ctx();
    if (!c) return;
    const dur = Math.min(0.9, Math.max(0.18, ms / 1000));
    noise(c, dur, { vol: 0.16, from: 350, to: 2400 });
    tone(c, 420, dur * 0.8, { vol: 0.07, to: 840, type: 'sine' });
  },
  flag() {
    const c = ctx();
    if (!c) return;
    tone(c, 640, 0.06, { type: 'square', vol: 0.07 });
    tone(c, 900, 0.08, { type: 'square', vol: 0.07, at: 0.05 });
  },
  unflag() {
    const c = ctx();
    if (!c) return;
    tone(c, 520, 0.06, { type: 'square', vol: 0.06 });
    tone(c, 340, 0.08, { type: 'square', vol: 0.06, at: 0.05 });
  },
  boom() {
    const c = ctx();
    if (!c) return;
    noise(c, 0.9, { vol: 0.7, from: 2200, to: 60, kind: 'lowpass' });
    tone(c, 110, 0.6, { type: 'sine', vol: 0.8, to: 32 });
  },
  win() {
    const c = ctx();
    if (!c) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, f, 0.35, { vol: 0.16, at: i * 0.12 }));
    tone(c, 1046.5, 0.8, { type: 'sine', vol: 0.1, at: 0.5 });
  },
  /** A tap refused because it was too far from explored ground. */
  blocked() {
    const c = ctx();
    if (c) tone(c, 170, 0.14, { type: 'sawtooth', vol: 0.09, to: 120 });
  },
  /** A chunk was finished and tidied away. */
  clean() {
    const c = ctx();
    if (!c) return;
    [660, 880, 1100].forEach((f, i) => tone(c, f, 0.28, { type: 'sine', vol: 0.09, at: i * 0.08 }));
  },
  /** An oracle was found. */
  found() {
    const c = ctx();
    if (!c) return;
    [784, 988, 1175, 1568].forEach((f, i) => tone(c, f, 0.22, { type: 'sine', vol: 0.14, at: i * 0.07 }));
  },
  /** An ice clearer was used: a glassy sweep of tiny bells. */
  ice() {
    const c = ctx();
    if (!c) return;
    [1568, 1319, 1175, 988, 784, 659].forEach((f, i) =>
      tone(c, f, 0.5, { type: 'sine', vol: 0.1, at: i * 0.06, to: f * 1.01 }),
    );
    noise(c, 0.5, { vol: 0.04, from: 6000, to: 12000, kind: 'highpass' });
  },
  /** An oracle was spent. */
  oracle() {
    const c = ctx();
    if (!c) return;
    tone(c, 330, 0.5, { type: 'sine', vol: 0.14, to: 1320 });
    tone(c, 495, 0.5, { type: 'sine', vol: 0.08, to: 1980, at: 0.04 });
    noise(c, 0.4, { vol: 0.05, from: 3000, to: 9000, kind: 'highpass' });
  },
  /** Played when a toggle in settings is switched on. */
  test() {
    const c = ctx();
    if (c) tone(c, 700, 0.12, { vol: 0.2 });
  },
};
