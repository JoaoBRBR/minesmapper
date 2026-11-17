// Generative background music, built on Strudel (strudel.cc) and played by its Web Audio engine.
//
// * A looping lo-fi background (keys, bass, soft drums, vinyl texture) runs all the time, in one of
//   three styles: sunny lo-fi, late-night rainy lo-fi, and smoky lo-fi jazz.
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

import { Fraction, Hap, Pattern, TimeSpan, note, s, stack } from '@strudel/core';
import { miniAllStrings } from '@strudel/mini';
import { getAudioContext, getSuperdoughAudioController, initAudio, registerSynthSounds, setAudioContext, webaudioRepl } from '@strudel/webaudio';
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

// --- drums (all synthesised: a synth kick plus filtered noise) -----------------------------------------

const kick = (steps: string, gain = 0.5) => s('sbd').struct(steps).decay(0.32).gain(gain);
const snare = (steps: string, gain = 0.13) =>
  s('white').struct(steps).hpf(900).bpf(2100).decay(0.13).sustain(0).gain(gain).room(0.2);
const hats = (steps: string, gain = 0.035) => s('white').struct(steps).hpf(8500).decay(0.03).sustain(0).gain(gain);

// --- the three styles -----------------------------------------------------------------------------

/** Sunny lo-fi: major keys, a lazy beat and vinyl dust. */
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
      note(chords).s('sine').attack(0.5).release(1.8).lpf(1500).gain(0.09).room(0.4),
      // rhodes-like comping, a little behind the beat
      note(chords).s('triangle').struct('x ~ ~ [~ x] ~ ~ ~ ~').decay(0.6).sustain(0).release(0.3).lpf(1900).gain(0.15).room(0.45).swingBy(1 / 3, 4),
      // bass
      note(noteBars(this.bass)).s('sine').struct('x ~ ~ ~ ~ ~ [~ x] ~').attack(0.01).decay(0.5).sustain(0.3).release(0.4).lpf(280).gain(0.5),
      // lazy beat: kick on 1 and the "and" of 3, snare on 2 and 4, swung hats
      kick('x ~ ~ ~ ~ x ~ ~', 0.42),
      snare('~ ~ x ~ ~ ~ x ~'),
      hats('x x x x x x x x').swingBy(1 / 3, 4),
      // vinyl dust and a ghost of melody
      s('crackle').density(0.1).gain(0.2),
      note(stepBars([[null, 84, null, null, null, null, 79, null], [null, null, 81, null, null, null, null, null], [null, 79, null, null, 76, null, null, null], [null, null, null, 83, null, null, null, null]]))
        .s('sine').decay(0.8).sustain(0).delay(0.45).delaytime(0.4).delayfeedback(0.5).gain(0.06),
      moodLayer(this, mood),
    );
  },
};

/** Late-night lo-fi: A minor, slower and dimmer, rain on the window. */
const RAIN: Style = {
  id: 'rain',
  bpm: 68,
  root: 69,
  scale: [0, 3, 5, 7, 10],
  chords: [
    [60, 64, 67, 71], // Am9
    [57, 60, 64, 67], // Fmaj9
    [53, 57, 60, 64], // Dm9
    [56, 59, 62, 65], // E7b9
  ],
  bass: [45, 41, 38, 40],
  motif: [0, 1, 2, 3, 2, 1, 0, 4],
  victory: [0, 1, 2, 3, 4, 5, 4, 5],
  tonic: [57, 64, 69, 72],
  background(mood) {
    const chords = chordBars(this.chords);
    return stack(
      note(chords).s('sine').attack(0.7).release(2).lpf(1200).gain(0.1).room(0.5),
      // muffled keys
      note(chords).s('triangle').struct('x ~ ~ ~ ~ [~ x] ~ ~').decay(0.9).sustain(0).release(0.4).lpf(1500).gain(0.15).room(0.55).swingBy(1 / 3, 4),
      note(noteBars(this.bass)).s('sine').struct('x ~ ~ ~ ~ ~ x ~').attack(0.01).decay(0.7).sustain(0.2).release(0.5).lpf(250).gain(0.5),
      // slow, sleepy beat
      kick('x ~ ~ ~ ~ ~ x ~', 0.4),
      snare('~ ~ x ~ ~ ~ x ~', 0.1),
      hats('~ x ~ x ~ x ~ x', 0.025).swingBy(1 / 3, 4),
      // vinyl, and rain on the window
      s('crackle').density(0.16).gain(0.22),
      s('pink').attack(0.4).release(0.8).lpf(4200).hpf(1200).gain(0.028),
      moodLayer(this, mood),
    );
  },
};

/** Smoky lo-fi jazz: ii-V-I-VI changes, a walking bass and brushed swing. */
const JAZZ: Style = {
  id: 'jazz',
  bpm: 92,
  root: 72,
  scale: [0, 2, 4, 5, 7, 9, 11],
  chords: [
    [53, 57, 60, 64], // Dm9
    [59, 64, 65, 69], // G13
    [55, 59, 62, 64], // Cmaj9
    [55, 61, 64, 65], // A7b13
  ],
  bass: [38, 43, 48, 45],
  motif: [0, 2, 4, 6, 5, 4, 2, 1],
  victory: [0, 2, 4, 6, 7, 6, 4, 7],
  tonic: [60, 64, 67, 71],
  background(mood) {
    const chords = chordBars(this.chords);
    // a walking line: four quarter notes per bar
    const walk = '<[38 41 45 48] [43 47 50 52] [48 52 55 52] [45 49 52 55]>';
    return stack(
      note(chords).s('sine').attack(0.4).release(1.4).lpf(1300).gain(0.07).room(0.4),
      // Charleston comping on the electric piano
      note(chords).s('triangle').struct('x ~ ~ x ~ ~ ~ ~').decay(0.5).sustain(0).release(0.3).lpf(2200).gain(0.17).room(0.4).swingBy(1 / 3, 4),
      note(walk).s('sine').attack(0.01).decay(0.35).sustain(0.15).release(0.2).lpf(520).gain(0.5),
      // brushes: ride swing, chick on 2 and 4, a feathered kick
      s('white').struct('x [~ x] x [~ x]').hpf(7000).decay(0.09).sustain(0).gain(0.035).swingBy(1 / 3, 4),
      s('white').struct('~ x ~ x').hpf(5000).decay(0.05).sustain(0).gain(0.045),
      kick('x x x x', 0.1),
      s('crackle').density(0.07).gain(0.14),
      // a lazy horn line
      note(stepBars([[null, 76, null, 74, 72, null, null, null], [null, null, 74, null, 71, null, 69, null], [72, null, 76, null, 79, null, null, null], [null, 76, null, 73, null, 72, null, null]]))
        .s('triangle').lpf(2300).decay(0.4).sustain(0).delay(0.3).delaytime(0.33).delayfeedback(0.35).gain(0.08).swingBy(1 / 3, 4),
      moodLayer(this, mood),
    );
  },
};

const STYLES: Record<MusicStyleId, Style> = { dawn: DAWN, rain: RAIN, jazz: JAZZ };

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
let volumeNow = 0.6;
let duckTimer = 0;

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
  if (st.id === 'rain') {
    return { s: 'triangle', attack: 0.006, decay: 0.9, sustain: 0, release: 0.9, lpf: 2000, gain: 0.28, room: 0.65, delay: 0.3, delaytime: echo * 1.33, delayfeedback: 0.45 };
  }
  if (st.id === 'jazz') {
    // vibraphone-ish
    return { s: 'sine', fmi: 1.1, fmh: 4, attack: 0.003, decay: 1.0, sustain: 0, release: 0.9, gain: 0.26, room: 0.5, delay: 0.22, delaytime: echo, delayfeedback: 0.35 };
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

/**
 * Hitting a mine: a fast, falling run that cuts through the calm, over a dark cluster chord and a
 * low thud, while the background drops away for a few seconds. Anything cheerful still waiting
 * is dropped.
 */
export function lose() {
  if (!repl?.scheduler.started) return;
  const st = style();
  const sched = repl.scheduler;
  events = events.filter((e) => e.at < sched.lastEnd * TICKS); // keep only what is already underway
  const at = nextSlot(EIGHTH);
  // a quick chromatic-ish tumble from the octave down to the tonic (a sixteenth-note triplet apart)
  const run = [12, 11, 9, 8, 6, 5, 3, 2, 0];
  run.forEach((semi, i) => {
    const last = i === run.length - 1;
    push('lose', at + i * 4, last ? BEAT * 3 : 4, {
      ...voice('default', 'note'),
      s: last ? 'sine' : 'sawtooth',
      note: st.root + semi,
      attack: 0.004,
      decay: last ? 3 : 0.16,
      sustain: 0,
      release: last ? 3.5 : 0.22,
      lpf: last ? 1600 : 3000,
      gain: last ? 0.3 : 0.15 + (i / run.length) * 0.05,
      room: 0.45,
      delay: 0,
    }, 'default');
  });
  // a dissonant cluster (root, minor second, tritone) far below, and a thud
  [st.root - 24, st.root - 23, st.root - 18].forEach((n) =>
    push('lose', at, BEAT * 3, { ...voice('default', 'pad'), s: 'sawtooth', note: n, attack: 0.01, release: 2.4, lpf: 700, gain: 0.1 }, 'default'),
  );
  push('lose', at, BEAT, { s: 'sbd', note: 31, decay: 0.7, gain: 0.55 }, 'default');
  // the background drops away, then returns
  try {
    getSuperdoughAudioController().output.destinationGain.gain.setTargetAtTime(volumeNow * 0.9 * 0.35, getAudioContext().currentTime, 0.08);
  } catch {
    /* audio not ready */
  }
  clearTimeout(duckTimer);
  duckTimer = window.setTimeout(() => setVolume(volumeNow), 3800);
}

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
  volumeNow = volume;
  try {
    const ctx = getAudioContext();
    const gain = getSuperdoughAudioController().output.destinationGain.gain;
    gain.setTargetAtTime(Math.max(0, Math.min(1, volume)) * 0.9, ctx.currentTime, 0.08);
  } catch {
    /* audio not ready yet */
  }
}

export function start(initialStyle: MusicStyleId, volume: number, unlocked?: AudioContext): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    styleId = initialStyle;
    // Use the audio context that was created and unlocked inside the player's tap (essential on phones).
    if (unlocked) setAudioContext(unlocked);
    await initAudio();
    registerSynthSounds();
    const ctx = getAudioContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if (ctx.state !== 'running') throw new Error('the browser is still blocking audio');
    }
    repl = webaudioRepl({});
    repl.scheduler.setCps(style().bpm / 60 / 4);
    setVolume(0);
    await repl.scheduler.setPattern(buildPattern(), true);
    setVolume(volume); // fades in
    if (DEBUG) {
      (window as unknown as Record<string, unknown>).__music = {
        log: eventLog,
        state: () => ({ started: !!repl?.scheduler.started, now: repl?.scheduler.now(), lastEnd: repl?.scheduler.lastEnd, cps: repl?.scheduler.cps, style: styleId, mood, ctx: getAudioContext().state, pending: events.length }),
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
    throw err; // so the caller can try again on the next tap
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
