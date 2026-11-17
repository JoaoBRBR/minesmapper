// The always-loaded face of the music. The Strudel engine (src/music.ts) is large, so it is
// only fetched once music is enabled AND the player has interacted with the page (browsers
// do not allow sound before that).

import { onSettingsChange, settings } from './settings';

type Engine = typeof import('./music');
export type Flavor = 'default' | 'desert' | 'ice';
type Mood = Flavor;

let engine: Engine | null = null;
let loading: Promise<void> | null = null;
let gesture = false;
let audioCtx: AudioContext | null = null;
/** When the last start attempt failed (never, to begin with); used to pause retries briefly. */
let lastFail = -Infinity;
let appliedStyle = settings.musicStyle;
let appliedVolume = settings.musicVolume;

/** Biome ids from crate/src/terrain.rs. */
const DESERT = [3, 4];
const ICY = [11, 13];

/** The musical flavour of a map cell, from its byte pair as returned by `World.view` (`[state, biome]`). */
export function flavorOf(state: number, biome: number): Flavor {
  if (DESERT.includes(biome)) return 'desert';
  if (ICY.includes(biome)) return 'ice';
  // hidden or flagged water that is under see-through ice
  if (biome <= 1 && (state & 0x40) !== 0 && ((state & 0x30) === 0 || (state & 0x30) === 0x10)) return 'ice';
  return 'default';
}

/** Loads the engine and starts the music (needs `audioCtx` to have been unlocked by a tap). */
function ensure() {
  if (!settings.music || !gesture || !audioCtx) return;
  if (engine?.isRunning() || loading) return;
  // If an attempt just failed, wait a few seconds before the next one.
  if (performance.now() - lastFail < 3000) return;
  loading = import('./music')
    .then(async (m) => {
      engine = m;
      await m.start(settings.musicStyle, settings.musicVolume, audioCtx!);
      appliedStyle = settings.musicStyle;
      appliedVolume = settings.musicVolume;
    })
    .catch((err) => {
      lastFail = performance.now();
      console.warn('Music did not start; it will retry on the next tap.', err);
    })
    .finally(() => {
      loading = null;
    });
}

/**
 * Browsers only let a page make sound after a real tap, and phones are strict about it: the audio
 * context has to be created and resumed *inside* the tap handler (not after an async download).
 * This runs on every kind of tap or key press until the music is going, and again whenever the
 * system has silenced the audio (a call, the screen locking, the tab sleeping).
 */
function unlock() {
  if (!settings.music) return;
  try {
    audioCtx ??= new AudioContext({ latencyHint: 'playback' });
    if (audioCtx.state === 'running') {
      gesture = true;
      ensure();
      return;
    }
    void audioCtx.resume();
    // A silent blip inside the gesture fully unlocks audio on iPhones.
    const blip = audioCtx.createBufferSource();
    blip.buffer = audioCtx.createBuffer(1, 1, 22050);
    blip.connect(audioCtx.destination);
    blip.start(0);
    audioCtx.onstatechange = () => {
      if (audioCtx?.state === 'running') {
        gesture = true;
        ensure();
      }
    };
  } catch {
    /* no Web Audio on this device */
  }
}

function sync() {
  if (!settings.music) {
    engine?.stop();
    loading = null;
    return;
  }
  if (!engine?.isRunning()) {
    unlock();
    ensure();
    return;
  }
  if (settings.musicStyle !== appliedStyle) {
    appliedStyle = settings.musicStyle;
    engine.setStyle(appliedStyle);
  }
  if (settings.musicVolume !== appliedVolume) {
    appliedVolume = settings.musicVolume;
    engine.setVolume(appliedVolume);
  }
}

/** A small hint when the page is open but silent because nobody has tapped yet. */
function hintIfSilent() {
  window.setTimeout(() => {
    if (!settings.music || audioCtx?.state === 'running') return;
    const toast = document.querySelector<HTMLElement>('#toast');
    if (!toast) return;
    toast.textContent = '♪ Tap anywhere to start the music';
    toast.hidden = false;
    window.setTimeout(() => {
      if (toast.textContent?.startsWith('♪')) toast.hidden = true;
    }, 4500);
  }, 2500);
}

export function initMusic() {
  // pointerup/click/touchend/keydown are the events browsers accept as "a real tap"
  for (const type of ['pointerup', 'click', 'touchend', 'keydown']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
  onSettingsChange(sync);
  // Save battery while the tab is hidden; come back to life when it returns.
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    engine?.suspend(hidden);
    if (!hidden) void audioCtx?.resume().catch(() => {});
  });
  hintIfSilent();
}

const live = () => (engine?.isRunning() ? engine : null);

/** True if the music played a note for the flag (so the plain blip is not needed). */
export const musicFlag = (flavor: Flavor): boolean => live()?.flag(flavor) ?? false;
export const musicArea = (cells: number, flavor: Flavor) => live()?.area(cells, flavor);
export const musicChunk = (flavor: Flavor) => live()?.chunk(flavor);
export const musicWin = () => live()?.win();
export const musicLose = () => live()?.lose();
export const musicMood = (mood: Mood) => live()?.setMood(mood);
