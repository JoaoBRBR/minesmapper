// Per-device preferences, kept in localStorage (a convenience, not game state).

export type NumberStyle = 'engraved' | 'handwritten' | 'colored';
export type MusicStyle = 'dawn' | 'cloister' | 'deep';
const MUSIC_STYLES: MusicStyle[] = ['dawn', 'cloister', 'deep'];
const NUMBER_STYLES: NumberStyle[] = ['engraved', 'handwritten', 'colored'];

export interface Settings {
  animations: boolean;
  sound: boolean;
  vibration: boolean;
  /** Advanced / debugging: outline the cleanup chunks. */
  chunkBorders: boolean;
  /** Darker parchment for night play. */
  darkPaper: boolean;
  /** How the numbers on the map look. */
  numberStyle: NumberStyle;
  /** Background music on/off, its style, and its volume (0 to 1). */
  music: boolean;
  musicStyle: MusicStyle;
  musicVolume: number;
  /** Testing: allow the 3D view for every island, not only cleared ones. */
  always3d: boolean;
}

const KEY = 'minefield.settings';
const DEFAULTS: Settings = { animations: true, sound: true, vibration: true, chunkBorders: false, darkPaper: false, numberStyle: 'engraved', music: true, musicStyle: 'dawn', musicVolume: 0.6, always3d: true };

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      animations: typeof raw.animations === 'boolean' ? raw.animations : DEFAULTS.animations,
      sound: typeof raw.sound === 'boolean' ? raw.sound : DEFAULTS.sound,
      vibration: typeof raw.vibration === 'boolean' ? raw.vibration : DEFAULTS.vibration,
      chunkBorders: typeof raw.chunkBorders === 'boolean' ? raw.chunkBorders : DEFAULTS.chunkBorders,
      darkPaper: typeof raw.darkPaper === 'boolean' ? raw.darkPaper : DEFAULTS.darkPaper,
      // Older saves stored a boolean `coloredNumbers`.
      numberStyle: NUMBER_STYLES.includes(raw.numberStyle)
        ? raw.numberStyle
        : raw.coloredNumbers === true
          ? 'colored'
          : DEFAULTS.numberStyle,
      music: typeof raw.music === 'boolean' ? raw.music : DEFAULTS.music,
      musicStyle: MUSIC_STYLES.includes(raw.musicStyle) ? raw.musicStyle : DEFAULTS.musicStyle,
      musicVolume:
        typeof raw.musicVolume === 'number' && raw.musicVolume >= 0 && raw.musicVolume <= 1
          ? raw.musicVolume
          : DEFAULTS.musicVolume,
      always3d: typeof raw.always3d === 'boolean' ? raw.always3d : DEFAULTS.always3d,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Live settings object: read it whenever you need the current value. */
export const settings: Settings = load();

const listeners = new Set<() => void>();

/** Calls back whenever any setting changes (from any place that edits settings). */
export function onSettingsChange(callback: () => void) {
  listeners.add(callback);
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  listeners.forEach((cb) => cb());
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: the setting still applies for this session */
  }
}

/** Respect the OS "reduce motion" preference unless the player opted in explicitly. */
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
