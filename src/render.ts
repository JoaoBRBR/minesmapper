import type { World } from './wasm/pkg/minefield';
import { vintageParts } from './debug';
import { settings, type NumberStyle } from './settings';
import { drawGlyph } from './icons';

export interface Camera {
  /** World-space cell coordinate at the centre of the screen (fractional). */
  cx: number;
  cy: number;
  /** Pixels per cell. */
  zoom: number;
}

/** Default minimum zoom; island mode may go lower to fit the whole island. */
export const MIN_ZOOM = 6;
/** From this zoom the map is playable: numbers, flags and grid appear. Further out it is a plain map view. */
const phoneScreen = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px), (pointer: coarse)') : null;
/** The "zoom level switch": 20 on a computer, 15 on a phone (a finger needs bigger cells, but the screen is smaller). */
export const detailZoom = () => (phoneScreen?.matches ? 15 : 20);
export const MAX_ZOOM = 96;

const ST_MASK = 0x30;
const ST_FLAG = 0x10;
const ST_REVEALED = 0x20;
const ST_MINE = 0x30;
/** Hidden + low nibble 0xF: unplayable water around the island. */
const ST_VOID = 0x0f;
/** Open sea inside a cleared chunk: unplayable, but drawn in its water colour. */
const ST_SEA = 0x0e;
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
export const BIOME_COLORS: RGB[] = [
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
  [150, 150, 160], // regolith (space)
  [72, 76, 96], // crater floor (space)
  [208, 206, 216], // crater rim (space)
  [150, 200, 232], // moon ice (space)
];
const SHADE_LEVELS = 32;

/** Old-paper tones. Unexplored ground is bare paper; revealed ground is an ink wash on it. */
const TONES = {
  light: {
    paper: [233, 217, 172] as RGB,
    grid: 'rgba(98, 70, 38, 0.24)',
    coast: 'rgba(48, 32, 16, 0.9)', // edge of everything that is not part of the game
    found: 'rgba(60, 42, 22, 0.62)', // edge of everything you have discovered
    foam: 'rgba(70, 118, 158, 0.6)',
  },
  dark: {
    paper: [62, 52, 42] as RGB,
    grid: 'rgba(236, 216, 176, 0.11)',
    coast: 'rgba(244, 226, 188, 0.85)',
    found: 'rgba(236, 216, 176, 0.5)',
    foam: 'rgba(150, 196, 226, 0.5)',
  },
  // Moons and meteors: a dark star chart.
  space: {
    paper: [20, 24, 46] as RGB,
    grid: 'rgba(150, 175, 255, 0.15)',
    coast: 'rgba(196, 214, 255, 0.85)',
    found: 'rgba(196, 214, 255, 0.5)',
    foam: 'rgba(0, 0, 0, 0)',
  },
};
type ToneName = keyof typeof TONES;
let toneName: ToneName = 'light';
let wantDark = false;
let spaceMode = false;
let VOID_PAL: string[] = [];

const mixc = (a: number, b: number, t: number) => a + (b - a) * t;
const shadeFactor = (level: number) => 0.62 + 0.76 * ((level + 0.5) / SHADE_LEVELS);

const lit = (base: RGB, f: number): RGB => [Math.min(255, base[0] * f), Math.min(255, base[1] * f), Math.min(255, base[2] * f)];
const blend = (a: RGB, b: RGB, t: number): RGB => [mixc(a[0], b[0], t), mixc(a[1], b[1], t), mixc(a[2], b[2], t)];

let CLEAR: string[] = [];
let PAPER: string[] = [];
/** Unexplored ground while the map moves in map view: the paper darkened to what the grain and stain average out to. */
let PAPER_MOVING: string[] = [];
let REVIEW: string[] = [];
let ICE: string[] = [];
/** Engraved numbers are cut into the ground: a darker shade of the cell's own colour, with a pale lip. */
let ENGRAVE_DARK: string[] = [];
let ENGRAVE_LIGHT: string[] = [];
/** "Simple colors": while playing, everything you have opened is one plain colour. */
let simpleColors = false;
let SIMPLE: string[] = [];
let SIMPLE_INK = '#3a2f22';
let SIMPLE_LIP = 'rgba(255,255,255,0.7)';
let paperTexture: HTMLCanvasElement | null = null;
let numberStyle: NumberStyle = 'engraved';
/** Bumped whenever the look changes, so the game knows to redraw. */
export let visualsVersion = 0;
export const bumpVisuals = () => void visualsVersion++;

/** Picks the paper tone (light parchment or dark) and rebuilds the colour tables. */
export function setPaperTone(dark: boolean) {
  wantDark = dark;
  rebuildTone();
}

/** Space maps are drawn on a dark star chart whatever the paper setting is. */
export function setSpaceTone(on: boolean) {
  if (on === spaceMode) return;
  spaceMode = on;
  rebuildTone();
}

function rebuildTone() {
  const next: ToneName = spaceMode ? 'space' : wantDark ? 'dark' : 'light';
  if (next === toneName && CLEAR.length) return;
  toneName = next;
  const paper = TONES[toneName].paper;
  // In space the two "water" biomes are the void: nearly black.
  const baseOf = (base: RGB, index: number): RGB => (spaceMode && index < 2 ? [8, 10, 26] : base);
  const bake = (colour: (base: RGB, f: number) => RGB): string[] => {
    const out: string[] = [];
    BIOME_COLORS.forEach((base0, bi) => {
      const base = baseOf(base0, bi);
      for (let l = 0; l < SHADE_LEVELS; l++) {
        const c = colour(base, shadeFactor(l));
        out.push(`rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`);
      }
    });
    return out;
  };
  // Revealed land: vivid, but washed into the paper a little so it feels printed on it.
  CLEAR = bake((base, f) => blend(lit(base, f), paper, 0.1));
  // After the game ends, unexplored land is shown faded.
  REVIEW = bake((base, f) => blend(lit(base, f), paper, 0.38));
  const ground = (base: RGB, f: number) => blend(lit(base, f), paper, 0.1);
  ENGRAVE_DARK = bake((base, f) => {
    const g = ground(base, f);
    return [g[0] * 0.5, g[1] * 0.5, g[2] * 0.5];
  });
  ENGRAVE_LIGHT = bake((base, f) => {
    const g = ground(base, f);
    return [Math.min(255, g[0] * 1.2 + 26), Math.min(255, g[1] * 1.2 + 26), Math.min(255, g[2] * 1.2 + 26)];
  });
  // Unexplored ground is bare paper: nothing about the terrain leaks through.
  const flat = `rgb(${paper[0]},${paper[1]},${paper[2]})`;
  PAPER = new Array(BIOME_COLORS.length * SHADE_LEVELS).fill(flat);
  // measured: the paper grain makes the unexplored ground this much darker on average
  const k: RGB = toneName === 'light' ? [0.974, 0.97, 0.963] : toneName === 'dark' ? [0.954, 0.954, 0.952] : [0.96, 0.96, 0.96];
  const movingPaper = `rgb(${Math.round(paper[0] * k[0])},${Math.round(paper[1] * k[1])},${Math.round(paper[2] * k[2])})`;
  PAPER_MOVING = new Array(BIOME_COLORS.length * SHADE_LEVELS).fill(movingPaper);
  VOID_PAL = new Array(BIOME_COLORS.length * SHADE_LEVELS).fill('rgb(5,8,28)');
  // Ice: water you can faintly see through. Mostly solid blue, with just a hint of glaze.
  ICE = bake((base, f) => blend(blend(lit(base, f), [140, 196, 228], 0.2), paper, 0.08));
  // One flat colour: pale on the light paper, dark on the dark paper, always clearly apart from
  // the unexplored ground (and the numbers get the opposite lightness so they stay readable).
  const plain: RGB = toneName === 'light' ? [247, 248, 242] : toneName === 'dark' ? [30, 29, 28] : [56, 64, 104];
  SIMPLE = new Array(BIOME_COLORS.length * SHADE_LEVELS).fill(`rgb(${plain[0]},${plain[1]},${plain[2]})`);
  SIMPLE_INK = toneName === 'light' ? '#3a2f22' : '#ece6d6';
  SIMPLE_LIP = toneName === 'light' ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.65)';
  paperTexture = null;
  bumpVisuals();
}
setPaperTone(false);

/** Turns the one-colour view on or off (it only affects the play view, not the end-of-game review). */
export function setSimpleColors(on: boolean) {
  if (on === simpleColors) return;
  simpleColors = on;
  bumpVisuals();
}

/** Engraved (default), hand-written or classic coloured numbers. */
export function setNumberStyle(style: NumberStyle) {
  if (style === numberStyle) return;
  numberStyle = style;
  bumpVisuals();
}

/**
 * play    - fog of war: only revealed cells show their colours.
 * review  - game over / won: everything in colour, revealed cells still stand out.
 * preview - everything in full colour (world creator, menu background).
 * progress - simplified: what you found is green, what you have not is dark (not playable).
 */
export type ViewMode = 'play' | 'review' | 'preview' | 'progress';

function paletteFor(b: number, view: ViewMode): string[] {
  if (view === 'preview') return CLEAR;
  if (b === ST_SEA) return simpleColors && view === 'play' ? SIMPLE : CLEAR;
  const paper = fakeVintage && view === 'play' ? PAPER_MOVING : PAPER;
  if (b === ST_VOID) return spaceMode ? VOID_PAL : view === 'review' ? CLEAR : paper;
  const state = b & ST_MASK;
  if (state === ST_REVEALED) return simpleColors && view === 'play' ? SIMPLE : CLEAR;
  if (view === 'play' && (state === 0 || state === ST_FLAG) && b & ST_ICE) return ICE;
  return view === 'review' ? REVIEW : paper;
}
/** Progress view colours: found is green, not found is dark, and the sea is darker still. */
function progressFill(b: number): string {
  if (b === ST_VOID || b === ST_SEA) return '#10161c';
  const state = b & ST_MASK;
  if (state === ST_REVEALED) return '#58a96a';
  if (state === ST_MINE && (b & 1) === 1) return '#c0392b'; // the mine that ended the game
  return '#34353b';
}

const isVoidCell = (b: number) => b === ST_VOID || b === ST_SEA;
const isFoundCell = (b: number) => (b & ST_MASK) === ST_REVEALED;

const paletteIndex = (biome: number, shade: number) => biome * SHADE_LEVELS + (shade >> 3);

const NUMBER_COLORS = ['', '#1d4ed8', '#15803d', '#b91c1c', '#4c1d95', '#7c2d12', '#0e7490', '#111827', '#525252'];
const INK = '#2a1b0e';
/** Negative numbers are purple in every number style. */
const NEG_PURPLE = '#8b2fd6';
const ENGRAVED_FONT = 'Cinzel, "Trajan Pro", Palatino, Georgia, serif';

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
  /** Animate the shoreline of an island with gentle waves. */
  waves?: boolean;
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

// --- Low zoom: the cells are painted as one small image instead of one rectangle each ---------------
// Below this zoom there are thousands of tiny cells, and a fillRect per cell is what made zooming out
// slow. Instead each cell becomes one pixel of a cols x rows image that is drawn scaled up in a single call.
/** Soft, blotchy variation per cell (two octaves of value noise), a cheap stand-in for the paper grain. */
const hash2 = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function valueNoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const paperMottle = (wx: number, wy: number) => {
  const n = valueNoise(wx / 7, wy / 7) * 0.65 + valueNoise(wx / 2.6 + 50, wy / 2.6 + 50) * 0.35;
  return 1 + (n - 0.5) * 0.09; // about +-4.5%, centred on 1 so the average tone stays put
};
function scaleU32(c: number, f: number): number {
  const r = Math.min(255, (c & 255) * f);
  const g = Math.min(255, ((c >>> 8) & 255) * f);
  const b = Math.min(255, ((c >>> 16) & 255) * f);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
const u32Cache = new WeakMap<string[], Uint32Array>();
const colourU32 = new Map<string, number>();
function toU32(css: string): number {
  let v = colourU32.get(css);
  if (v === undefined) {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css);
    const [r, g, b] = m ? [+m[1], +m[2], +m[3]] : [255, 0, 255];
    v = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; // little-endian RGBA
    if (colourU32.size < 64) colourU32.set(css, v);
  }
  return v;
}
function paletteU32(pal: string[]): Uint32Array {
  let out = u32Cache.get(pal);
  if (!out) {
    out = new Uint32Array(pal.length);
    for (let i = 0; i < pal.length; i++) out[i] = toU32(pal[i]);
    u32Cache.set(pal, out);
  }
  return out;
}
interface PixelLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  u32: Uint32Array;
}
const layers: PixelLayer[] = [];
function layer(i: number, cols: number, rows: number): PixelLayer | null {
  let l = layers[i];
  if (!l || l.canvas.width !== cols || l.canvas.height !== rows) {
    const canvas = l?.canvas ?? document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const c = canvas.getContext('2d');
    if (!c) return null;
    const image = c.createImageData(cols, rows);
    l = { canvas, ctx: c, image, u32: new Uint32Array(image.data.buffer) };
    layers[i] = l;
  }
  return l;
}
function blitLayer(ctx: CanvasRenderingContext2D, l: PixelLayer, dx: number, dy: number, dw: number, dh: number) {
  l.ctx.putImageData(l.image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(l.canvas, 0, 0, l.canvas.width, l.canvas.height, dx, dy, dw, dh);
  ctx.imageSmoothingEnabled = true;
}


/** Map view: the real grain is not drawn, so the paper gets its averaged darker tone with a cheap mottling instead. */
let fakeVintage = false;

export function draw(
  ctx: CanvasRenderingContext2D,
  world: World,
  cam: Camera,
  w: number,
  h: number,
  view: ViewMode = 'play',
  fx?: Fx,
) {
  setSpaceTone(world.is_space());
  const { zoom } = cam;
  fakeVintage = zoom < detailZoom() && vintageParts().grain;
  const x0 = Math.floor(cam.cx - w / 2 / zoom);
  const y0 = Math.floor(cam.cy - h / 2 / zoom);
  const cols = Math.ceil(w / zoom) + 2;
  const rows = Math.ceil(h / zoom) + 2;
  const data = world.view(x0, y0, cols, rows);
  const size = Math.ceil(zoom);
  const px = (x: number) => Math.floor((x - cam.cx) * zoom + w / 2);
  const py = (y: number) => Math.floor((y - cam.cy) * zoom + h / 2);

  const progress = view === 'progress';
  const at = (r: number, c: number) => data[(r * cols + c) * 3];

  const usePixels = zoom < detailZoom() && !progress;
  const base = usePixels ? layer(0, cols, rows) : null;
  const found = usePixels && (view === 'play' || view === 'review') ? layer(1, cols, rows) : null;
  const edges = view !== 'preview' ? collectEdges(data, cols, rows, x0, y0, px, py) : null;
  const dx = (x0 - cam.cx) * zoom + w / 2;
  const dy = (y0 - cam.cy) * zoom + h / 2;

  if (base) {
    // Pass 1 (one pixel per cell): terrain + state tint. Unplayable water is never fogged.
    const out = base.u32;
    const out2 = found?.u32;
    let lastPal: string[] | null = null;
    let lastU32 = out; // placeholder until the first cell sets it
    for (let i = 0, n = cols * rows; i < n; i++) {
      const k = i * 3;
      const b = data[k];
      const p = paletteFor(b, view);
      if (p !== lastPal) {
        lastPal = p;
        lastU32 = paletteU32(p);
      }
      let col = lastU32[paletteIndex(data[k + 1], data[k + 2])];
      if (p === PAPER_MOVING) col = scaleU32(col, paperMottle(x0 + (i % cols), y0 + Math.floor(i / cols)));
      out[i] = col;
      if (out2) out2[i] = isFoundCell(b) || b === ST_SEA ? out[i] : 0;
    }
    blitLayer(ctx, base, dx, dy, cols * zoom, rows * zoom);
  } else {
    // Pass 1: terrain + state tint. Unplayable water is never fogged.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        ctx.fillStyle = progress ? progressFill(data[i]) : paletteFor(data[i], view)[paletteIndex(data[i + 1], data[i + 2])];
        ctx.fillRect(px(x0 + c), py(y0 + r), size, size);
      }
    }
  }

  // The paper grain belongs to the undiscovered ground only: lay it over everything, then
  // repaint what you have discovered so that stays clean and easy to read.
  if (view === 'play' || view === 'review') {
    if (zoom >= detailZoom()) {
      const v = vintageParts();
      if (v.grain) drawPaperGrain(ctx, cam, w, h);
      if (v.stain && edges) drawFrontierStain(ctx, edges.found, zoom);
    }
    if (found) {
      blitLayer(ctx, found, dx, dy, cols * zoom, rows * zoom);
    } else {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = (r * cols + c) * 3;
          if (!isFoundCell(data[i]) && data[i] !== ST_SEA) continue;
          ctx.fillStyle = paletteFor(data[i], view)[paletteIndex(data[i + 1], data[i + 2])];
          ctx.fillRect(px(x0 + c), py(y0 + r), size, size);
        }
      }
    }
  }

  if (view === 'play' && !spaceMode && zoom < detailZoom() && settings.mapDrawings && world.is_island()) {
    drawMapPictures(ctx, data, cols, rows, x0, y0, cam, w, h);
  }

  if (spaceMode) drawStars(ctx, data, cols, rows, x0, y0, px, py, zoom);

  // Pass 2: grid lines, only around cells that are still part of the puzzle (not water, not tidied).
  if (zoom >= detailZoom() && !progress) {
    const gridded = (b: number) => !isVoidCell(b) && !isTidy(b);
    ctx.strokeStyle = TONES[toneName].grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!gridded(at(r, c))) continue;
        const x = px(x0 + c) + 0.5;
        const y = py(y0 + r) + 0.5;
        const x2 = px(x0 + c + 1) + 0.5;
        const y2 = py(y0 + r + 1) + 0.5;
        ctx.moveTo(x2, y);
        ctx.lineTo(x2, y2);
        ctx.moveTo(x, y2);
        ctx.lineTo(x2, y2);
        if (c === 0 || !gridded(at(r, c - 1))) {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y2);
        }
        if (r === 0 || !gridded(at(r - 1, c))) {
          ctx.moveTo(x, y);
          ctx.lineTo(x2, y);
        }
      }
    }
    ctx.stroke();
  }

  // Outlines: a firm line around everything that is not part of the game, and a softer one
  // around everything you have discovered (so sand never melts into the paper).
  if (edges) strokeOutlines(ctx, edges, zoom, progress);
  if (progress) return;

  // Pass 3: glyphs (numbers, flags, mines).
  if (zoom >= detailZoom()) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font =
      numberStyle === 'colored'
        ? `700 ${Math.round(zoom * 0.62)}px system-ui, sans-serif`
        : `700 ${Math.round(zoom * 0.6)}px ${ENGRAVED_FONT}`;
    ctx.lineJoin = 'round';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = (r * cols + c) * 3;
        const b = data[k];
        const state = b & ST_MASK;
        if (isTidy(b)) continue;
        const sx = px(x0 + c);
        const sy = py(y0 + r);
        const mx = sx + zoom / 2;
        const my = sy + zoom / 2;
        if (state === 0) {
          // A mine seen faintly through ice.
          if ((b & (ST_ICE | ST_ICE_MINE)) === (ST_ICE | ST_ICE_MINE)) {
            ctx.globalAlpha = 0.5;
            drawMine(ctx, mx, my, zoom * 0.9, false);
            ctx.globalAlpha = 1;
          }
          continue;
        }
        if (state === ST_REVEALED) {
          if (b & ST_POWERUP && zoom >= detailZoom()) {
            // an ice clearer (shade bit 0) is an ice crystal; an oracle is the gold star
            drawPickup(ctx, sx + zoom * 0.7, sy + zoom * 0.3, zoom, (data[k + 2] & 1) === 1);
          }
          const n = b & 0x0f;
          // space: a purple number is negative, and a "0" can hide mines that cancel out
          const neg = spaceMode && (data[k + 2] & 2) !== 0;
          const zero = spaceMode && (data[k + 2] & 4) !== 0;
          const text = neg ? `\u2212${n}` : String(n);
          if ((n > 0 || zero) && zoom >= detailZoom()) {
            if (numberStyle === 'colored') {
              ctx.lineWidth = Math.max(2, zoom * 0.14);
              ctx.strokeStyle = 'rgba(255,255,255,0.85)';
              ctx.strokeText(text, mx, my + zoom * 0.04);
              ctx.fillStyle = neg ? NEG_PURPLE : NUMBER_COLORS[n] || '#374151';
              ctx.fillText(text, mx, my + zoom * 0.04);
            } else if (numberStyle === 'engraved') {
              // Engraved into the ground: the cell's own colour, darker, with a pale lip along the
              // lower edge, perfectly upright like a stamped map.
              const pi = paletteIndex(data[k + 1], data[k + 2]);
              const plainView = simpleColors && view === 'play';
              ctx.fillStyle = neg ? '#e6cdfb' : plainView ? SIMPLE_LIP : ENGRAVE_LIGHT[pi];
              ctx.fillText(text, mx + zoom * 0.03, my + zoom * 0.055);
              ctx.fillStyle = neg ? (plainView && toneName !== 'light' ? '#c58bf2' : '#5b1c99') : plainView ? SIMPLE_INK : ENGRAVE_DARK[pi];
              ctx.fillText(text, mx, my + zoom * 0.02);
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
              ctx.strokeText(text, 0, 0);
              ctx.fillStyle = neg ? NEG_PURPLE : INK;
              ctx.fillText(text, 0, 0);
              ctx.restore();
            }
          }
        } else if (state === ST_FLAG) {
          drawFlag(ctx, sx, sy, zoom, spaceMode && (data[k + 2] & 2) !== 0);
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
          if (scale > 0) drawMine(ctx, mx, my, zoom * scale, exploded, spaceMode && (data[k + 2] & 2) !== 0);
        }
      }
    }
  } else {
    // Zoomed far out: show flags / mines as plain dots.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const state = data[(r * cols + c) * 3] & ST_MASK;
        if (state === ST_FLAG || state === ST_MINE) {
          const negative = spaceMode && (data[(r * cols + c) * 3 + 2] & 2) !== 0;
          ctx.fillStyle = state === ST_FLAG ? (negative ? '#9333ea' : '#dc2626') : negative ? '#6b21a8' : '#111827';
          ctx.fillRect(px(x0 + c) + 1, py(y0 + r) + 1, size - 2, size - 2);
        }
      }
    }
  }

  if (fx?.waves && !spaceMode && (view === 'play' || view === 'review')) {
    drawWaves(ctx, data, cols, rows, x0, y0, px, py, zoom, fx.now);
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

}

/** A power-up waiting to be tapped: the picture on a soft halo, so it is hard to miss. */
/** Stars in the void around a meteor: a few points per cell, fixed for each cell. */
function drawStars(
  ctx: CanvasRenderingContext2D,
  data: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  px: (x: number) => number,
  py: (y: number) => number,
  zoom: number,
) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isVoidCell(data[(r * cols + c) * 3])) continue;
      const hsh = Math.imul(x0 + c, 374761393) ^ Math.imul(y0 + r, 668265263);
      const m = Math.imul(hsh ^ (hsh >>> 13), 1274126177) >>> 0;
      if (m % 100 > 14) continue;
      const sx = px(x0 + c) + ((m >>> 8) % 100) / 100 * zoom;
      const sy = py(y0 + r) + ((m >>> 16) % 100) / 100 * zoom;
      const big = m % 7 === 0;
      ctx.globalAlpha = 0.45 + ((m >>> 4) % 55) / 100;
      ctx.fillStyle = m % 5 === 0 ? '#ffe8b0' : m % 5 === 1 ? '#bcd4ff' : '#ffffff';
      const sz = Math.max(1, Math.round(zoom * (big ? 0.07 : 0.04)));
      ctx.fillRect(sx, sy, sz, sz);
    }
  }
  ctx.globalAlpha = 1;
}

function drawPickup(ctx: CanvasRenderingContext2D, cx: number, cy: number, z: number, ice: boolean) {
  ctx.fillStyle = ice ? 'rgba(140, 210, 250, 0.55)' : 'rgba(255, 205, 70, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, z * 0.34, 0, Math.PI * 2);
  ctx.fill();
  drawGlyph(ctx, ice ? 'ice-crystal' : 'oracle-glass', cx - z * 0.3, cy - z * 0.3, z * 0.6);
}

/** Segments where two neighbouring cells differ, found by comparing each cell with the one to its right and below. */
function forEachEdge(
  data: Uint8Array,
  cols: number,
  rows: number,
  visit: (r: number, c: number, dir: 'v' | 'h', a: number, b: number) => void,
) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = data[(r * cols + c) * 3];
      if (c + 1 < cols) visit(r, c, 'v', a, data[(r * cols + c + 1) * 3]);
      if (r + 1 < rows) visit(r, c, 'h', a, data[((r + 1) * cols + c) * 3]);
    }
  }
}

interface Edges {
  /** Between what is part of the game and what is not (the sea). */
  coast: Path2D;
  /** Between discovered and undiscovered ground. */
  found: Path2D;
}

function collectEdges(
  data: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  px: (x: number) => number,
  py: (y: number) => number,
): Edges {
  const coast = new Path2D();
  const found = new Path2D();
  forEachEdge(data, cols, rows, (r, c, dir, a, b) => {
    const voidA = isVoidCell(a);
    const voidB = isVoidCell(b);
    const path = voidA !== voidB ? coast : !voidA && isFoundCell(a) !== isFoundCell(b) ? found : null;
    if (!path) return;
    if (dir === 'v') {
      const x = px(x0 + c + 1) + 0.5;
      path.moveTo(x, py(y0 + r));
      path.lineTo(x, py(y0 + r + 1));
    } else {
      const y = py(y0 + r + 1) + 0.5;
      path.moveTo(px(x0 + c), y);
      path.lineTo(px(x0 + c + 1), y);
    }
  });
  return { coast, found };
}

function strokeOutlines(ctx: CanvasRenderingContext2D, edges: Edges, zoom: number, progress: boolean) {
  const tone = TONES[toneName];
  ctx.lineCap = 'square';
  ctx.lineWidth = Math.max(1, Math.min(2.4, zoom * 0.12));
  ctx.strokeStyle = progress ? 'rgba(20, 40, 25, 0.75)' : tone.found;
  ctx.stroke(edges.found);
  ctx.lineWidth = Math.max(1.4, Math.min(3, zoom * 0.16));
  ctx.strokeStyle = progress ? 'rgba(220, 236, 228, 0.7)' : tone.coast;
  ctx.stroke(edges.coast);
  ctx.lineCap = 'butt';
}

/**
 * A soft, aged stain on the paper along the edge of what you have discovered, like damp creeping
 * in from the edge of a worked sheet. Gentle up close, wider and a little stronger from above.
 * It is drawn before the discovered cells are repainted, so only the undiscovered side shows it.
 */
function drawFrontierStain(ctx: CanvasRenderingContext2D, found: Path2D, zoom: number) {
  const far = 1 - Math.min(1, Math.max(0, (zoom - 4) / 36)); // 1 when zoomed far out, 0 up close
  const width = 8 + far * 26;
  const alpha = 0.05 + far * 0.08;
  const dark = toneName === 'dark';
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [scale, weight] of [[1, 0.45], [0.62, 0.7], [0.3, 1]] as const) {
    ctx.lineWidth = width * scale;
    ctx.strokeStyle = dark ? `rgba(0, 0, 0, ${alpha * weight * 1.7})` : `rgba(120, 76, 32, ${alpha * weight})`;
    ctx.stroke(found);
  }
  ctx.restore();
}

/** Gentle waves lapping at the shore: wavy lines just outside every stretch of coast. */
function drawWaves(
  ctx: CanvasRenderingContext2D,
  data: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  px: (x: number) => number,
  py: (y: number) => number,
  zoom: number,
  now: number,
) {
  const t = now / 700;
  const amp = Math.min(3.2, zoom * 0.1);
  const tone = TONES[toneName];
  ctx.lineWidth = Math.max(1, Math.min(1.8, zoom * 0.08));
  const lines: [Path2D, string, number][] = [
    [new Path2D(), tone.foam, 0.22],
    [new Path2D(), tone.foam.replace(/[\d.]+\)$/, '0.32)'), 0.5],
  ];
  forEachEdge(data, cols, rows, (r, c, dir, a, b) => {
    const voidA = isVoidCell(a);
    if (voidA === isVoidCell(b)) return;
    // the normal points from the island into the sea
    let nx = 0;
    let ny = 0;
    if (dir === 'v') nx = voidA ? -1 : 1;
    else ny = voidA ? -1 : 1;
    const ex = dir === 'v' ? px(x0 + c + 1) : px(x0 + c);
    const ey = dir === 'v' ? py(y0 + r) : py(y0 + r + 1);
    const len = zoom;
    const tx = dir === 'v' ? 0 : len;
    const ty = dir === 'v' ? len : 0;
    const phase = t + (c + x0) * 0.9 + (r + y0) * 0.7;
    for (let k = 0; k < lines.length; k++) {
      const [path, , off] = lines[k];
      const o = zoom * off + amp * Math.sin(phase + k * 1.7);
      const sx = ex + nx * o;
      const sy = ey + ny * o;
      path.moveTo(sx, sy);
      path.quadraticCurveTo(sx + tx / 2 + nx * amp * Math.cos(phase * 1.3 + k), sy + ty / 2 + ny * amp * Math.cos(phase * 1.3 + k), sx + tx, sy + ty);
    }
  });
  for (const [path, colour] of lines) {
    ctx.strokeStyle = colour;
    ctx.stroke(path);
  }
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

function drawFlag(ctx: CanvasRenderingContext2D, sx: number, sy: number, z: number, negative = false) {
  drawGlyph(ctx, negative ? 'flag-negative' : 'flag', sx, sy, z);
}

function drawMine(ctx: CanvasRenderingContext2D, mx: number, my: number, z: number, exploded: boolean, negative = false) {
  if (exploded) {
    ctx.fillStyle = 'rgba(220, 38, 38, 0.85)';
    ctx.fillRect(mx - z / 2, my - z / 2, z, z);
  }
  drawGlyph(ctx, negative ? 'mine-negative' : 'mine', mx - z / 2, my - z / 2, z);
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

// --- Old-chart drawings (islands, map view) --------------------------------------------------------
// Little pictures from art/chart/: one per biome inside the island, waves / a ship / sea monsters on the
// open sea, a lake picture on lakes. They keep one size on screen at every zoom, sit at fixed spots of the
// world (so they stay put while panning) and are skipped near anything you have discovered.

const chartUrls = import.meta.glob('../art/chart/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const chartImages = new Map<string, HTMLImageElement>();
for (const [path, url] of Object.entries(chartUrls)) {
  const name = path.split('/').pop()!.replace('.svg', '');
  const img = new Image();
  img.onload = () => bumpVisuals(); // redraw once a picture has arrived
  img.src = url;
  chartImages.set(name, img);
}
const WATER_PICTURES = new Set(['wave-1', 'wave-2', 'wave-3', 'lake', 'ship', 'monster-serpent', 'monster-kraken']);
const chartTinted = new Map<string, HTMLCanvasElement>();
const CHART_PX = 128; // the pictures are rasterised once at this size and scaled down when drawn

/** The picture in the ink of the current paper (cached). */
function chartSprite(name: string): HTMLCanvasElement | null {
  const img = chartImages.get(name);
  if (!img || !img.complete || !img.naturalWidth) return null;
  const water = WATER_PICTURES.has(name);
  const ink =
    toneName === 'dark'
      ? water ? 'rgba(172, 172, 176, 0.62)' : 'rgba(186, 182, 172, 0.66)'
      : water ? 'rgba(28, 42, 60, 0.82)' : 'rgba(66, 44, 22, 0.82)';
  const key = `${name}|${ink}`;
  let c = chartTinted.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = CHART_PX;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, CHART_PX, CHART_PX);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = ink;
    g.fillRect(0, 0, CHART_PX, CHART_PX);
    chartTinted.set(key, c);
  }
  return c;
}

/** Draws one chart picture centred on a screen point, `size` CSS pixels wide. */
export function drawChartPicture(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, size: number) {
  const c = chartSprite(name);
  if (c) ctx.drawImage(c, x - size / 2, y - size / 2, size, size);
}

/** Which picture a biome gets, how big it is, and how often (per block). */
const LAND_PICTURES: Record<number, [string, number, number]> = {
  3: ['desert', 50, 0.45],
  4: ['badlands', 50, 0.45],
  5: ['savanna', 48, 0.4],
  6: ['grassland', 48, 0.35],
  7: ['forest', 56, 0.7],
  8: ['jungle', 56, 0.7],
  9: ['swamp', 50, 0.5],
  10: ['taiga', 56, 0.7],
  11: ['tundra', 48, 0.45],
  12: ['mountain-rock', 60, 0.75],
  13: ['mountain-snow', 60, 0.75],
};

function drawMapPictures(
  ctx: CanvasRenderingContext2D,
  data: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  cam: Camera,
  w: number,
  h: number,
) {
  const zoom = cam.zoom;
  const cellAt = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? -1 : (r * cols + c) * 3);
  // blocks of the world, as big as `px` pixels on screen (rounded up to a power of two of cells)
  const grid = (px: number, salt: number, visit: (wx: number, wy: number, hA: number, c: number, r: number) => void) => {
    const block = Math.pow(2, Math.max(0, Math.ceil(Math.log2(px / zoom))));
    const bx0 = Math.floor(x0 / block) - 1;
    const bx1 = Math.floor((x0 + cols) / block) + 1;
    const by0 = Math.floor(y0 / block) - 1;
    const by1 = Math.floor((y0 + rows) / block) + 1;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const hA = hash2(bx * 7 + block + salt, by * 13 + 3);
        const wx = (bx + 0.2 + 0.6 * hash2(bx + 11 + salt, by + 5)) * block;
        const wy = (by + 0.2 + 0.6 * hash2(bx + 29 + salt, by + 17)) * block;
        const c = Math.floor(wx) - x0;
        const r = Math.floor(wy) - y0;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        visit(wx, wy, hA, c, r);
      }
    }
  };
  const toScreenX = (wx: number) => (wx - cam.cx) * zoom + w / 2;
  const toScreenY = (wy: number) => (wy - cam.cy) * zoom + h / 2;
  /** True when ground you have discovered is within the picture's reach. */
  const nearFound = (c: number, r: number, size: number) => {
    const m = Math.max(1, Math.ceil(size / 2 / zoom));
    for (const [dc, dr] of [[0, 0], [-m, 0], [m, 0], [0, -m], [0, m]]) {
      const k = cellAt(c + dc, r + dr);
      if (k >= 0 && (isFoundCell(data[k]) || isTidy(data[k]))) return true;
    }
    return false;
  };

  // the open sea: waves, and now and then a ship or a sea monster
  grid(80, 0, (wx, wy, hA, c, r) => {
    if (data[cellAt(c, r)] !== ST_VOID) return;
    let name: string;
    let size = 40;
    if (hA < 0.025) [name, size] = ['ship', 60];
    else if (hA < 0.05) [name, size] = ['monster-serpent', 68];
    else if (hA < 0.075) [name, size] = ['monster-kraken', 68];
    else if (hA < 0.72) name = `wave-${1 + (Math.floor(hA * 1000) % 3)}`;
    else return;
    drawChartPicture(ctx, name, toScreenX(wx), toScreenY(wy), size);
  });

  // inside the island: one picture for the biome under each spot, and a picture on lakes
  grid(112, 500, (wx, wy, hA, c, r) => {
    const k = cellAt(c, r);
    const b = data[k];
    if (b === ST_VOID || b === ST_SEA || isFoundCell(b) || isTidy(b)) return;
    const biome = data[k + 1];
    if (biome <= 1) {
      // water inside the island: a lake
      if (hA < 0.6 && !nearFound(c, r, 50)) drawChartPicture(ctx, 'lake', toScreenX(wx), toScreenY(wy), 50);
      return;
    }
    const pic = LAND_PICTURES[biome];
    if (!pic || hA > pic[2] || nearFound(c, r, pic[1])) return;
    drawChartPicture(ctx, pic[0], toScreenX(wx), toScreenY(wy), pic[1]);
  });

  // beaches are thin: a finer grid so palm trees line the shore
  grid(60, 900, (wx, wy, hA, c, r) => {
    const k = cellAt(c, r);
    const b = data[k];
    if (b === ST_VOID || b === ST_SEA || isFoundCell(b) || isTidy(b) || data[k + 1] !== 2) return;
    if (hA < 0.5 && !nearFound(c, r, 40)) drawChartPicture(ctx, 'beach', toScreenX(wx), toScreenY(wy), 40);
  });
}

/** The zoom at which the grain tile is drawn at its natural size. */
const GRAIN_REF_ZOOM = 32;

/**
 * The paper grain belongs to the ground, so it grows and shrinks with the map. To keep fine detail at
 * every zoom, two copies one octave apart are cross-faded: while zooming in, the finer one fades in as the
 * coarser one fades out (and the other way round zooming out), like mip levels.
 */
function drawPaperGrain(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number) {
  paperTexture ??= makePaperTexture(toneName !== 'light');
  const L = Math.log2(cam.zoom / GRAIN_REF_ZOOM);
  const sA = Math.pow(2, L - Math.floor(L)); // 1 .. 2: scale of the coarser layer
  const originX = w / 2 - cam.cx * cam.zoom;
  const originY = h / 2 - cam.cy * cam.zoom;
  const stamp = (scale: number, alpha: number) => {
    if (alpha < 0.02) return;
    const size = TEX * scale;
    const sx = (((originX % size) + size) % size) - size;
    const sy = (((originY % size) + size) % size) - size;
    ctx.globalAlpha = alpha;
    for (let y = sy; y < h; y += size) {
      for (let x = sx; x < w; x += size) ctx.drawImage(paperTexture!, x, y, size + 0.5, size + 0.5);
    }
  };
  stamp(sA, 2 - sA); // coarser: fades out as it approaches double size
  stamp(sA / 2, sA - 1); // finer: fades in
  ctx.globalAlpha = 1;
}
