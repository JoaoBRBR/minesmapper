import { World } from './wasm/pkg/minefield';
import type { Difficulty, WorldConfig } from './storage';

export const DIFFICULTIES: Record<Exclude<Difficulty, 'custom'>, { density: number; maxDensity: number }> = {
  easy: { density: 0.12, maxDensity: 0.22 },
  normal: { density: 0.15, maxDensity: 0.28 },
  hard: { density: 0.2, maxDensity: 0.34 },
};

/** What new worlds are generated with (see WorldConfig.gen). */
export const WORLD_GEN = 2;

export const ISLAND_SIZES = { small: 96, medium: 192, large: 320 } as const;

/** Endless mode: distance (cells) over which mine density ramps up. */
const ENDLESS_RAMP_LEN = 300;

export function makeWorld(c: WorldConfig): World {
  return c.mode === 'island'
    ? World.new_island(c.seed, c.size, c.density, c.maxDensity, c.gen ?? 1)
    : new World(c.seed, c.density, c.maxDensity, ENDLESS_RAMP_LEN);
}

export function randomSeed(): number {
  return (Math.random() * 2 ** 32) >>> 0;
}

/** Digits are used as the seed directly; any other text is hashed (FNV-1a). */
export function seedFromText(text: string): number {
  const t = text.trim();
  if (/^\d{1,10}$/.test(t) && Number(t) <= 0xffffffff) return Number(t);
  let h = 0x811c9dc5;
  for (const ch of t) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
