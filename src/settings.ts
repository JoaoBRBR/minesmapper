// Per-device preferences, kept in localStorage (a convenience, not game state).

export interface Settings {
  animations: boolean;
  sound: boolean;
  vibration: boolean;
  /** Advanced / debugging: outline the cleanup chunks. */
  chunkBorders: boolean;
  /** Darker parchment for night play. */
  darkPaper: boolean;
  /** Classic coloured numbers instead of ink-written ones. */
  coloredNumbers: boolean;
}

const KEY = 'minefield.settings';
const DEFAULTS: Settings = { animations: true, sound: true, vibration: true, chunkBorders: false, darkPaper: false, coloredNumbers: false };

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      animations: typeof raw.animations === 'boolean' ? raw.animations : DEFAULTS.animations,
      sound: typeof raw.sound === 'boolean' ? raw.sound : DEFAULTS.sound,
      vibration: typeof raw.vibration === 'boolean' ? raw.vibration : DEFAULTS.vibration,
      chunkBorders: typeof raw.chunkBorders === 'boolean' ? raw.chunkBorders : DEFAULTS.chunkBorders,
      darkPaper: typeof raw.darkPaper === 'boolean' ? raw.darkPaper : DEFAULTS.darkPaper,
      coloredNumbers: typeof raw.coloredNumbers === 'boolean' ? raw.coloredNumbers : DEFAULTS.coloredNumbers,
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
