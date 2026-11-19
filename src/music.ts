// Plain background music: one <audio> element streaming a small AAC file, routed through a gain
// node so the volume slider also works on iPhone. Nothing is downloaded until a track is played.

import { onSettingsChange, settings, setSetting } from './settings';
import { backgroundIsSpace } from './background';
import { MAP_TRACKS, MENU_TRACK, SECRET_TRACK, TRACKS, trackById, type Track } from './tracks';

const files = import.meta.glob('../music/*.m4a', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const urlOf = (id: string) => files[`../music/${id}.m4a`];

const UNLOCK_KEY = 'minefield.music.unlocked';
const FADE_S = 0.18;

let audio: HTMLAudioElement | null = null;
let ac: AudioContext | null = null;
let gain: GainNode | null = null;
let gesture = false;
let current: string | null = null;
/** True once the player picked a track with next/previous: that choice then wins over the defaults. */
let manual = false;
let switching = 0;
const listeners = new Set<() => void>();

function readUnlocked(): string[] {
  try {
    return JSON.parse(localStorage.getItem(UNLOCK_KEY) ?? '[]');
  } catch {
    return [];
  }
}
let unlocked = new Set(readUnlocked());

export const isUnlocked = (id: string) => unlocked.has(id);

/** The tracks the player can step through (secret ones only after they are unlocked). */
export function playlist(): Track[] {
  return TRACKS.filter((t) => (!t.secret || unlocked.has(t.id)) && urlOf(t.id));
}

export function currentTrack(): Track | undefined {
  return current ? trackById(current) : undefined;
}

export function onMusicChange(cb: () => void) {
  listeners.add(cb);
}
const emit = () => listeners.forEach((cb) => cb());

/** The slider is 0-1; sound is felt on a curve, so the gain follows its square. */
const gainFor = (v: number) => 0.8 * v * v;

function applyVolume() {
  if (gain && ac) gain.gain.setTargetAtTime(gainFor(settings.musicVolume), ac.currentTime, 0.05);
}

function wantsSound() {
  return settings.music && gesture && !document.hidden && !!current;
}

function tryPlay() {
  if (!audio || !wantsSound()) return;
  void ac?.resume();
  void audio.play().catch(() => {
    /* not allowed yet: the next tap tries again */
  });
}

function load(id: string) {
  if (!audio) return;
  const url = urlOf(id);
  if (!url) return;
  current = id;
  audio.src = url;
  audio.loop = settings.musicRepeat;
  emit();
  tryPlay();
}

/** Switches track with a short fade out, so it does not cut. */
function switchTo(id: string) {
  if (id === current) return;
  if (!audio || !ac || !gain || audio.paused) {
    load(id);
    return;
  }
  const token = ++switching;
  gain.gain.setTargetAtTime(0, ac.currentTime, FADE_S / 3);
  setTimeout(() => {
    if (token !== switching) return;
    load(id);
    applyVolume();
  }, FADE_S * 1000);
}

/** The track a map starts with: space maps always have the space track, others the one assigned to them. */
export function defaultForMap(mode: string, levelId?: string, daily?: boolean, space?: boolean): string {
  if (space) return SECRET_TRACK;
  if (levelId && MAP_TRACKS.byLevel[levelId]) return MAP_TRACKS.byLevel[levelId];
  return MAP_TRACKS.byMode[daily ? 'daily' : mode] ?? MENU_TRACK;
}

/** A screen or map asks for its track. The player's own pick (next/previous) is left alone. */
export function playTrack(id: string) {
  if (manual) return;
  if (!current) load(id);
  else switchTo(id);
}

export function playMenuMusic() {
  playTrack(backgroundIsSpace() ? SECRET_TRACK : MENU_TRACK);
}

function step(dir: 1 | -1) {
  const list = playlist();
  if (!list.length) return;
  const i = list.findIndex((t) => t.id === current);
  const next = list[(i + dir + list.length) % list.length];
  manual = true;
  if (!settings.music) setSetting('music', true);
  switchTo(next.id);
}
export const nextTrack = () => step(1);
export const previousTrack = () => step(-1);

export function toggleRepeat() {
  setSetting('musicRepeat', !settings.musicRepeat);
}

/** Beating a space map opens the space track in the playlist. */
export function unlockTrack(id: string) {
  if (unlocked.has(id)) return;
  unlocked = new Set([...unlocked, id]);
  try {
    localStorage.setItem(UNLOCK_KEY, JSON.stringify([...unlocked]));
  } catch {
    /* it stays unlocked for this session */
  }
  emit();
}

function onGesture() {
  if (!audio) return;
  if (!ac) {
    try {
      ac = new AudioContext();
      gain = ac.createGain();
      gain.connect(ac.destination);
      ac.createMediaElementSource(audio).connect(gain);
      applyVolume();
    } catch {
      ac = null;
      gain = null;
    }
  }
  gesture = true;
  tryPlay();
}

export function initMusic() {
  audio = new Audio();
  audio.preload = 'none';
  audio.loop = settings.musicRepeat;
  audio.addEventListener('ended', () => {
    // repeat is off: carry on with the next track in the list
    if (!settings.musicRepeat) {
      const list = playlist();
      const i = list.findIndex((t) => t.id === current);
      if (list.length) load(list[(i + 1) % list.length].id);
    }
  });
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio?.pause();
    else tryPlay();
  });
  onSettingsChange(() => {
    if (!audio) return;
    audio.loop = settings.musicRepeat;
    applyVolume();
    if (settings.music) tryPlay();
    else audio.pause();
  });
}

/** The song that is sounding right now and its position in seconds, or null when nothing is sounding. */
export function songClock(): { track: string; t: number } | null {
  if (!audio || audio.paused || !current) return null;
  return { track: current, t: audio.currentTime };
}
