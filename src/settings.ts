// Per-device preferences, kept in localStorage (a convenience, not game state).

export interface Settings {
  animations: boolean;
  sound: boolean;
  vibration: boolean;
}

const KEY = 'minefield.settings';
const DEFAULTS: Settings = { animations: true, sound: true, vibration: true };

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      animations: typeof raw.animations === 'boolean' ? raw.animations : DEFAULTS.animations,
      sound: typeof raw.sound === 'boolean' ? raw.sound : DEFAULTS.sound,
      vibration: typeof raw.vibration === 'boolean' ? raw.vibration : DEFAULTS.vibration,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Live settings object: read it whenever you need the current value. */
export const settings: Settings = load();

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: the setting still applies for this session */
  }
}

/** Respect the OS "reduce motion" preference unless the player opted in explicitly. */
export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
