import type { World } from './wasm/pkg/minefield';
import { draw, screenToCell, MIN_ZOOM, MAX_ZOOM, type Camera } from './render';
import { makeWorld } from './config';
import type { CamState, Status, WorldConfig } from './storage';

export interface GameCallbacks {
  /** The player did something worth saving. */
  onChange(): void;
  onMenu(): void;
  onRestart(): void;
}

export interface Snapshot {
  state: Int32Array;
  cleared: number;
  total: number;
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
const $banner = el('banner');
const $bannerTitle = el('banner-title');
const $bannerSub = el('banner-sub');

let cb: GameCallbacks;
let world: World | null = null;
let active = false;
let flagMode = false;
const cam: Camera = { cx: HOME.x, cy: HOME.y, zoom: 32 };
let w = 0;
let h = 0;
let dirty = true;

// Timer: starts on the first reveal, stops on win/loss.
let startedAt: number | null = null;
let endedAt: number | null = null;
let bannerKey = '';
let bannerDismissed = false;

export function initGame(callbacks: GameCallbacks) {
  cb = callbacks;
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
}

/** Loads a world (optionally restoring saved progress) and shows it. */
export function loadWorld(
  cfg: WorldConfig,
  state: Int32Array | null,
  elapsedMs: number,
  saved: CamState | null,
) {
  world?.free();
  world = makeWorld(cfg);
  if (state && !world.import_state(state)) {
    console.warn('Saved progress could not be restored; starting fresh.');
  }
  const finished = world.is_game_over() || world.is_won();
  const now = performance.now();
  startedAt = finished ? 0 : elapsedMs > 0 || world.score() > 0 ? now - elapsedMs : null;
  endedAt = finished ? elapsedMs : null;
  bannerKey = '';
  bannerDismissed = false;
  glide = null;
  pointers.clear();
  $timer.hidden = cfg.mode !== 'island';
  const defaultZoom = Math.max(minZoom(), cfg.mode === 'island' ? 14 : 32);
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
    status,
    elapsedMs: Math.round(elapsedMs),
    cam: { cx: cam.cx, cy: cam.cy, zoom: cam.zoom },
  };
}

/** Small JPEG of the current view, for the world list. */
export function thumbnail(): string | null {
  if (!w || !h) return null;
  try {
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

function updateBanner() {
  const wd = world!;
  const key = wd.is_won() ? 'won' : wd.is_game_over() ? 'lost' : '';
  if (key !== bannerKey) {
    bannerKey = key;
    bannerDismissed = false;
    if (key) cb.onChange(); // save the result right away
    if (key === 'won') {
      $bannerTitle.textContent = '🏝 Island cleared!';
      $bannerSub.textContent = `Time ${fmtTime((endedAt ?? 0) - (startedAt ?? 0))}`;
    } else if (key === 'lost') {
      $bannerTitle.textContent = '💥 Boom!';
      $bannerSub.textContent = `You cleared ${wd.score()} cells`;
    }
  }
  $banner.hidden = key === '' || bannerDismissed;
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
    setText($score, `🏝 ${wd.score()} / ${total} (${pct}%) · 💣 ${left}${tail}`);
    setText($timer, startedAt === null ? '00:00' : fmtTime((endedAt ?? now) - startedAt));
  } else {
    setText($score, `${wd.score()} cleared · ${wd.flag_count()} flags${tail}`);
  }
  const [px, py] = [Math.floor(cam.cx), Math.floor(cam.cy)];
  setText($pos, `${px}, ${py} · ${Math.round(wd.density_at(px, py) * 100)}% mines`);
  updateBanner();
}

function frame(now: number) {
  requestAnimationFrame(frame);
  if (!active || !world) return;
  stepGlide(now);
  if (dirty) {
    dirty = false;
    clampCamera();
    const finished = world.is_game_over() || world.is_won();
    draw(ctx, world, cam, w, h, finished ? 'review' : 'play');
  }
  updateHud(now);
}

// --- Actions ----------------------------------------------------------------------------

function isRevealedNumber(x: number, y: number): boolean {
  const b = world!.view(x, y, 1, 1)[0];
  return (b & 0x30) === 0x20 && (b & 0x0f) > 0;
}

function activate(px: number, py: number, forceFlag: boolean) {
  const wd = world!;
  const [x, y] = screenToCell(cam, w, h, px, py);
  if (forceFlag || flagMode) {
    wd.toggle_flag(x, y);
  } else if (isRevealedNumber(x, y)) {
    wd.chord(x, y);
  } else {
    wd.reveal(x, y);
  }
  invalidate();
  cb.onChange();
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
          navigator.vibrate?.(15);
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
  if (!active || e.target instanceof HTMLInputElement) return;
  if (e.key === 'f' || e.key === 'F') toggleFlagMode();
  if (e.key === 'c' || e.key === 'C' || e.key === 'Home') recenter();
  if (e.key === 'Escape') cb.onMenu();
});
$mode.addEventListener('click', toggleFlagMode);
$home.addEventListener('click', recenter);
$menu.addEventListener('click', () => cb.onMenu());
el('b-restart').addEventListener('click', () => cb.onRestart());
el('b-menu').addEventListener('click', () => cb.onMenu());
el('b-look').addEventListener('click', () => {
  bannerDismissed = true;
  $banner.hidden = true;
});
