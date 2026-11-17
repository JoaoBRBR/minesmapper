import { getKV, setKV } from './storage';

/** What the player has to do to finish a level. Chunk coordinates are 16×16 cleanup chunks. */
export type Goal =
  | { type: 'clear-island' }
  | { type: 'clear-chunk'; chunk: [number, number] }
  | { type: 'reach'; target: [number, number] };

export interface LevelDef {
  /** Stable id: saves and progress are keyed by it, so never reuse or change one. */
  id: string;
  title: string;
  /** One line shown on the level card. */
  blurb: string;
  /** Briefing paragraphs shown before the level starts. */
  intro: string[];
  mode: 'island' | 'endless';
  seed: number;
  /** Island side length in cells (island levels only). */
  size?: number;
  density: number;
  maxDensity: number;
  /** Mistakes the player can survive; the next mine ends the level. */
  hearts: number;
  goal: Goal;
  /**
   * Where the first tap is allowed, as cell corners `[x0, y0, x1, y1]` (inclusive). Chunk goals
   * default to the goal chunk itself. Omit it on islands to allow starting anywhere.
   */
  startArea?: [number, number, number, number];
  /** Opening view, in cells. Defaults to the start area, or the island's centre. */
  camera?: { x: number; y: number; zoom: number };
}

export const CHUNK = 16;

/** Cell rectangle of a cleanup chunk. */
export const chunkRect = ([cx, cy]: [number, number]): [number, number, number, number] => [
  cx * CHUNK,
  cy * CHUNK,
  cx * CHUNK + CHUNK - 1,
  cy * CHUNK + CHUNK - 1,
];

/** The first-tap rectangle of a level, if it has one. */
export function startRect(l: LevelDef): [number, number, number, number] | null {
  if (l.startArea) return l.startArea;
  return l.goal.type === 'clear-chunk' ? chunkRect(l.goal.chunk) : null;
}

/** Where the camera opens, in cells, or null for the default. */
export function openingView(l: LevelDef): { x: number; y: number; zoom: number } | null {
  if (l.camera) return l.camera;
  const r = startRect(l);
  return r ? { x: (r[0] + r[2] + 1) / 2, y: (r[1] + r[3] + 1) / 2, zoom: 22 } : null;
}

/**
 * The levels, in order. To add one, append an entry: nothing else needs to change.
 * Seeds were picked with `cargo run --release --example levelseeds`.
 */
export const LEVELS: LevelDef[] = [
  {
    id: 'first-landfall',
    title: 'First landfall',
    blurb: 'A tiny island. Clear every safe square.',
    intro: [
      'Every map starts somewhere. This islet is tiny, with about twenty-five mines.',
      'Tap a square to reveal it. A number tells how many mines touch it. Press and hold, or use the flag button, to mark a mine.',
      'You have three hearts: a mine costs one. Finish without losing any for three stars.',
    ],
    mode: 'island',
    seed: 13,
    size: 48,
    density: 0.0165,
    maxDensity: 0.033,
    hearts: 3,
    goal: { type: 'clear-island' },
  },
  {
    id: 'a-patch-of-ground',
    title: 'A patch of ground',
    blurb: 'Open sea ahead. Clear the glowing area.',
    intro: [
      'Now the map never ends. You will not clear all of it, only one marked area.',
      'The glowing square is your task, and your first tap has to land inside it. Reveal every safe square in it to win.',
    ],
    mode: 'endless',
    seed: 2,
    density: 0.1,
    maxDensity: 0.14,
    hearts: 3,
    goal: { type: 'clear-chunk', chunk: [2, -2] },
  },
  {
    id: 'the-lone-isle',
    title: 'The lone isle',
    blurb: 'A proper island. Clear it all.',
    intro: [
      'A bigger island, with real coastlines and some mines hiding along them.',
      'Look for numbers you can solve for certain, flag the mines you find, and never guess when you can reason.',
    ],
    mode: 'island',
    seed: 36,
    size: 72,
    density: 0.06,
    maxDensity: 0.12,
    hearts: 3,
    goal: { type: 'clear-island' },
  },
  {
    id: 'x-marks-the-spot',
    title: 'X marks the spot',
    blurb: 'Dig your way north to the treasure.',
    intro: [
      'A treasure lies four areas to the north, marked with an X. Begin inside the dashed square.',
      'Open a path to the X. You can only reveal squares next to ground you already know, so clear a trail. Reveal the X to win.',
    ],
    mode: 'endless',
    seed: 5,
    density: 0.15,
    maxDensity: 0.21,
    hearts: 3,
    goal: { type: 'reach', target: [40, -56] },
    startArea: [32, 0, 47, 15],
  },
  {
    id: 'still-waters',
    title: 'Still waters',
    blurb: 'An island full of lakes.',
    intro: [
      'This island has lakes inside it. Water is part of the game: it hides mines like any other square.',
      'Reveal a square of a lake and the water turns to see-through ice. You can open the ice and clear it just like land.',
      'Sometimes a rare ice crystal hides under a safe square. Spend it on a lake to make the whole stretch of water see-through, with mines faintly visible.',
    ],
    mode: 'island',
    seed: 178,
    size: 96,
    density: 0.07,
    maxDensity: 0.13,
    hearts: 3,
    goal: { type: 'clear-island' },
  },
  {
    id: 'a-guiding-star',
    title: 'A guiding star',
    blurb: 'Find the oracles and clear the area.',
    intro: [
      'Some safe squares hide a golden star: an oracle. You collect it when you reveal that square.',
      'Press the Oracle button and tap a hidden square next to explored ground. If it is safe it opens, and if it hides a mine it gets flagged. Use it when you would otherwise have to guess.',
      'There are oracles in the glowing area. Clear it to win.',
    ],
    mode: 'endless',
    seed: 27,
    density: 0.13,
    maxDensity: 0.17,
    hearts: 3,
    goal: { type: 'clear-chunk', chunk: [-3, 1] },
  },
  {
    id: 'thin-ice',
    title: 'Thin ice',
    blurb: 'A larger island and only two hearts.',
    intro: [
      'A much bigger island, and the sea will not forgive much: you have only two hearts.',
      'Take your time. Flag every mine you are sure about, and let the numbers decide each step.',
    ],
    mode: 'island',
    seed: 19,
    size: 128,
    density: 0.07,
    maxDensity: 0.14,
    hearts: 2,
    goal: { type: 'clear-island' },
  },
  {
    id: 'across-the-strait',
    title: 'Across the strait',
    blurb: 'Treasure lies far to the east, over the water.',
    intro: [
      'The X is far to the east, and the way there crosses open water.',
      'You can reveal water squares like any others, and they may hold mines too. Look at the numbers on the shore and open a path across.',
    ],
    mode: 'endless',
    seed: 139,
    density: 0.13,
    maxDensity: 0.18,
    hearts: 3,
    goal: { type: 'reach', target: [88, 8] },
    startArea: [0, 0, 15, 15],
  },
  {
    id: 'the-great-island',
    title: 'The great island',
    blurb: 'A full-size island. The last test.',
    intro: [
      'The biggest island yet: a whole continent of coasts, mountains and lakes. It will take a while.',
      'Everything you learned counts here. Zoom out when you need the big picture, and take breaks: your progress is always saved.',
    ],
    mode: 'island',
    seed: 22,
    size: 192,
    density: 0.06,
    maxDensity: 0.12,
    hearts: 3,
    goal: { type: 'clear-island' },
  },
];

export const getLevel = (id: string | undefined) => LEVELS.find((l) => l.id === id);
export const levelNumber = (l: LevelDef) => LEVELS.indexOf(l) + 1;
export const nextLevel = (l: LevelDef) => LEVELS[LEVELS.indexOf(l) + 1];

/** Three stars for a flawless run, two for one mistake, one for more. */
export const starsFor = (mistakes: number) => (mistakes === 0 ? 3 : mistakes === 1 ? 2 : 1);

export interface LevelResult {
  stars: number;
  bestMs: number;
}
export type AdventureProgress = Record<string, LevelResult>;

const KEY = 'adventure';

export async function loadProgress(): Promise<AdventureProgress> {
  return (await getKV<AdventureProgress>(KEY)) ?? {};
}

/** Keeps the best stars and the best time. Returns true if the stars improved. */
export async function recordResult(id: string, stars: number, ms: number): Promise<boolean> {
  const all = await loadProgress();
  const old = all[id];
  all[id] = { stars: Math.max(stars, old?.stars ?? 0), bestMs: old ? Math.min(old.bestMs, ms) : ms };
  await setKV(KEY, all);
  return !old || stars > old.stars;
}

/** Testing switch: every level is open. Set to false before release. */
const UNLOCK_ALL = true;

/** A level opens once the one before it has been finished. */
export const isUnlocked = (progress: AdventureProgress, index: number) =>
  UNLOCK_ALL ||
  index === 0 || (progress[LEVELS[index - 1].id]?.stars ?? 0) > 0;
