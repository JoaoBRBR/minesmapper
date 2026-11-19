// Per-device preferences, kept in localStorage (a convenience, not game state).

export type NumberStyle = 'engraved' | 'colored';
const NUMBER_STYLES: NumberStyle[] = ['engraved', 'colored'];

export interface Settings {
  animations: boolean;
  sound: boolean;
  vibration: boolean;
  /** Advanced / debugging: outline the cleanup chunks. */
  chunkBorders: boolean;
  /** Darker parchment for night play. */
  darkPaper: boolean;
  simpleColors: boolean;
  vintage: boolean;
  mapDrawings: boolean;
  /** How the numbers on the map look. */
  numberStyle: NumberStyle;
  /** Background music on/off, its volume (0 to 1) and whether a track repeats instead of moving on. */
  music: boolean;
  musicVolume: number;
  musicRepeat: boolean;
  /** Gentle animated waves along island shores. */
  waves: boolean;
  /** Desktop: move the map with the arrow keys or WASD. */
  keyboardMove: boolean;
  /** Phones: show the floating Reveal/Flag switch. */
  modeSwitch: boolean;
}

const KEY = 'minefield.settings';
const DEFAULTS: Settings = { animations: true, sound: true, vibration: true, chunkBorders: false, darkPaper: false, simpleColors: false, vintage: true, mapDrawings: true, numberStyle: 'engraved', music: true, musicVolume: 0.25, musicRepeat: true, waves: true, keyboardMove: true, modeSwitch: true };

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      animations: typeof raw.animations === 'boolean' ? raw.animations : DEFAULTS.animations,
      sound: typeof raw.sound === 'boolean' ? raw.sound : DEFAULTS.sound,
      vibration: typeof raw.vibration === 'boolean' ? raw.vibration : DEFAULTS.vibration,
      chunkBorders: typeof raw.chunkBorders === 'boolean' ? raw.chunkBorders : DEFAULTS.chunkBorders,
      darkPaper: typeof raw.darkPaper === 'boolean' ? raw.darkPaper : DEFAULTS.darkPaper,
      mapDrawings: typeof raw.mapDrawings === 'boolean' ? raw.mapDrawings : DEFAULTS.mapDrawings,
      vintage: typeof raw.vintage === 'boolean' ? raw.vintage : DEFAULTS.vintage,
      simpleColors: typeof raw.simpleColors === 'boolean' ? raw.simpleColors : DEFAULTS.simpleColors,
      // Older saves stored a boolean `coloredNumbers`.
      numberStyle: NUMBER_STYLES.includes(raw.numberStyle)
        ? raw.numberStyle
        : raw.coloredNumbers === true
          ? 'colored'
          : DEFAULTS.numberStyle,
      music: typeof raw.music === 'boolean' ? raw.music : DEFAULTS.music,
      musicVolume:
        // volumes saved before the audio-file music were on another scale, so they start over
        raw.musicEngine === 2 && typeof raw.musicVolume === 'number' && raw.musicVolume >= 0 && raw.musicVolume <= 1
          ? raw.musicVolume
          : DEFAULTS.musicVolume,
      musicRepeat: typeof raw.musicRepeat === 'boolean' ? raw.musicRepeat : DEFAULTS.musicRepeat,
      waves: typeof raw.waves === 'boolean' ? raw.waves : DEFAULTS.waves,
      keyboardMove: typeof raw.keyboardMove === 'boolean' ? raw.keyboardMove : DEFAULTS.keyboardMove,
      modeSwitch: typeof raw.modeSwitch === 'boolean' ? raw.modeSwitch : DEFAULTS.modeSwitch,
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
    localStorage.setItem(KEY, JSON.stringify({ ...settings, musicEngine: 2 }));
  } catch {
    /* storage unavailable: the setting still applies for this session */
  }
}

/** Respect the OS "reduce motion" preference unless the player opted in explicitly. */
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
