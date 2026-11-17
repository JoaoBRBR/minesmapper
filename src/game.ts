import type { World } from './wasm/pkg/minefield';
import { draw, drawChunkBorders, screenToCell, MIN_ZOOM, MAX_ZOOM, RIPPLE_MS, CLEAN_FX_MS, visualsVersion, type Camera, type Fx, type Ripple } from './render';
import { haptics } from './haptics';
import { prefersReducedMotion, settings } from './settings';
import { sound } from './sound';
import { flavorOf, musicArea, musicChunk, musicFlag, musicLose, musicMood, musicWin } from './musicBridge';
import { bump, noteEndless, noteIslandWin } from './stats';
import { makeWorld } from './config';
import type { CamState, Status, WorldConfig } from './storage';

export interface GameCallbacks {
  /** The player did something worth saving. */
  onChange(): void;
  onMenu(): void;
  onRestart(): void;
  /** The player wants to see the island in 3D (win dialog button). */
  onView3D(): void;
}

export interface Snapshot {
  state: Int32Array;
  cleared: number;
  total: number;
  points: number;
  farthest: number;
  status: Status;
  elapsedMs: number;
  cam: CamState;
}

const LONG_PRESS_MS = 450;
const DRAG_THRESHOLD = 6;
const HOME = { x: 0.5, y: 0.5 };

const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const canvas = el<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
const $hud = el('hud');
const $score = el('score');
const $timer = el('timer');
const $pos = el('pos');
const $mode = el<HTMLButtonElement>('mode');
const $home = el<HTMLButtonElement>('home');
const $menu = el<HTMLButtonElement>('menu');
const $oracle = el<HTMLButtonElement>('oracle');
const $menuBadge = el('menu-badge');
const $banner = el('banner');
const $b3d = el<HTMLButtonElement>('b-3d');
const $bannerTitle = el('banner-title');
const $bannerSub = el('banner-sub');

let cb: GameCallbacks;
let world: World | null = null;
let cfg: WorldConfig | null = null;
/** True when the island win that just happened beat the previous best time. */
let wonRecord = false;
let active = false;
let flagMode = false;
/** True after pressing the Oracle button: the next tap on a hidden cell spends one. */
let oracleMode = false;
const cam: Camera = { cx: HOME.x, cy: HOME.y, zoom: 32 };
let w = 0;
let h = 0;
let dirty = true;

// Timer: starts on the first reveal, stops on win/loss.
let startedAt: number | null = null;
let endedAt: number | null = null;
/** When the end dialog last appeared. Taps right after are ignored, so a fast tap on the map can't hit a button. */
let bannerShownAt = 0;
let bannerKey = '';
let bannerDismissed = false;

// Transient effects (see render.ts `Fx`).
const END_MS = 1500;
const BANNER_DELAY_MS = { lost: 1400, won: 1200 };
let ripple: Ripple | null = null;
let rippleEnd = 0;
let cleanFx: NonNullable<Fx['cleanups']> = [];
let lastBorders = settings.chunkBorders;
let lastVisuals = visualsVersion;
let lastMoodCheck = 0;
/** Phones and touch screens get a compact top bar; the rest lives in the menu. */
const compactHud = matchMedia('(max-width: 720px), (pointer: coarse)');
let endFx: { kind: 'lost' | 'won'; t0: number; origin: [number, number] } | null = null;
/** A refused tap (too far from explored ground), flashed on the map. */
const DENIED_MS = 500;
let denied: { x: number; y: number; t0: number } | null = null;

const animationsOn = () => settings.animations && !prefersReducedMotion();

export function initGame(callbacks: GameCallbacks) {
  cb = callbacks;
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
}

/** Loads a world (optionally restoring saved progress) and shows it. */
export function loadWorld(
  config: WorldConfig,
  state: Int32Array | null,
  elapsedMs: number,
  saved: CamState | null,
) {
  world?.free();
  cfg = config;
  wonRecord = false;
  world = makeWorld(config);
  if (state && !world.import_state(state)) {
    console.warn('Saved progress could not be restored; starting fresh.');
  }
  const finished = world.is_game_over() || world.is_won();
  const now = performance.now();
  startedAt = finished ? 0 : elapsedMs > 0 || world.score() > 0 ? now - elapsedMs : null;
  endedAt = finished ? elapsedMs : null;
  bannerKey = '';
  bannerDismissed = false;
  ripple = null;
  cleanFx = [];
  endFx = null;
  denied = null;
  oracleMode = false;
  glide = null;
  pointers.clear();
  $timer.hidden = config.mode !== 'island';
  const defaultZoom = Math.max(minZoom(), config.mode === 'island' ? 14 : 32);
  cam.cx = saved?.cx ?? HOME.x;
  cam.cy = saved?.cy ?? HOME.y;
  cam.zoom = saved?.zoom ?? defaultZoom;
  clampCamera();
  invalidate();
}

export function snapshot(): Snapshot {
  const wd = world!;
  const status: Status = wd.is_won() ? 'won' : wd.is_game_over() ? 'lost' : 'playing';
  const elapsedMs = startedAt === null ? 0 : (endedAt ?? performance.now()) - startedAt;
  return {
    state: wd.export_state(),
    cleared: wd.score(),
    total: wd.safe_total(),
    points: wd.points(),
    farthest: wd.farthest(),
    status,
    elapsedMs: Math.round(elapsedMs),
    cam: { cx: cam.cx, cy: cam.cy, zoom: cam.zoom },
  };
}

/** Small JPEG of the current view, for the world list. */
export function thumbnail(): string | null {
  if (!w || !h) return null;
  try {
    // A cleared island is remembered by a portrait of the whole thing.
    if (world?.is_island() && world.is_won()) {
      const px = 280;
      const portrait = document.createElement('canvas');
      portrait.width = portrait.height = px;
      draw(portrait.getContext('2d')!, world, { cx: 0.5, cy: 0.5, zoom: px / world.island_size() }, px, px, 'review');
      return portrait.toDataURL('image/jpeg', 0.78);
    }
    const tw = 200;
    const th = Math.round((tw * h) / w);
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    c.getContext('2d')!.drawImage(canvas, 0, 0, tw, th);
    return c.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

export function setActive(on: boolean) {
  active = on;
  canvas.hidden = !on;
  $hud.hidden = !on;
  if (!on) {
    $banner.hidden = true;
    bannerKey = '';
    pointers.clear();
    clearTimeout(pressTimer);
    ripple = null;
    cleanFx = [];
    endFx = null;
    denied = null;
    oracleMode = false;
  } else {
    resize();
  }
}

function invalidate() {
  dirty = true;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  invalidate();
}

// --- Camera -----------------------------------------------------------------------------

/** Island mode lets you zoom out far enough to see the whole island. */
function minZoom() {
  if (!world?.is_island()) return MIN_ZOOM;
  const fit = Math.min(w, h) / (world.island_size() * 1.1);
  return Math.max(1.5, Math.min(MIN_ZOOM, fit));
}

function clampCamera() {
  if (!world) return;
  cam.zoom = Math.min(MAX_ZOOM, Math.max(minZoom(), cam.zoom));
  if (world.is_island()) {
    const half = world.island_size() / 2;
    cam.cx = Math.min(half, Math.max(-half, cam.cx));
    cam.cy = Math.min(half, Math.max(-half, cam.cy));
  }
}

function zoomAt(px: number, py: number, factor: number) {
  const [wx, wy] = [(px - w / 2) / cam.zoom + cam.cx, (py - h / 2) / cam.zoom + cam.cy];
  cam.zoom = Math.min(MAX_ZOOM, Math.max(minZoom(), cam.zoom * factor));
  cam.cx = wx - (px - w / 2) / cam.zoom;
  cam.cy = wy - (py - h / 2) / cam.zoom;
  invalidate();
}

// Smoothly glide the camera back to the centre of the world.
let glide: { fx: number; fy: number; t0: number } | null = null;
const GLIDE_MS = 350;

function recenter() {
  glide = { fx: cam.cx, fy: cam.cy, t0: performance.now() };
}

function stepGlide(now: number) {
  if (!glide) return;
  const t = Math.min(1, (now - glide.t0) / GLIDE_MS);
  const k = 1 - (1 - t) ** 3;
  cam.cx = glide.fx + (HOME.x - glide.fx) * k;
  cam.cy = glide.fy + (HOME.y - glide.fy) * k;
  if (t >= 1) glide = null;
  invalidate();
}

// --- HUD / banner -----------------------------------------------------------------------

export function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

function updateBanner(now: number) {
  const wd = world!;
  const key = wd.is_won() ? 'won' : wd.is_game_over() ? 'lost' : '';
  if (key !== bannerKey) {
    bannerKey = key;
    bannerDismissed = false;
    if (key) cb.onChange(); // save the result right away
    if (key === 'won') {
      $bannerTitle.textContent = '🏝 Island cleared!';
      $bannerSub.textContent = `Time ${fmtTime((endedAt ?? 0) - (startedAt ?? 0))}${wonRecord ? ' · 🏆 New best!' : ''}`;
    } else if (key === 'lost') {
      $bannerTitle.textContent = '💥 Boom!';
      $bannerSub.textContent = `You cleared ${wd.score()} cells`;
    }
  }
  // Give the loss/win animation time to play before the dialog appears.
  const ready = !endFx || now - endFx.t0 >= BANNER_DELAY_MS[endFx.kind];
  const hide = key === '' || bannerDismissed || !ready;
  if ($banner.hidden && !hide) bannerShownAt = now;
  $banner.hidden = hide;
  // 3D view: a reward for clearing an island.
  $b3d.hidden = !(wd.is_island() && key === 'won');
}

function updateHud(now: number) {
  const wd = world!;
  const island = wd.is_island();
  const finished = wd.is_game_over() || wd.is_won();
  if (startedAt === null && wd.score() > 0) startedAt = now;
  if (startedAt !== null && endedAt === null && finished) endedAt = now;

  const tail = wd.is_won() ? ' · cleared!' : wd.is_game_over() ? ' · game over' : '';
  if (island) {
    const total = wd.safe_total();
    const pct = total ? Math.floor((wd.score() / total) * 100) : 0;
    const left = wd.mines_total() - wd.flag_count();
    setText(
      $score,
      compactHud.matches
        ? `🏝 ${pct}% · 💣 ${left}${wd.is_won() ? ' ✓' : wd.is_game_over() ? ' ✕' : ''}`
        : `🏝 ${wd.score()} / ${total} (${pct}%) · 💣 ${left}${tail}`,
    );
    setText($timer, startedAt === null ? '00:00' : fmtTime((endedAt ?? now) - startedAt));
  } else {
    setText(
      $score,
      compactHud.matches
        ? `★ ${wd.points().toLocaleString()} · 📏 ${wd.farthest()}${wd.is_game_over() ? ' ✕' : ''}`
        : `★ ${wd.points().toLocaleString()} · 📏 ${wd.farthest()} away · 🚩 ${wd.flag_count()}${tail}`,
    );
  }
  const oracles = wd.powerups_available();
  if (oracles === 0 && oracleMode) oracleMode = false;
  $oracle.hidden = oracles === 0;
  $menuBadge.hidden = oracles === 0;
  setText($oracle, `✨ Oracle ×${oracles}`);
  $oracle.setAttribute('aria-pressed', String(oracleMode));
  canvas.classList.toggle('targeting', oracleMode);
  if (now - lastMoodCheck > 1500) {
    // The music follows the biome in the middle of the screen.
    lastMoodCheck = now;
    const mid = wd.view(Math.floor(cam.cx), Math.floor(cam.cy), 1, 1);
    musicMood(flavorOf(mid[0], mid[1]));
  }
  const [px, py] = [Math.floor(cam.cx), Math.floor(cam.cy)];
  setText($pos, `${px}, ${py} · ${Math.round(wd.density_at(px, py) * 100)}% mines`);
  updateBanner(now);
}

function frame(now: number) {
  requestAnimationFrame(frame);
  if (!active || !world) return;
  stepGlide(now);
  if (visualsVersion !== lastVisuals) {
    lastVisuals = visualsVersion;
    invalidate();
  }
  if (settings.chunkBorders !== lastBorders) {
    lastBorders = settings.chunkBorders;
    invalidate();
  }
  if (ripple && now > rippleEnd) ripple = null;
  if (endFx && now - endFx.t0 > END_MS) endFx = null;
  if (denied && now - denied.t0 > DENIED_MS) denied = null;
  if (cleanFx.length && now - cleanFx[0].t0 > CLEAN_FX_MS) cleanFx = cleanFx.filter((f) => now - f.t0 < CLEAN_FX_MS);
  if (dirty || ripple || endFx || denied || cleanFx.length) {
    dirty = false;
    clampCamera();
    render(now);
  }
  updateHud(now);
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

function render(now: number) {
  renderScene(now);
  if (settings.chunkBorders) drawChunkBorders(ctx, world!, cam, w, h);
}

function renderScene(now: number) {
  const wd = world!;
  const finished = wd.is_game_over() || wd.is_won();
  const fx: Fx = {
    now,
    ripple,
    cleanups: cleanFx,
    mines: endFx?.kind === 'lost' ? { t0: endFx.t0, origin: endFx.origin } : null,
  };
  if (!endFx) {
    draw(ctx, wd, cam, w, h, finished ? 'review' : 'play', fx);
    if (denied) drawDenied(now, denied);
    return;
  }
  // End sequence: fog-of-war map first, then the full-colour map fades in over it.
  draw(ctx, wd, cam, w, h, 'play', fx);
  const p = clamp01((now - endFx.t0 - 150) / 900);
  if (p > 0) {
    ctx.globalAlpha = p * p * (3 - 2 * p);
    draw(ctx, wd, cam, w, h, 'review', { ...fx, ripple: null });
    ctx.globalAlpha = 1;
  }
  if (endFx.kind === 'lost') drawShockwave(now, endFx.t0, endFx.origin);
}

function drawDenied(now: number, d: { x: number; y: number; t0: number }) {
  const t = (now - d.t0) / DENIED_MS;
  const sx = (d.x - cam.cx) * cam.zoom + w / 2;
  const sy = (d.y - cam.cy) * cam.zoom + h / 2;
  ctx.fillStyle = `rgba(220, 38, 38, ${0.45 * (1 - t)})`;
  ctx.fillRect(sx, sy, cam.zoom, cam.zoom);
  ctx.strokeStyle = `rgba(254, 202, 202, ${0.9 * (1 - t)})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 1, sy + 1, cam.zoom - 2, cam.zoom - 2);
}

let toastTimer = 0;
function toast(msg: string) {
  const el_ = el('toast');
  el_.textContent = msg;
  el_.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el_.hidden = true), 2200);
}

/** Explains and signals a tap that the frontier rule refused. */
function deny(x: number, y: number) {
  const wd = world!;
  denied = { x, y, t0: performance.now() };
  toast(
    wd.score() === 0
      ? 'Start near the center of the map'
      : `Too far: reveal within ${wd.reach()} cells of explored ground`,
  );
  sound.blocked();
  haptics.blocked();
  invalidate();
}

function drawShockwave(now: number, t0: number, origin: [number, number]) {
  const t = (now - t0) / 700;
  if (t >= 1) return;
  const sx = (origin[0] + 0.5 - cam.cx) * cam.zoom + w / 2;
  const sy = (origin[1] + 0.5 - cam.cy) * cam.zoom + h / 2;
  ctx.strokeStyle = `rgba(255, 190, 110, ${0.85 * (1 - t)})`;
  ctx.lineWidth = 1 + 7 * (1 - t);
  ctx.beginPath();
  ctx.arc(sx, sy, t * cam.zoom * 14, 0, Math.PI * 2);
  ctx.stroke();
}

function shake() {
  canvas.classList.remove('shake');
  void canvas.offsetWidth; // restart the CSS animation
  canvas.classList.add('shake');
  setTimeout(() => canvas.classList.remove('shake'), 480);
}

// --- Actions ----------------------------------------------------------------------------

/**
 * A revealed cell that is still on the map (not tidied away). Tapping it chords: the game
 * itself checks the flags against the real number. Its *shown* number can be lower than the
 * real one (mines hidden in tidied ground are left out) or even blank, so we can't tell from
 * the digit.
 */
function isChordable(x: number, y: number): boolean {
  const b = world!.view(x, y, 1, 1)[0];
  return (b & 0x30) === 0x20 && (b & 0xb0) !== 0xa0;
}

function activate(px: number, py: number, forceFlag: boolean) {
  const wd = world!;
  const [x, y] = screenToCell(cam, w, h, px, py);
  const before = {
    score: wd.score(),
    flags: wd.flag_count(),
    over: wd.is_game_over(),
    won: wd.is_won(),
    found: wd.powerups_found(),
  };
  if (oracleMode && !forceFlag) {
    useOracle(before, x, y);
    return;
  }
  if (forceFlag || flagMode) {
    wd.toggle_flag(x, y);
  } else if (isChordable(x, y)) {
    wd.chord(x, y);
  } else if (wd.is_out_of_reach(x, y)) {
    deny(x, y);
    return;
  } else {
    wd.reveal(x, y);
  }
  feedback(before, x, y);
  invalidate();
  cb.onChange();
}

type Before = { score: number; flags: number; over: boolean; won: boolean; found: number };

function toggleOracleMode() {
  const wd = world;
  if (!wd || wd.powerups_available() === 0) return;
  oracleMode = !oracleMode;
  if (oracleMode) toast('Tap a hidden cell to learn the truth about it');
  invalidate();
}

/** Spends an oracle on the tapped cell: a safe cell opens, a mine gets flagged. */
function useOracle(before: Before, x: number, y: number) {
  const wd = world!;
  const result = wd.use_oracle(x, y);
  if (result === 3) {
    // Not allowed there (already revealed, water, or too far): keep targeting.
    denied = { x, y, t0: performance.now() };
    toast(`Pick a hidden cell within ${wd.reach()} cells of explored ground`);
    sound.blocked();
    haptics.blocked();
  } else {
    oracleMode = false;
    if (result !== 0) {
      bump('oraclesUsed');
      sound.oracle();
      haptics.oracle();
      toast(result === 1 ? '✨ Safe! The cell was revealed' : '💣 A mine! It has been flagged');
      feedback(before, x, y);
      cb.onChange();
    }
  }
  invalidate();
}

/** Sounds, vibration and animations for whatever the last action did. */
function feedback(
  before: Before,
  x: number,
  y: number,
) {
  const wd = world!;
  const now = performance.now();
  const log = wd.take_reveal_log();
  const revealed = wd.score() - before.score;
  const flagDelta = wd.flag_count() - before.flags;
  const animate = animationsOn();
  bump('cellsCleared', revealed);
  bump('flagsPlaced', flagDelta);

  // Music: the biome under the action colours the notes (desert, ice, ...).
  const here = wd.view(x, y, 1, 1);
  const flavor = flavorOf(here[0], here[1]);
  // With music running, a flag is voiced by its note alone (the plain blip is only a fallback).
  const flagNote = flagDelta > 0 && musicFlag(flavor);
  if (revealed >= 5) musicArea(revealed, flavor);

  // Cells that opened: ripple outward from the click (breadth-first depth = delay).
  let rippleMs = 0;
  if (revealed > 0 && log.length >= 3) {
    const n = log.length / 3;
    const maxDepth = log[log.length - 1];
    const step = Math.min(24, 700 / Math.max(1, maxDepth));
    rippleMs = maxDepth * step;
    if (animate) {
      const r: Ripple = { xs: new Array(n), ys: new Array(n), t0: new Array(n) };
      for (let i = 0; i < n; i++) {
        r.xs[i] = log[i * 3];
        r.ys[i] = log[i * 3 + 1];
        r.t0[i] = now + log[i * 3 + 2] * step;
      }
      ripple = r;
      rippleEnd = now + rippleMs + RIPPLE_MS;
    }
  }

  if (!before.over && wd.is_game_over()) {
    bump('losses');
    musicLose();
    sound.boom();
    haptics.boom();
    if (animate) {
      endFx = { kind: 'lost', t0: now, origin: [x, y] };
      shake();
    }
  } else if (!before.won && wd.is_won()) {
    bump('wins');
    musicWin();
    if (cfg?.mode === 'island') wonRecord = noteIslandWin(cfg.size, cfg.difficulty, startedAt === null ? 0 : now - startedAt);
    sound.win();
    haptics.win();
    if (animate) endFx = { kind: 'won', t0: now, origin: [x, y] };
  } else if (revealed === 1) {
    sound.tick();
  } else if (revealed > 1) {
    sound.open(rippleMs + 120);
    if (revealed > 15) haptics.open();
  }

  if (flagDelta > 0) {
    if (!flagNote) sound.flag();
    haptics.flag();
  } else if (flagDelta < 0) {
    sound.unflag();
  }

  // Chunks that were just finished get tidied away (numbers, flags and mines vanish).
  const cleaned = wd.take_clean_log();
  if (cleaned.length > 0) {
    bump('chunksTidied', cleaned.length / 2);
    {
      const half = wd.clean_chunk_size() / 2;
      const mid = wd.view(Math.floor(cleaned[0] * wd.clean_chunk_size() + half), Math.floor(cleaned[1] * wd.clean_chunk_size() + half), 1, 1);
      musicChunk(flavorOf(mid[0], mid[1]));
    }
    sound.clean();
    haptics.clean();
    if (animate) {
      const size = wd.clean_chunk_size();
      for (let i = 0; i < cleaned.length; i += 2) {
        cleanFx.push({ x: cleaned[i] * size, y: cleaned[i + 1] * size, size, t0: now });
      }
    }
  }

  if (wd.powerups_found() > before.found) {
    bump('oraclesFound', wd.powerups_found() - before.found);
    const n = wd.powerups_available();
    toast(`✨ You found an oracle! (${n} ready)`);
    sound.found();
    haptics.found();
  }

  if (cfg?.mode === 'endless' && revealed > 0) noteEndless(cfg.difficulty, wd.points(), wd.farthest());
}

// --- Pointer input: drag to pan, tap to reveal, long-press/right-click to flag, pinch to zoom.
interface Ptr {
  x: number;
  y: number;
  startX: number;
  startY: number;
}
const pointers = new Map<number, Ptr>();
let dragged = false;
let longPressed = false;
let pressTimer = 0;
let pinchDist = 0;

function pinchMetrics() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!active) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
  if (pointers.size === 1) {
    dragged = false;
    longPressed = false;
    if (e.pointerType !== 'mouse') {
      pressTimer = window.setTimeout(() => {
        if (!dragged && pointers.size === 1) {
          longPressed = true;
          activate(e.clientX, e.clientY, true);
        }
      }, LONG_PRESS_MS);
    }
  } else if (pointers.size === 2) {
    clearTimeout(pressTimer);
    dragged = true;
    pinchDist = pinchMetrics().d;
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2) {
    const { d, mx, my } = pinchMetrics();
    if (pinchDist > 0) zoomAt(mx, my, d / pinchDist);
    pinchDist = d;
    glide = null;
    cam.cx -= dx / 2 / cam.zoom;
    cam.cy -= dy / 2 / cam.zoom;
    invalidate();
  } else if (pointers.size === 1) {
    if (!dragged && Math.hypot(p.x - p.startX, p.y - p.startY) > DRAG_THRESHOLD) {
      dragged = true;
      clearTimeout(pressTimer);
    }
    if (dragged) {
      glide = null;
      cam.cx -= dx / cam.zoom;
      cam.cy -= dy / cam.zoom;
      invalidate();
    }
  }
});

function endPointer(e: PointerEvent, cancelled: boolean) {
  const wasSingle = pointers.size === 1;
  pointers.delete(e.pointerId);
  clearTimeout(pressTimer);
  if (cancelled || !wasSingle || dragged || longPressed) return;
  activate(e.clientX, e.clientY, e.button === 2);
}
canvas.addEventListener('pointerup', (e) => endPointer(e, false));
canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (active) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);

function toggleFlagMode() {
  flagMode = !flagMode;
  $mode.textContent = flagMode ? '🚩 Flag' : '⛏ Reveal';
  $mode.setAttribute('aria-pressed', String(flagMode));
}

window.addEventListener('keydown', (e) => {
  if (!active || e.target instanceof HTMLInputElement || !el('settings').hidden || !el('viewer').hidden) return;
  if (e.key === 'f' || e.key === 'F') toggleFlagMode();
  if (e.key === 'c' || e.key === 'C' || e.key === 'Home') recenter();
  if (e.key === 'o' || e.key === 'O') toggleOracleMode();
  if (e.key === 'Escape') {
    if (oracleMode) oracleMode = false;
    else cb.onMenu();
  }
});
$mode.addEventListener('click', toggleFlagMode);
$home.addEventListener('click', recenter);
$menu.addEventListener('click', () => cb.onMenu());
$oracle.addEventListener('click', toggleOracleMode);
const settled = (fn: () => void) => () => {
  if (performance.now() - bannerShownAt > 500) fn();
};
el('b-restart').addEventListener('click', settled(() => cb.onRestart()));
el('b-menu').addEventListener('click', settled(() => cb.onMenu()));
$b3d.addEventListener('click', settled(() => cb.onView3D()));
el('b-look').addEventListener(
  'click',
  settled(() => {
    bannerDismissed = true;
    $banner.hidden = true;
  }),
);

// Test hook (dev server only): lets browser tests set up positions without hours of play.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__dev = {
    world: () => world,
    makeWorld,
    invalidate,
    goto(x: number, y: number, zoom = 32) {
      cam.cx = x + 0.5;
      cam.cy = y + 0.5;
      cam.zoom = zoom;
      invalidate();
    },
    cellToScreen: (x: number, y: number) => [
      (x + 0.5 - cam.cx) * cam.zoom + w / 2,
      (y + 0.5 - cam.cy) * cam.zoom + h / 2,
    ],
  };
}

// --- Hooks for the in-game menu --------------------------------------------------------------

export const isFlagMode = () => flagMode;

export function setFlagMode(on: boolean) {
  if (on !== flagMode) toggleFlagMode();
}

export function recenterView() {
  recenter();
}

export function startOracleTargeting() {
  toggleOracleMode();
}

export const oraclesAvailable = () => (world ? world.powerups_available() : 0);
export const isOracleTargeting = () => oracleMode;
