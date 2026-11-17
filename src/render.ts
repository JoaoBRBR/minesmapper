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
/** Revealed cells: bit 7 = inside a tidied-up area (plain ground, no glyphs or grid)... */
const ST_CLEAN = 0x80;
/** ...and bit 6 = it held a power-up. */
const ST_POWERUP = 0x40;
/** Hidden/flagged water cells: bit 6 = under see-through ice... */
const ST_ICE = 0x40;
/** ...and bit 7 (with ST_ICE) = a mine can be made out beneath it. */
const ST_ICE_MINE = 0x80;
/** A revealed, tidied-up cell: state bits say "revealed" and bit 7 is set. */
const isTidy = (b: number) => (b & (ST_MASK | ST_CLEAN)) === (ST_REVEALED | ST_CLEAN);

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
const SHADE_LEVELS = 32;

/** Old-paper tones. Unexplored ground is bare paper; revealed ground is an ink wash on it. */
const TONES = {
  light: { paper: [233, 217, 172] as RGB, grid: 'rgba(98, 70, 38, 0.24)' },
  dark: { paper: [62, 52, 42] as RGB, grid: 'rgba(236, 216, 176, 0.11)' },
};
type ToneName = keyof typeof TONES;
let toneName: ToneName = 'light';

const mixc = (a: number, b: number, t: number) => a + (b - a) * t;
const shadeFactor = (level: number) => 0.62 + 0.76 * ((level + 0.5) / SHADE_LEVELS);

function buildPalette(colour: (base: RGB, f: number) => RGB): string[] {
  const out: string[] = [];
  for (const base of BIOME_COLORS) {
    for (let l = 0; l < SHADE_LEVELS; l++) {
      const c = colour(base, shadeFactor(l));
      out.push(`rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`);
    }
  }
  return out;
}

const lit = (base: RGB, f: number): RGB => [Math.min(255, base[0] * f), Math.min(255, base[1] * f), Math.min(255, base[2] * f)];
const blend = (a: RGB, b: RGB, t: number): RGB => [mixc(a[0], b[0], t), mixc(a[1], b[1], t), mixc(a[2], b[2], t)];

let CLEAR: string[] = [];
let PAPER: string[] = [];
let REVIEW: string[] = [];
let ICE: string[] = [];
let paperTexture: HTMLCanvasElement | null = null;
let coloredNumbers = false;
/** Bumped whenever the look changes, so the game knows to redraw. */
export let visualsVersion = 0;
export const bumpVisuals = () => void visualsVersion++;

/** Picks the paper tone (light parchment or dark) and rebuilds the colour tables. */
export function setPaperTone(dark: boolean) {
  const next: ToneName = dark ? 'dark' : 'light';
  if (next === toneName && CLEAR.length) return;
  toneName = next;
  const paper = TONES[toneName].paper;
  // Revealed land: vivid, but washed into the paper a little so it feels printed on it.
  CLEAR = buildPalette((base, f) => blend(lit(base, f), paper, 0.1));
  // After the game ends, unexplored land is shown faded.
  REVIEW = buildPalette((base, f) => blend(lit(base, f), paper, 0.38));
  // Unexplored ground is bare paper: nothing about the terrain leaks through.
  const flat = `rgb(${paper[0]},${paper[1]},${paper[2]})`;
  PAPER = new Array(BIOME_COLORS.length * SHADE_LEVELS).fill(flat);
  // Ice: water you can faintly see through, a pale blue glaze over the paper.
  ICE = buildPalette((base, f) => blend(blend(lit(base, f), [196, 226, 242], 0.45), paper, 0.35));
  paperTexture = null;
  bumpVisuals();
}
setPaperTone(false);

/** Ink-written numbers (default) or the classic coloured ones. */
export function setNumberStyle(colored: boolean) {
  if (colored === coloredNumbers) return;
  coloredNumbers = colored;
  bumpVisuals();
}

/**
 * play    - fog of war: only revealed cells show their colours.
 * review  - game over / won: everything in colour, revealed cells still stand out.
 * preview - everything in full colour (world creator, menu background).
 */
export type ViewMode = 'play' | 'review' | 'preview';

function paletteFor(b: number, view: ViewMode): string[] {
  if (view === 'preview') return CLEAR;
  if (b === ST_VOID) return view === 'review' ? CLEAR : PAPER;
  const state = b & ST_MASK;
  if (state === ST_REVEALED) return CLEAR;
  if (view === 'play' && (state === 0 || state === ST_FLAG) && b & ST_ICE) return ICE;
  return view === 'review' ? REVIEW : PAPER;
}
const paletteIndex = (biome: number, shade: number) => biome * SHADE_LEVELS + (shade >> 3);

const NUMBER_COLORS = ['', '#1d4ed8', '#15803d', '#b91c1c', '#4c1d95', '#7c2d12', '#0e7490', '#111827', '#525252'];
const INK = '#2a1b0e';
const HAND_FONT = 'Kalam, "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';

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
  /** Chunks that were just finished: a shimmer sweeps over them (cell coordinates). */
  cleanups?: { x: number; y: number; size: number; t0: number }[];
  /** Loss sequence: mines pop outward from `origin`, starting at `t0`. */
  mines?: { t0: number; origin: [number, number] } | null;
}

export const RIPPLE_MS = 300;
export const CLEAN_FX_MS = 900;
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
  let hasTidy = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      hasVoid ||= data[i] === ST_VOID;
      hasTidy ||= isTidy(data[i]);
      ctx.fillStyle = paletteFor(data[i], view)[paletteIndex(data[i + 1], data[i + 2])];
      ctx.fillRect(px(x0 + c), py(y0 + r), size, size);
    }
  }

  // Pass 2: grid lines for fogged cells (so the frontier reads clearly).
  if (zoom >= 14) {
    ctx.strokeStyle = TONES[toneName].grid;
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
    if (hasVoid || hasTidy) {
      // Wipe the grid off water and off tidied-up ground, so only unfinished land is gridded.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = (r * cols + c) * 3;
          if (data[i] !== ST_VOID && !isTidy(data[i])) continue;
          ctx.fillStyle = paletteFor(data[i], view)[paletteIndex(data[i + 1], data[i + 2])];
          ctx.fillRect(px(x0 + c), py(y0 + r), size, size);
        }
      }
    }
  }

  // Pass 3: glyphs (numbers, flags, mines).
  if (zoom >= 8) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = coloredNumbers
      ? `700 ${Math.round(zoom * 0.62)}px system-ui, sans-serif`
      : `700 ${Math.round(zoom * 0.7)}px ${HAND_FONT}`;
    ctx.lineJoin = 'round';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = data[(r * cols + c) * 3];
        const state = b & ST_MASK;
        if (isTidy(b)) continue;
        const sx = px(x0 + c);
        const sy = py(y0 + r);
        const mx = sx + zoom / 2;
        const my = sy + zoom / 2;
        if (state === 0) {
          // A mine seen faintly through ice.
          if ((b & (ST_ICE | ST_ICE_MINE)) === (ST_ICE | ST_ICE_MINE)) {
            ctx.globalAlpha = 0.42;
            drawMine(ctx, mx, my, zoom * 0.9, false);
            ctx.globalAlpha = 1;
          }
          continue;
        }
        if (state === ST_REVEALED) {
          if (b & ST_POWERUP && zoom >= 12) drawStar(ctx, sx + zoom * 0.8, sy + zoom * 0.22, zoom * 0.2);
          const n = b & 0x0f;
          if (n > 0 && zoom >= 12) {
            if (coloredNumbers) {
              ctx.lineWidth = Math.max(2, zoom * 0.14);
              ctx.strokeStyle = 'rgba(255,255,255,0.85)';
              ctx.strokeText(String(n), mx, my + zoom * 0.04);
              ctx.fillStyle = NUMBER_COLORS[n];
              ctx.fillText(String(n), mx, my + zoom * 0.04);
            } else {
              // Written by hand: a touch of tilt and wobble that is stable per cell.
              const hsh = Math.imul(x0 + c, 73856093) ^ Math.imul(y0 + r, 19349663);
              const tilt = (((hsh >>> 3) % 9) - 4) * 0.013;
              const dx = (((hsh >>> 9) % 5) - 2) * zoom * 0.012;
              ctx.save();
              ctx.translate(mx + dx, my + zoom * 0.02);
              ctx.rotate(tilt);
              ctx.lineWidth = Math.max(1.5, zoom * 0.1);
              ctx.strokeStyle = 'rgba(247, 238, 212, 0.7)';
              ctx.strokeText(String(n), 0, 0);
              ctx.fillStyle = INK;
              ctx.fillText(String(n), 0, 0);
              ctx.restore();
            }
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
      ctx.fillStyle = PAPER[paletteIndex(data[k + 1], data[k + 2])];
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

  // Shimmer over chunks that were just tidied up.
  if (fx?.cleanups) {
    for (const f of fx.cleanups) {
      const p = (fx.now - f.t0) / CLEAN_FX_MS;
      if (p < 0 || p >= 1) continue;
      const rx = px(f.x);
      const ry = py(f.y);
      const rw = px(f.x + f.size) - rx;
      const rh = py(f.y + f.size) - ry;
      if (rx > w || ry > h || rx + rw < 0 || ry + rh < 0) continue;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 * (1 - p) ** 2})`;
      ctx.fillRect(rx, ry, rw, rh);
      const centre = p * 1.5 - 0.25; // a diagonal band sweeping corner to corner
      const g = ctx.createLinearGradient(rx, ry, rx + rw, ry + rh);
      const at = (t: number) => Math.min(1, Math.max(0, t));
      g.addColorStop(at(centre - 0.25), 'rgba(255,255,255,0)');
      g.addColorStop(at(centre), `rgba(255,255,255,${0.6 * (1 - p)})`);
      g.addColorStop(at(centre + 0.25), 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    }
  }

  if (view !== 'preview') drawPaperGrain(ctx, cam, w, h);
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.25);
  ctx.strokeStyle = '#78350f';
  ctx.stroke();
}

/**
 * Debug overlay: outlines the cleanup chunks, labels them with their chunk coordinates, and
 * highlights the finished ones (green, with a tick).
 */
export function drawChunkBorders(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  w: number,
  h: number,
) {
  const size = world.clean_chunk_size();
  const { zoom } = cam;
  const left = cam.cx - w / 2 / zoom;
  const top = cam.cy - h / 2 / zoom;
  const c0 = Math.floor(left / size);
  const c1 = Math.floor((left + w / zoom) / size);
  const r0 = Math.floor(top / size);
  const r1 = Math.floor((top + h / zoom) / size);
  const sx = (cx: number) => (cx * size - cam.cx) * zoom + w / 2;
  const sy = (cy: number) => (cy * size - cam.cy) * zoom + h / 2;
  const labels = size * zoom >= 70;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.lineWidth = 2;
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const x = sx(cx);
      const y = sy(cy);
      const side = size * zoom;
      const clean = world.is_chunk_clean(cx, cy);
      if (clean) {
        ctx.fillStyle = 'rgba(80, 255, 140, 0.07)';
        ctx.fillRect(x, y, side, side);
      }
      ctx.setLineDash(clean ? [] : [7, 5]);
      ctx.strokeStyle = clean ? 'rgba(80, 255, 140, 0.95)' : 'rgba(255, 255, 255, 0.6)';
      ctx.strokeRect(x + 1, y + 1, side - 2, side - 2);
      if (labels) {
        const text = clean ? `✓ ${cx},${cy}` : `${cx},${cy}`;
        ctx.setLineDash([]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeText(text, x + 6, y + 5);
        ctx.fillStyle = clean ? '#86efac' : '#ffffff';
        ctx.fillText(text, x + 6, y + 5);
        ctx.lineWidth = 2;
      }
    }
  }
  ctx.restore();
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

const TEX = 256;

/** A small seamless paper texture: soft stains, speckles and fibres. */
function makePaperTexture(dark: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const g = c.getContext('2d')!;
  let seed = 1337;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Draw every mark at 9 offsets so the tile repeats without seams.
  const wrap = (fn: (dx: number, dy: number) => void) => {
    for (const dx of [-TEX, 0, TEX]) for (const dy of [-TEX, 0, TEX]) fn(dx, dy);
  };
  const dim = dark ? '0,0,0' : '110,80,40';
  const lite = dark ? '255,235,200' : '255,250,235';

  for (let i = 0; i < 16; i++) {
    const x = rnd() * TEX;
    const y = rnd() * TEX;
    const r = 30 + rnd() * 70;
    const a = 0.03 + rnd() * 0.045;
    wrap((dx, dy) => {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      gr.addColorStop(0, `rgba(${dim},${a})`);
      gr.addColorStop(1, `rgba(${dim},0)`);
      g.fillStyle = gr;
      g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    });
  }
  for (let i = 0; i < 1100; i++) {
    const x = rnd() * TEX;
    const y = rnd() * TEX;
    g.fillStyle = `rgba(${rnd() < 0.6 ? dim : lite},${0.05 + rnd() * 0.14})`;
    const s = rnd() < 0.12 ? 2 : 1;
    wrap((dx, dy) => g.fillRect(x + dx, y + dy, s, s));
  }
  for (let i = 0; i < 170; i++) {
    const x = rnd() * TEX;
    const y = rnd() * TEX;
    const len = 6 + rnd() * 18;
    const ang = rnd() * Math.PI * 2;
    const bend = (rnd() - 0.5) * 6;
    g.strokeStyle = `rgba(${rnd() < 0.5 ? dim : lite},${0.05 + rnd() * 0.09})`;
    g.lineWidth = 0.6 + rnd() * 0.5;
    const ex = Math.cos(ang) * len;
    const ey = Math.sin(ang) * len;
    wrap((dx, dy) => {
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.quadraticCurveTo(x + dx + ex / 2 - Math.sin(ang) * bend, y + dy + ey / 2 + Math.cos(ang) * bend, x + dx + ex, y + dy + ey);
      g.stroke();
    });
  }
  return c;
}

/** Paper grain over the whole map, anchored to the map so it slides with panning. */
function drawPaperGrain(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number) {
  paperTexture ??= makePaperTexture(toneName === 'dark');
  const pattern = ctx.createPattern(paperTexture, 'repeat');
  if (!pattern) return;
  pattern.setTransform(new DOMMatrix().translate(w / 2 - cam.cx * cam.zoom, h / 2 - cam.cy * cam.zoom));
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
}
