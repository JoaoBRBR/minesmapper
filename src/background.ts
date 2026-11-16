// Menu background: a random endless world slowly drifting in a random direction.
//
// The world is rendered in 32x32-cell chunks. Each chunk is painted once into its
// own small canvas ("tile") and the frame is just a handful of drawImage calls.
// Tiles that scroll off screen are dropped straight away (their canvases are
// recycled through a tiny pool), and the Rust terrain cache is flushed after each
// batch, so memory and CPU stay flat no matter how long the menu stays open.

import { World } from './wasm/pkg/minefield';
import { draw } from './render';
import { randomSeed } from './config';

const CELL = 10; // px per cell
const CHUNK = 32; // cells per chunk side (matches the Rust terrain chunks)
const TILE = CELL * CHUNK;
const SPEED = 26; // px per second
const FRAME_MS = 1000 / 30;
const POOL_MAX = 12;

const canvas = document.querySelector<HTMLCanvasElement>('#bg')!;
const ctx = canvas.getContext('2d')!;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let world: World | null = null;
let wanted = false;
let raf = 0;
let last = 0;
let w = 0;
let h = 0;
let camX = 0;
let camY = 0;
let vx = 0;
let vy = 0;
const tiles = new Map<string, HTMLCanvasElement>();
const pool: HTMLCanvasElement[] = [];

function resize() {
  const dpr = window.devicePixelRatio || 1;
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (world && !raf) render();
}

function makeTile(cx: number, cy: number): HTMLCanvasElement {
  const tile = pool.pop() ?? Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const tctx = tile.getContext('2d')!;
  // Camera centred on the chunk so draw() covers exactly this chunk's cells.
  const cam = { cx: cx * CHUNK + CHUNK / 2, cy: cy * CHUNK + CHUNK / 2, zoom: CELL };
  draw(tctx, world!, cam, TILE, TILE, 'preview');
  return tile;
}

function render() {
  if (!world) return;
  const left = camX - w / 2;
  const top = camY - h / 2;
  const c0 = Math.floor(left / TILE);
  const c1 = Math.floor((left + w) / TILE);
  const r0 = Math.floor(top / TILE);
  const r1 = Math.floor((top + h) / TILE);

  const visible = new Set<string>();
  let created = false;
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const key = `${cx},${cy}`;
      visible.add(key);
      let tile = tiles.get(key);
      if (!tile) {
        tile = makeTile(cx, cy);
        tiles.set(key, tile);
        created = true;
      }
      ctx.drawImage(tile, Math.round(cx * TILE - left), Math.round(cy * TILE - top));
    }
  }

  // Anything that left the screen stops existing.
  for (const [key, tile] of tiles) {
    if (visible.has(key)) continue;
    tiles.delete(key);
    if (pool.length < POOL_MAX) pool.push(tile);
  }
  if (created) world.clear_chunk_cache();

  // Darken so the menu stays readable.
  ctx.fillStyle = 'rgba(8, 16, 28, 0.55)';
  ctx.fillRect(0, 0, w, h);
}

function loop(now: number) {
  raf = requestAnimationFrame(loop);
  if (now - last < FRAME_MS) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  camX += vx * dt;
  camY += vy * dt;
  render();
}

function run() {
  if (raf || !world || document.hidden || reducedMotion.matches) {
    if (world && !raf) render();
    return;
  }
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

function halt() {
  cancelAnimationFrame(raf);
  raf = 0;
}

/** Shows the background (a fresh random world and direction), or tears it down. */
export function setBackground(on: boolean) {
  wanted = on;
  if (on) {
    if (world) return; // already running (e.g. menu -> creator)
    world = new World(randomSeed(), 0.15, 0.15, 0);
    const angle = Math.random() * Math.PI * 2;
    vx = Math.cos(angle) * SPEED;
    vy = Math.sin(angle) * SPEED;
    camX = (Math.random() - 0.5) * 200_000;
    camY = (Math.random() - 0.5) * 200_000;
    canvas.hidden = false;
    resize();
    run();
  } else {
    halt();
    canvas.hidden = true;
    tiles.clear();
    pool.length = 0;
    world?.free();
    world = null;
  }
}

window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (!wanted) return;
  if (document.hidden) halt();
  else run();
});

/** Live tile counts (used by tests to verify off-screen chunks are discarded). */
export function backgroundStats() {
  return { tiles: tiles.size, pooled: pool.length };
}

if (import.meta.env.DEV) (window as unknown as { __bgStats: typeof backgroundStats }).__bgStats = backgroundStats;
