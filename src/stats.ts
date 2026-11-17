// Lifetime statistics. Kept apart from the saved worlds on purpose: deleting or
// restarting a world must not erase your history or your records.

import { getKV, setKV, type Difficulty } from './storage';

export interface Stats {
  version: 1;
  /** When stats started being recorded. */
  since: number;
  /** Time spent looking at a world (ms). */
  playMs: number;
  worldsCreated: number;
  restarts: number;
  wins: number;
  losses: number;
  cellsCleared: number;
  flagsPlaced: number;
  chunksTidied: number;
  oraclesFound: number;
  oraclesUsed: number;
  /** Fastest island clear in ms, keyed `${size}|${difficulty}` (custom difficulty is excluded). */
  bestIslandMs: Record<string, number>;
  /** Best endless score and farthest distance per difficulty (custom is excluded). */
  endlessBest: Record<string, { points: number; farthest: number }>;
  /** Fastest clearing time (ms) of each daily island you cleared, keyed by its UTC date. */
  dailyWins: Record<string, number>;
}

type Counter =
  | 'worldsCreated'
  | 'restarts'
  | 'wins'
  | 'losses'
  | 'cellsCleared'
  | 'flagsPlaced'
  | 'chunksTidied'
  | 'oraclesFound'
  | 'oraclesUsed';

const KEY = 'stats';

const blank = (): Stats => ({
  version: 1,
  since: Date.now(),
  playMs: 0,
  worldsCreated: 0,
  restarts: 0,
  wins: 0,
  losses: 0,
  cellsCleared: 0,
  flagsPlaced: 0,
  chunksTidied: 0,
  oraclesFound: 0,
  oraclesUsed: 0,
  bestIslandMs: {},
  endlessBest: {},
  dailyWins: {},
});

/** Live object (ES module binding: always read it through this export). */
export let stats: Stats = blank();

export async function loadStats() {
  const saved = await getKV<Stats>(KEY).catch(() => undefined);
  if (saved && saved.version === 1) stats = { ...blank(), ...saved };
}

let timer = 0;
function changed() {
  clearTimeout(timer);
  timer = window.setTimeout(() => void flushStats(), 1000);
}

export function flushStats(): Promise<void> {
  clearTimeout(timer);
  return setKV(KEY, stats).catch((err) => console.error('Saving stats failed', err));
}

export function bump(key: Counter, n = 1) {
  if (n <= 0) return;
  stats[key] += n;
  changed();
}

/** Returns true when this is the fastest clear so far for that island size and difficulty. */
export function noteIslandWin(size: number, difficulty: Difficulty, ms: number): boolean {
  if (difficulty === 'custom' || ms <= 0) return false;
  const key = `${size}|${difficulty}`;
  const best = stats.bestIslandMs[key];
  if (best !== undefined && ms >= best) return false;
  stats.bestIslandMs[key] = Math.round(ms);
  changed();
  return true;
}

export function noteEndless(difficulty: Difficulty, points: number, farthest: number) {
  if (difficulty === 'custom') return;
  const best = (stats.endlessBest[difficulty] ??= { points: 0, farthest: 0 });
  if (points > best.points || farthest > best.farthest) {
    best.points = Math.max(best.points, points);
    best.farthest = Math.max(best.farthest, farthest);
    changed();
  }
}

// --- Play time: counted only while a world is on screen and the tab is visible. -----------

let playSince: number | null = null;

export function startPlay() {
  playSince ??= performance.now();
}

export function stopPlay() {
  if (playSince === null) return;
  stats.playMs += performance.now() - playSince;
  playSince = null;
  changed();
}

export async function resetStats() {
  const wasPlaying = playSince !== null;
  playSince = null;
  stats = blank();
  if (wasPlaying) startPlay();
  await flushStats();
}

// --- Daily island --------------------------------------------------------------------------

const dayBefore = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** How many days in a row (ending today, or yesterday if today is not done yet) you cleared the daily island. */
export function dailyStreak(today = new Date().toISOString().slice(0, 10)): number {
  let day = stats.dailyWins[today] !== undefined ? today : dayBefore(today);
  let streak = 0;
  while (stats.dailyWins[day] !== undefined) {
    streak++;
    day = dayBefore(day);
  }
  return streak;
}

/** Records a cleared daily island (the best time of that day is kept) and returns the new streak. */
export function noteDailyWin(day: string, ms: number): number {
  const best = stats.dailyWins[day];
  if (ms > 0 && (best === undefined || ms < best)) stats.dailyWins[day] = Math.round(ms);
  else if (best === undefined) stats.dailyWins[day] = 0;
  changed();
  return dailyStreak();
}
