import type { World } from './wasm/pkg/minefield';

export interface Camera {
  /** World-space cell coordinate at the centre of the screen (fractional). */
  cx: number;
  cy: number;
  /** Pixels per cell. */
  zoom: number;
}

/** Default minimum zoom; island mode may go lower to fit the whole island. */
export const MIN_ZOOM = 6;
export const MAX_ZOOM = 96;

const ST_MASK = 0x30;
const ST_FLAG = 0x10;
const ST_REVEALED = 0x20;
const ST_MINE = 0x30;
/** Hidden + low nibble 0xF: unplayable water around the island. */
const ST_VOID = 0x0f;

type RGB = [number, number, number];

// Order mirrors the B_* ids in crate/src/terrain.rs.
const BIOME_COLORS: RGB[] = [
  [30, 70, 118], // deep ocean
  [54, 118, 166], // ocean
  [226, 212, 160], // beach
  [226, 196, 128], // desert
  [196, 122, 78], // badlands
  [180, 180, 98], // savanna
  [138, 186, 92], // grassland
  [72, 132, 70], // forest
  [38, 110, 62], // jungle
  [84, 116, 92], // swamp
  [76, 118, 104], // taiga
  [176, 190, 170], // tundra
  [128, 124, 118], // rock
  [240, 244, 248], // snow
];
// Unexplored land fades towards this near-black blue.
const FOG: RGB = [10, 16, 26];
const SHADE_LEVELS = 32;

function buildPalette(fog: number): string[] {
  const out: string[] = [];
  for (const base of BIOME_COLORS) {
    for (let l = 0; l < SHADE_LEVELS; l++) {
      // shade 128 (level 16) is neutral; map to a brightness factor.
      const f = 0.62 + 0.76 * ((l + 0.5) / SHADE_LEVELS);
      const c = [0, 1, 2].map((k) => {
        const lit = Math.min(255, base[k] * f);
        return Math.round(lit + (FOG[k] - lit) * fog);
      });
      out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
  }
  return out;
}

// Revealed land is vivid; unexplored land is buried in darkness.
const CLEAR = buildPalette(0);
const FOGGED = buildPalette(0.78);
// After the game ends the whole map is shown, with unexplored land only slightly dimmed.
const REVIEW = buildPalette(0.3);

/**
 * play    - fog of war: only revealed cells show their colours.
 * review  - game over / won: everything in colour, revealed cells still stand out.
 * preview - everything in full colour (world creator, menu background).
 */
export type ViewMode = 'play' | 'review' | 'preview';

function paletteFor(b: number, view: ViewMode): string[] {
  if (view === 'preview') return CLEAR;
  if (b === ST_VOID) return view === 'review' ? CLEAR : FOGGED;
  if ((b & ST_MASK) === ST_REVEALED) return CLEAR;
  return view === 'review' ? REVIEW : FOGGED;
}
const paletteIndex = (biome: number, shade: number) => biome * SHADE_LEVELS + (shade >> 3);

const NUMBER_COLORS = ['', '#1d4ed8', '#15803d', '#b91c1c', '#4c1d95', '#7c2d12', '#0e7490', '#111827', '#525252'];

/** Cell reveal ripple (parallel arrays; `t0` is the start time of each cell's pop, in ms). */
export interface Ripple {
  xs: number[];
  ys: number[];
  t0: number[];
}

/** Transient effects layered over the map. */
export interface Fx {
  now: number;
  ripple?: Ripple | null;
  /** Loss sequence: mines pop outward from `origin`, starting at `t0`. */
  mines?: { t0: number; origin: [number, number] } | null;
}

export const RIPPLE_MS = 300;
const MINE_POP_DELAY_MS = 300;
const MINE_POP_STEP_MS = 14;
const MINE_POP_MAX_DELAY_MS = 1100;
const MINE_POP_MS = 260;

const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export function screenToCell(cam: Camera, w: number, h: number, px: number, py: number): [number, number] {
  return [Math.floor((px - w / 2) / cam.zoom + cam.cx), Math.floor((py - h / 2) / cam.zoom + cam.cy)];
}

export function draw(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  w: number,
  h: number,
  view: ViewMode = 'play',
  fx?: Fx,
) {
  const { zoom } = cam;
  const x0 = Math.floor(cam.cx - w / 2 / zoom);
  const y0 = Math.floor(cam.cy - h / 2 / zoom);
  const cols = Math.ceil(w / zoom) + 2;
  const rows = Math.ceil(h / zoom) + 2;
  const data = world.view(x0, y0, cols, rows);
  const size = Math.ceil(zoom);
  const px = (x: number) => Math.floor((x - cam.cx) * zoom + w / 2);
  const py = (y: number) => Math.floor((y - cam.cy) * zoom + h / 2);

  // Pass 1: terrain + state tint. Unplayable water is never fogged.
  let hasVoid = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      hasVoid ||= data[i] === ST_VOID;
      ctx.fillStyle = paletteFor(data[i], view)[paletteIndex(data[i + 1], data[i + 2])];
      ctx.fillRect(px(x0 + c), py(y0 + r), size, size);
    }
  }

  // Pass 2: grid lines for fogged cells (so the frontier reads clearly).
  if (zoom >= 14) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const x = px(x0 + c) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let r = 0; r <= rows; r++) {
      const y = py(y0 + r) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    if (hasVoid) {
      // Wipe the grid off the water so only the playable island is gridded.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = (r * cols + c) * 3;
          if (data[i] !== ST_VOID) continue;
          ctx.fillStyle = paletteFor(ST_VOID, view)[paletteIndex(data[i + 1], data[i + 2])];
          ctx.fillRect(px(x0 + c), py(y0 + r), size, size);
        }
      }
    }
  }

  // Pass 3: glyphs (numbers, flags, mines).
  if (zoom >= 8) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(zoom * 0.62)}px system-ui, sans-serif`;
    ctx.lineJoin = 'round';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = data[(r * cols + c) * 3];
        const state = b & ST_MASK;
        if (state === 0) continue;
        const sx = px(x0 + c);
        const sy = py(y0 + r);
        const mx = sx + zoom / 2;
        const my = sy + zoom / 2;
        if (state === ST_REVEALED) {
          const n = b & 0x0f;
          if (n > 0 && zoom >= 12) {
            ctx.lineWidth = Math.max(2, zoom * 0.14);
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.strokeText(String(n), mx, my + zoom * 0.04);
            ctx.fillStyle = NUMBER_COLORS[n];
            ctx.fillText(String(n), mx, my + zoom * 0.04);
          }
        } else if (state === ST_FLAG) {
          drawFlag(ctx, sx, sy, zoom);
        } else if (state === ST_MINE) {
          const exploded = (b & 1) === 1;
          let scale = 1;
          if (fx?.mines && !exploded) {
            const [ox, oy] = fx.mines.origin;
            const dist = Math.hypot(x0 + c - ox, y0 + r - oy);
            const delay = MINE_POP_DELAY_MS + Math.min(MINE_POP_MAX_DELAY_MS, dist * MINE_POP_STEP_MS);
            const t = (fx.now - fx.mines.t0 - delay) / MINE_POP_MS;
            scale = t <= 0 ? 0 : easeOutBack(Math.min(1, t));
          }
          if (scale > 0) drawMine(ctx, mx, my, zoom * scale, exploded);
        }
      }
    }
  } else {
    // Zoomed far out: show flags / mines as plain dots.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const state = data[(r * cols + c) * 3] & ST_MASK;
        if (state === ST_FLAG || state === ST_MINE) {
          ctx.fillStyle = state === ST_FLAG ? '#dc2626' : '#111827';
          ctx.fillRect(px(x0 + c) + 1, py(y0 + r) + 1, size - 2, size - 2);
        }
      }
    }
  }

  // Reveal ripple: cells still "opening" are covered by fog that fades out with a flash.
  if (fx?.ripple) {
    const { xs, ys, t0 } = fx.ripple;
    for (let i = 0; i < xs.length; i++) {
      const p = (fx.now - t0[i]) / RIPPLE_MS;
      if (p >= 1) continue;
      const c = xs[i] - x0;
      const r = ys[i] - y0;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const k = (r * cols + c) * 3;
      const sx = px(xs[i]);
      const sy = py(ys[i]);
      ctx.fillStyle = FOGGED[paletteIndex(data[k + 1], data[k + 2])];
      ctx.globalAlpha = p <= 0 ? 1 : 1 - p;
      ctx.fillRect(sx, sy, size, size);
      if (p > 0) {
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.35 * (1 - p) * p * 4; // brightest mid-pop
        ctx.fillRect(sx, sy, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  if (view !== 'preview') drawVignette(ctx, w, h);
}

function drawFlag(ctx: CanvasRenderingContext2D, sx: number, sy: number, z: number) {
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = Math.max(1, z * 0.07);
  ctx.beginPath();
  ctx.moveTo(sx + z * 0.38, sy + z * 0.18);
  ctx.lineTo(sx + z * 0.38, sy + z * 0.82);
  ctx.stroke();
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.moveTo(sx + z * 0.38, sy + z * 0.18);
  ctx.lineTo(sx + z * 0.78, sy + z * 0.36);
  ctx.lineTo(sx + z * 0.38, sy + z * 0.54);
  ctx.closePath();
  ctx.fill();
}

function drawMine(ctx: CanvasRenderingContext2D, mx: number, my: number, z: number, exploded: boolean) {
  if (exploded) {
    ctx.fillStyle = 'rgba(220, 38, 38, 0.85)';
    ctx.fillRect(mx - z / 2, my - z / 2, z, z);
  }
  ctx.fillStyle = '#111827';
  ctx.beginPath();
  ctx.arc(mx, my, z * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = Math.max(1, z * 0.07);
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 4;
    ctx.moveTo(mx - Math.cos(a) * z * 0.34, my - Math.sin(a) * z * 0.34);
    ctx.lineTo(mx + Math.cos(a) * z * 0.34, my + Math.sin(a) * z * 0.34);
  }
  ctx.stroke();
}

function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(40, 30, 10, 0)');
  g.addColorStop(1, 'rgba(40, 30, 10, 0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
