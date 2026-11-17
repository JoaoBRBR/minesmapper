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

async function ensure() {
  if (!settings.music || !gesture) return;
  if (!loading) {
    loading = import('./music').then(async (m) => {
      engine = m;
      await m.start(settings.musicStyle, settings.musicVolume);
      appliedStyle = settings.musicStyle;
      appliedVolume = settings.musicVolume;
    });
  }
  await loading.catch(() => {});
}

function sync() {
  if (!settings.music) {
    engine?.stop();
    loading = null;
    return;
  }
  if (!engine?.isRunning()) {
    loading = null;
    void ensure();
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

export function initMusic() {
  const first = () => {
    gesture = true;
    void ensure();
  };
  window.addEventListener('pointerdown', first, { once: true, capture: true });
  window.addEventListener('keydown', first, { once: true, capture: true });
  onSettingsChange(sync);
  // Save battery: silence the audio engine while the tab is hidden.
  document.addEventListener('visibilitychange', () => engine?.suspend(document.visibilityState === 'hidden'));
}

const live = () => (engine?.isRunning() ? engine : null);

/** True if the music played a note for the flag (so the plain blip is not needed). */
export const musicFlag = (flavor: Flavor): boolean => live()?.flag(flavor) ?? false;
export const musicArea = (cells: number, flavor: Flavor) => live()?.area(cells, flavor);
export const musicChunk = (flavor: Flavor) => live()?.chunk(flavor);
export const musicWin = () => live()?.win();
export const musicMood = (mood: Mood) => live()?.setMood(mood);
