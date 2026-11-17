// Generative background music, built on Strudel (strudel.cc) and played by its Web Audio engine.
//
// * A looping background (pads, bass, soft textures) runs all the time, in one of three styles.
// * Player actions add notes on top, always inside the same key and motif:
//     flag            -> one note of the scale (the motif steps forward with every flag)
//     small area open -> a quick arpeggio of the current chord
//     chunk finished  -> a victorious little phrase that resolves on the tonic
//     island cleared  -> the same phrase, bigger
// * The biome colours the sound: desert = phrygian-dominant scale + drone + frame drum,
//   ice = glassy bells with a long echo. The background shifts a little too.
// * Everything is quantised to the music: an action is held until the next free beat division and
//   then played by the *same scheduler* as the background, so it is exactly in time.
//
// This module is loaded lazily (see musicBridge.ts) because Strudel is large.

import { Fraction, Hap, Pattern, TimeSpan, note, s, sine, stack } from '@strudel/core';
import { miniAllStrings } from '@strudel/mini';
import { getAudioContext, getSuperdoughAudioController, initAudio, registerSynthSounds, webaudioRepl } from '@strudel/webaudio';
import type { MusicStyle } from './settings';

// Let plain strings such as note('<[55,59] [60,64]>') use Strudel's mini-notation.
miniAllStrings();

export type MusicStyleId = MusicStyle;
export type Mood = 'default' | 'desert' | 'ice';

/** The music clock: one cycle is one bar of four beats, split into this many ticks. */
const TICKS = 96;
const BEAT = TICKS / 4;
const EIGHTH = TICKS / 8;

const PHRYGIAN_DOMINANT = [0, 1, 4, 5, 7, 8, 10]; // the "Egyptian" colour used in deserts

interface Style {
  id: MusicStyleId;
  bpm: number;
  /** Tonic (MIDI) for melodies, and the home scale as semitone steps. */
  root: number;
  scale: number[];
  /** One chord (MIDI notes) and one bass note per bar. */
  chords: number[][];
  bass: number[];
  /** Scale-degree indices (can run past the scale into the next octave). */
  motif: number[];
  victory: number[];
  /** The resolving chord of the victory phrase. */
  tonic: number[];
  background(mood: Mood): any;
}

// --- helpers ------------------------------------------------------------------------------------

const degreeToMidi = (root: number, scale: number[], degree: number) =>
  root + scale[((degree % scale.length) + scale.length) % scale.length] + 12 * Math.floor(degree / scale.length);

/** `<[a,b,c] [d,e,f]>` from one chord per bar. */
const chordBars = (chords: number[][]) => `<${chords.map((c) => `[${c.join(',')}]`).join(' ')}>`;
/** `<a b c d>` from one note per bar. */
const noteBars = (notes: number[]) => `<${notes.join(' ')}>`;
/** `<[a b ~ c] ...>`: eight steps per bar, `null` is a rest. */
const stepBars = (bars: (number | null)[][]) =>
  `<${bars.map((bar) => `[${bar.map((n) => (n === null ? '~' : n)).join(' ')}]`).join(' ')}>`;

// --- the three styles -----------------------------------------------------------------------------

const DAWN: Style = {
  id: 'dawn',
  bpm: 74,
  root: 72,
  scale: [0, 2, 4, 7, 9],
  chords: [
    [55, 59, 62, 64], // Cmaj9
    [60, 64, 67, 71], // Am9
    [57, 60, 64, 67], // Fmaj9
    [59, 62, 65, 69], // G9
  ],
  bass: [36, 45, 41, 43],
  motif: [0, 1, 2, 1, 3, 2, 1, 0],
  victory: [0, 1, 2, 3, 4, 5, 4, 5],
  tonic: [60, 64, 67, 72],
  background(mood) {
    const chords = chordBars(this.chords);
    return stack(
      // soft pad
      note(chords).s('sine').attack(0.5).release(1.8).lpf(1500).gain(0.1).room(0.4),
      // rhodes-like comping
      note(chords).s('triangle').struct('x ~ ~ [~ x] ~ ~ ~ ~').decay(0.6).sustain(0).release(0.3).lpf(1900).gain(0.15).room(0.45),
      // bass
      note(noteBars(this.bass)).s('sine').struct('x ~ ~ ~ ~ ~ [~ x] ~').attack(0.01).decay(0.5).sustain(0.3).release(0.4).lpf(280).gain(0.5),
      // lo-fi hats and vinyl crackle
      s('white').struct('~ x ~ x ~ x ~ x').decay(0.025).sustain(0).hpf(7000).gain(0.04),
      s('crackle').density(0.1).gain(0.2),
      // a ghost of melody
      note(stepBars([[null, 84, null, null, null, null, 79, null], [null, null, 81, null, null, null, null, null], [null, 79, null, null, 76, null, null, null], [null, null, null, 83, null, null, null, null]]))
        .s('sine').decay(0.8).sustain(0).delay(0.45).delaytime(0.4).delayfeedback(0.5).gain(0.06),
      moodLayer(this, mood),
    );
  },
};

const CLOISTER: Style = {
  id: 'cloister',
  bpm: 56,
  root: 74,
  scale: [0, 2, 3, 5, 7, 9, 10],
  chords: [
    [57, 62, 65, 69], // Dm
    [58, 62, 65, 69], // Bb
    [57, 60, 64, 65], // F
    [55, 62, 64, 67], // C add9
  ],
  bass: [38, 34, 41, 36],
  motif: [0, 2, 4, 2, 5, 4, 2, 1],
  victory: [0, 2, 4, 5, 6, 7, 6, 7],
  tonic: [62, 69, 74, 77],
  background(mood) {
    const chords = chordBars(this.chords);
    return stack(
      // string pad, slowly breathing
      note(chords).s('sawtooth').attack(1.4).release(2.6).lpf(sine.range(650, 1150).slow(8)).gain(0.085).room(0.6),
      // harp arpeggio
      note(stepBars([
        [57, 62, 65, 69, 74, 69, 65, 62],
        [58, 62, 65, 69, 74, 69, 65, 62],
        [57, 60, 65, 69, 72, 69, 65, 60],
        [55, 60, 64, 67, 72, 67, 64, 60],
      ])).s('triangle').decay(0.55).sustain(0).release(0.3).lpf(3200).gain(0.11).room(0.55).delay(0.25).delaytime(0.32).delayfeedback(0.4),
      // bass
      note(noteBars(this.bass)).s('sine').attack(0.08).release(1.8).lpf(300).gain(0.42),
      moodLayer(this, mood),
    );
  },
};

const DEEP: Style = {
  id: 'deep',
  bpm: 48,
  root: 77,
  scale: [0, 2, 4, 6, 7, 9, 11],
  chords: [
    [57, 60, 64, 69], // Fmaj7
    [59, 62, 67, 71], // G
    [57, 60, 64, 67], // Am7
    [60, 64, 67, 72], // C
  ],
  bass: [41, 43, 45, 36],
  motif: [0, 2, 4, 2, 5, 3, 1, 0],
  victory: [0, 2, 4, 6, 7, 6, 4, 7],
  tonic: [65, 69, 72, 76],
  background(mood) {
    const chords = chordBars(this.chords);
    return stack(
      note(chords).s('sawtooth').attack(2.2).release(3.2).lpf(sine.range(450, 1300).slow(16)).gain(0.075).room(0.8),
      note(chords).s('sine').attack(1.6).release(3).gain(0.05).room(0.85).add(note(12)),
      note(noteBars(this.bass)).s('sine').attack(0.4).release(2.4).lpf(260).gain(0.45),
      // sparse bells, drowned in echo
      note(stepBars([[null, null, null, null, 84, null, null, null], [null, null, 88, null, null, null, null, null], [null, null, null, null, null, 81, null, null], [86, null, null, null, null, null, 79, null]]))
        .s('sine').fmi(1.2).fmh(2).decay(1.6).sustain(0).delay(0.6).delaytime(0.5).delayfeedback(0.6).room(0.9).gain(0.07),
      moodLayer(this, mood),
    );
  },
};

const STYLES: Record<MusicStyleId, Style> = { dawn: DAWN, cloister: CLOISTER, deep: DEEP };

/** The extra layer a biome adds to the background (empty in the default mood). */
function moodLayer(style: Style, mood: Mood) {
  if (mood === 'desert') {
    const orn = (d: (number | null)[]) => d.map((x) => (x === null ? null : degreeToMidi(style.root - 12, PHRYGIAN_DOMINANT, x)));
    return stack(
      // low drone on the root and fifth
      note(`[${style.root - 36},${style.root - 29}]`).s('sawtooth').attack(2).release(2.5).lpf(420).gain(0.06),
      // ornamented little phrases in the Egyptian scale
      note(stepBars([orn([null, 0, 1, null, 2, null, 1, 0]), orn([3, null, 2, null, 1, 0, null, null]), orn([null, 0, 2, 3, null, 2, 1, null]), orn([1, null, 0, null, null, 1, 0, null])]))
        .s('triangle').decay(0.3).sustain(0).release(0.25).lpf(3000).gain(0.1).delay(0.3).delaytime(0.3).delayfeedback(0.35),
      // frame drum
      s('white').struct('x ~ ~ x ~ x ~ ~').decay(0.1).sustain(0).lpf(480).gain(0.09),
    );
  }
  if (mood === 'ice') {
    const high = (d: (number | null)[]) => d.map((x) => (x === null ? null : degreeToMidi(style.root + 12, style.scale, x)));
    return stack(
      // glass bells drifting in a long echo
      note(stepBars([high([null, 4, null, null, 2, null, null, null]), high([null, null, 5, null, null, 3, null, null]), high([2, null, null, null, 4, null, 6, null]), high([null, null, 3, null, null, null, 1, null])]))
        .s('sine').fmi(2.5).fmh(3).attack(0.002).decay(1.4).sustain(0).hpf(500).delay(0.55).delaytime(0.42).delayfeedback(0.6).room(0.9).gain(0.06),
      // high airy shimmer
      note(`[${style.root + 19},${style.root + 24}]`).s('sine').attack(2.5).release(3).hpf(900).gain(0.03).room(0.9),
    );
  }
  return stack();
}

/** Extra introspection for tests: always in dev, and in production with `?debug` in the URL. */
const DEBUG = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');

// --- live (player-driven) events -----------------------------------------------------------------

interface LiveEvent {
  /** Start and length, in ticks (1/96 of a bar). */
  at: number;
  dur: number;
  value: Record<string, unknown>;
  kind: string;
}

let events: LiveEvent[] = [];
/** Dev-only record of what was scheduled, so tests can check the timing. */
const eventLog: { kind: string; at: number; note?: unknown; flavor: string }[] = [];

const livePattern = new Pattern((state: any) => {
  const begin = state.span.begin.valueOf() * TICKS;
  const end = state.span.end.valueOf() * TICKS;
  const haps: any[] = [];
  for (const ev of events) {
    if (ev.at < begin - 1e-6 || ev.at >= end - 1e-6) continue;
    const whole = new TimeSpan(Fraction(ev.at).div(TICKS), Fraction(ev.at + ev.dur).div(TICKS));
    const partEnd = whole.end.lt(state.span.end) ? whole.end : state.span.end;
    haps.push(new Hap(whole, new TimeSpan(whole.begin, partEnd), { ...ev.value }));
  }
  // forget what is long gone
  if (events.length && events[0].at < begin - TICKS * 4) events = events.filter((e) => e.at >= begin - TICKS * 4);
  return haps;
});

// --- engine state --------------------------------------------------------------------------------

let repl: any = null;
let starting: Promise<void> | null = null;
let styleId: MusicStyleId = 'dawn';
let mood: Mood = 'default';
let flagStep = 0;
let lastMoodChange = 0;

const style = () => STYLES[styleId];
const secondsPerBeat = () => 60 / style().bpm;

/** First tick that is on `grid`, not yet handed to the scheduler, and not before `notBefore`. */
function nextSlot(grid: number, notBefore = 0): number {
  const sched = repl.scheduler;
  const earliest = Math.max(sched.lastEnd * TICKS + 0.5, notBefore);
  return Math.ceil(earliest / grid) * grid;
}

function chordAt(tick: number): number[] {
  const st = style();
  return st.chords[Math.floor(tick / TICKS + 0.02) % st.chords.length];
}

// Voices -------------------------------------------------------------------------------------------

type Flavor = 'default' | 'desert' | 'ice';

function voice(flavor: Flavor, role: 'note' | 'pad'): Record<string, unknown> {
  const st = style();
  const echo = secondsPerBeat() * 0.75;
  if (role === 'pad') {
    return { s: 'sawtooth', attack: 0.25, decay: 0.6, sustain: 0.7, release: 2.4, lpf: 1500, gain: 0.12, room: 0.7 };
  }
  if (flavor === 'desert') {
    return { s: 'triangle', attack: 0.003, decay: 0.32, sustain: 0, release: 0.3, lpf: 3400, hpf: 200, gain: 0.3, room: 0.3, delay: 0.3, delaytime: echo, delayfeedback: 0.35 };
  }
  if (flavor === 'ice') {
    return { s: 'sine', fmi: 3, fmh: 3.5, attack: 0.002, decay: 1.4, sustain: 0, release: 1.6, hpf: 450, gain: 0.22, room: 0.9, delay: 0.45, delaytime: echo * 1.33, delayfeedback: 0.6 };
  }
  if (st.id === 'deep') {
    return { s: 'sine', fmi: 1.4, fmh: 2, attack: 0.004, decay: 1.2, sustain: 0, release: 1.2, gain: 0.26, room: 0.8, delay: 0.4, delaytime: echo * 1.33, delayfeedback: 0.5 };
  }
  if (st.id === 'cloister') {
    return { s: 'triangle', attack: 0.004, decay: 0.9, sustain: 0, release: 0.8, lpf: 3200, gain: 0.28, room: 0.6, delay: 0.25, delaytime: echo, delayfeedback: 0.4 };
  }
  return { s: 'triangle', attack: 0.004, decay: 0.5, sustain: 0, release: 0.5, lpf: 2600, gain: 0.3, room: 0.45, delay: 0.2, delaytime: echo, delayfeedback: 0.4 };
}

const flavorScale = (flavor: Flavor) => (flavor === 'desert' ? PHRYGIAN_DOMINANT : style().scale);
const flavorOctave = (flavor: Flavor) => (flavor === 'ice' ? 12 : 0);

function push(kind: string, at: number, dur: number, value: Record<string, unknown>, flavor: Flavor) {
  events.push({ at, dur, value, kind });
  events.sort((a, b) => a.at - b.at);
  if (DEBUG) eventLog.push({ kind, at, note: value.note, flavor });
}

// Public: player actions --------------------------------------------------------------------------

/** Queues the next motif note for a flag. Returns true if a note was scheduled. */
export function flag(flavor: Flavor): boolean {
  if (!repl?.scheduler.started) return false;
  const st = style();
  const degree = st.motif[flagStep++ % st.motif.length];
  const pitch = degreeToMidi(st.root, flavorScale(flavor), degree) + flavorOctave(flavor);
  const at = nextSlot(EIGHTH, lastFlagTick + EIGHTH);
  lastFlagTick = at;
  push('flag', at, EIGHTH, { ...voice(flavor, 'note'), note: pitch }, flavor);
  if (flavor === 'desert') {
    // a little ornament after the note
    const orn = degreeToMidi(st.root, PHRYGIAN_DOMINANT, degree + 1);
    push('flag', at + TICKS / 16, EIGHTH, { ...voice(flavor, 'note'), note: orn, gain: 0.14 }, flavor);
  } else if (flavor === 'ice') {
    push('flag', at + TICKS / 32, EIGHTH, { ...voice(flavor, 'note'), note: pitch + 7, gain: 0.09 }, flavor);
  }
  return true;
}
let lastFlagTick = 0;
let lastAreaTick = -1e9;

export function area(cells: number, flavor: Flavor) {
  if (!repl?.scheduler.started) return;
  const at = nextSlot(BEAT, lastAreaTick + TICKS * 0.75);
  if (events.filter((e) => e.kind === 'area' && e.at >= at - TICKS).length > 4) return; // enough already
  lastAreaTick = at;
  const tones = [...chordAt(at)].sort((a, b) => a - b).map((n) => n + 12 + (flavor === 'ice' ? 12 : 0));
  const count = Math.min(tones.length + 1, 3 + Math.floor(cells / 12));
  const scale = flavorScale(flavor);
  const st = style();
  for (let i = 0; i < count; i++) {
    // chord tones, with the home-scale top note in desert colour
    const pitch = i < tones.length ? tones[i] : degreeToMidi(st.root, scale, 4) + 12;
    push('area', at + i * (TICKS / 24), BEAT, { ...voice(flavor, 'note'), note: pitch, release: 1.6, gain: 0.24 }, flavor);
  }
}

function phrase(kind: string, at: number, flavor: Flavor, big: boolean) {
  const st = style();
  const scale = flavorScale(flavor);
  const oct = flavorOctave(flavor);
  const run = st.victory;
  run.forEach((degree, i) => {
    const last = i === run.length - 1;
    push(kind, at + i * EIGHTH, last ? BEAT * 2 : EIGHTH, {
      ...voice(flavor, 'note'),
      note: degreeToMidi(st.root, scale, degree) + oct,
      gain: 0.26 + i * 0.012,
      release: last ? 2.4 : 0.5,
      decay: last ? 2 : 0.6,
    }, flavor);
  });
  // the resolving chord, held
  const chordAtTick = at + run.length * EIGHTH - EIGHTH;
  st.tonic.forEach((n) => push(kind, chordAtTick, TICKS * 2, { ...voice(flavor, 'pad'), note: n, gain: 0.1 }, flavor));
  if (big) {
    // a rising shimmer of the home scale on top
    for (let i = 0; i < 6; i++) {
      push(kind, chordAtTick + i * (TICKS / 12), BEAT, { ...voice('ice', 'note'), note: degreeToMidi(st.root, st.scale, i * 2) + 24, gain: 0.14 }, flavor);
    }
  }
}

export function chunk(flavor: Flavor) {
  if (!repl?.scheduler.started) return;
  const at = nextSlot(TICKS / 2, lastChunkTick + TICKS);
  lastChunkTick = at;
  phrase('chunk', at, flavor, false);
}
let lastChunkTick = -1e9;

export function win() {
  if (!repl?.scheduler.started) return;
  phrase('win', nextSlot(TICKS / 2, lastChunkTick + TICKS * 0.5), 'default', true);
}

// Public: control ------------------------------------------------------------------------------------

function buildPattern() {
  return stack(style().background(mood), livePattern);
}

function applyPattern() {
  if (!repl) return;
  repl.scheduler.setCps(style().bpm / 60 / 4);
  repl.scheduler.setPattern(buildPattern());
}

export function setMood(next: Mood) {
  if (next === mood || !repl) return;
  const now = performance.now();
  if (now - lastMoodChange < 6000) return; // don't flip-flop
  lastMoodChange = now;
  mood = next;
  applyPattern();
}

export function setStyle(next: MusicStyleId) {
  if (next === styleId) return;
  styleId = next;
  flagStep = 0;
  events = [];
  lastFlagTick = lastAreaTick = lastChunkTick = -1e9;
  applyPattern();
}

export function setVolume(volume: number) {
  try {
    const ctx = getAudioContext();
    const gain = getSuperdoughAudioController().output.destinationGain.gain;
    gain.setTargetAtTime(Math.max(0, Math.min(1, volume)) * 0.9, ctx.currentTime, 0.08);
  } catch {
    /* audio not ready yet */
  }
}

export function start(initialStyle: MusicStyleId, volume: number): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    styleId = initialStyle;
    await initAudio();
    registerSynthSounds();
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    repl = webaudioRepl({});
    repl.scheduler.setCps(style().bpm / 60 / 4);
    setVolume(0);
    await repl.scheduler.setPattern(buildPattern(), true);
    setVolume(volume); // fades in
    if (DEBUG) {
      (window as unknown as Record<string, unknown>).__music = {
        log: eventLog,
        state: () => ({ started: repl.scheduler.started, now: repl.scheduler.now(), lastEnd: repl.scheduler.lastEnd, cps: repl.scheduler.cps, style: styleId, mood, ctx: getAudioContext().state, pending: events.length }),
        level: () => {
          const ctx2 = getAudioContext();
          const an = ctx2.createAnalyser();
          getSuperdoughAudioController().output.destinationGain.connect(an);
          const buf = new Float32Array(an.fftSize);
          return new Promise<number>((resolve) =>
            setTimeout(() => {
              an.getFloatTimeDomainData(buf);
              resolve(Math.sqrt(buf.reduce((a, b) => a + b * b, 0) / buf.length));
            }, 200),
          );
        },
      };
    }
  })().catch((err) => {
    console.warn('Music could not start', err);
    starting = null;
    repl = null;
  });
  return starting;
}

export function stop() {
  if (!repl) return;
  setVolume(0);
  const r = repl;
  setTimeout(() => {
    if (repl !== r) return;
    r.scheduler.stop();
  }, 400);
  repl = null;
  starting = null;
  events = [];
}

export function suspend(on: boolean) {
  try {
    const ctx = getAudioContext();
    void (on ? ctx.suspend() : ctx.resume());
  } catch {
    /* nothing to do */
  }
}

export const isRunning = () => !!repl?.scheduler.started;
