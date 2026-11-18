import type { World } from './wasm/pkg/minefield';
import { setBackgroundRealm } from './background';
import { draw, drawChunkBorders, screenToCell, MIN_ZOOM, MAX_ZOOM, RIPPLE_MS, CLEAN_FX_MS, visualsVersion, type Camera, type Fx, type Ripple } from './render';
import { haptics } from './haptics';
import { drawGlyph } from './icons';
import { tr } from './i18n';
import { SECRET_TRACK } from './tracks';
import { maybeShowTip } from './tips';
import { maybeShowTutorial } from './tutorial';
import { prefersReducedMotion, settings } from './settings';
import { sound } from './sound';
import { defaultForMap, playTrack, unlockTrack } from './music';
import { bump, noteDailyWin, noteEndless, noteIslandWin } from './stats';
import { makeWorld } from './config';
import { debugFrame, debugRender, isDebug, setDebugInfo } from './debug';
import { getLevel, levelNumber, nextLevel, openingView, recordResult, starsFor, startRect, type LevelDef } from './levels';
import type { CamState, Status, WorldConfig } from './storage';

export interface GameCallbacks {
  /** The player did something worth saving. */
  onChange(): void;
  onMenu(): void;
  /** The player wants the main menu (end-of-game dialog). */
  onHome(): void;
  onRestart(): void;
  /** The player wants to see the island in 3D (win dialog button). */
  onView3D(): void;
  /** The player finished an adventure level and wants the next one. */
  onNextLevel(level: LevelDef): void;
  /** An adventure result was recorded (stars may have changed). */
  onLevelResult(): void;
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
const $hearts = el('hearts');
const $recenter = el<HTMLButtonElement>('recenter');
const $vignette = el('vignette');
const $score = el('score');
const $timer = el('timer');
const $pos = el('pos');
const $mode = el<HTMLButtonElement>('mode');
const $home = el<HTMLButtonElement>('home');
const $menu = el<HTMLButtonElement>('menu');
const $oracle = el<HTMLButtonElement>('oracle');
const $oracleN = el('oracle-n');
const $iceN = el('ice-n');
const $iceBtn = el<HTMLButtonElement>('iceclear');
const $banner = el('banner');
const $b3d = el<HTMLButtonElement>('b-3d');
const $bProgress = el<HTMLButtonElement>('b-progress');
const $progressBar = el('progress-bar');
const $progressText = el('progress-text');
const $progressBtn = el<HTMLButtonElement>('progress');
const $fab = el<HTMLButtonElement>('fab');
const $flagKind = el<HTMLButtonElement>('flag-kind');
const $bannerTitle = el('banner-title');
const $bannerSub = el('banner-sub');
const $bNext = el<HTMLButtonElement>('b-next');

/** The adventure level being played, if any. */
let level: LevelDef | undefined;

let cb: GameCallbacks;
let world: World | null = null;
let cfg: WorldConfig | null = null;
/** True when the island win that just happened beat the previous best time. */
let wonRecord = false;
let active = false;
let flagMode = false;
/** Which flag a tap or a long press places in a space world: false = normal (red), true = negative (purple). */
let negKind = false;
/** Set while one tap places a specific kind (the G key), whatever the current kind is. */
let kindOverride: boolean | null = null;
/** True after pressing the Oracle button: the next tap on a hidden cell spends one. */
let oracleMode = false;
/** Same idea for the ice clearer: the next tap on a water cell spends one. */
let iceMode = false;
/** Progress view: a simplified, read-only map of what you have found. */
let progressView = false;
let lastWave = 0;
const cam: Camera = { cx: HOME.x, cy: HOME.y, zoom: 32 };
let w = 0;
let h = 0;
let dirty = true;

// Timer: starts on the first reveal, stops on win/loss.
let startedAt: number | null = null;
let endedAt: number | null = null;
/** Set while the clock is stopped (menu open, tab hidden, ...). */
let pausedSince: number | null = null;
/** A daily island that was just cleared: the streak it brought you to. */
let wonStreak = 0;

/** The timer only counts time spent looking at the map. */
function clockPaused() {
  return !active || document.hidden || !el('pause').hidden || !el('settings').hidden || !el('viewer').hidden;
}

/** Call whenever something might have paused or resumed the clock. */
function syncClock(now = performance.now()) {
  const paused = clockPaused();
  if (paused && pausedSince === null) {
    pausedSince = now;
  } else if (!paused && pausedSince !== null) {
    if (startedAt !== null && endedAt === null) startedAt += now - pausedSince; // skip the time away
    pausedSince = null;
  }
}

/** "Now" as far as the game clock is concerned: frozen while paused. */
const clockNow = (now: number) => pausedSince ?? now;
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
/** Phones and touch screens get a compact top bar; the rest lives in the menu. */
const compactHud = matchMedia('(max-width: 720px), (pointer: coarse)');
let endFx: { kind: 'lost' | 'won'; t0: number; origin: [number, number] } | null = null;
/** A refused tap (too far from explored ground), flashed on the map. */
const DENIED_MS = 500;
let denied: { x: number; y: number; t0: number } | null = null;

const animationsOn = () => settings.animations && !prefersReducedMotion();

export function initGame(callbacks: GameCallbacks) {
  cb = callbacks;
  setDebugInfo(() => {
    if (!active || !world) return ['(no map open)'];
    const c = '';
    return [
      `cam ${cam.cx.toFixed(1)}, ${cam.cy.toFixed(1)} · zoom ${cam.zoom.toFixed(1)}`,
      `score ${world.score()} · hearts lost ${world.mistakes()}${level ? ` · ${level.id}` : ''}${c ? ` · ${c}` : ''}`,
      `${world.is_island() ? 'island' : 'endless'}${world.is_space() ? ' · space' : ''}`,
    ];
  });
  document.addEventListener('visibilitychange', () => syncClock());
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
  level = getLevel(config.level);
  playTrack(defaultForMap(config.mode, level?.id, !!config.daily, !!config.space));
  // "home" is the middle of the start area on levels that have one
  const sr = level ? startRect(level) : null;
  HOME.x = sr ? (sr[0] + sr[2] + 1) / 2 : 0.5;
  HOME.y = sr ? (sr[1] + sr[3] + 1) / 2 : 0.5;
  wonRecord = false;
  world = makeWorld(config);
  if (state && !world.import_state(state)) {
    console.warn('Saved progress could not be restored; starting fresh.');
  }
  const finished = world.is_game_over() || world.is_won();
  const now = performance.now();
  startedAt = finished ? 0 : elapsedMs > 0 || world.score() > 0 ? now - elapsedMs : null;
  endedAt = finished ? elapsedMs : null;
  pausedSince = null;
  wonStreak = 0;
  cancelPendingTap();
  bannerKey = '';
  bannerDismissed = false;
  ripple = null;
  cleanFx = [];
  endFx = null;
  denied = null;
  oracleMode = false;
  iceMode = false;
  setProgressView(false);
  glide = null;
  pointers.clear();
  $timer.hidden = config.mode !== 'island' && !level;
  const defaultZoom = Math.max(minZoom(), config.mode === 'island' ? 14 : 32);
  const opening = level ? openingView(level) : null;
  cam.cx = saved?.cx ?? opening?.x ?? HOME.x;
  cam.cy = saved?.cy ?? opening?.y ?? HOME.y;
  cam.zoom = saved?.zoom ?? opening?.zoom ?? defaultZoom;
  clearTimeout(introTimer);
  if (level && opening && !saved && !(state && world.score() > 0) && level.goal.type === 'reach' && animationsOn()) {
    playIntro(level, opening);
  }
  // the very first level: a short walkthrough, once
  if (level?.id === 'first-landfall' && world.score() === 0) maybeShowTutorial();
  clampCamera();
  invalidate();
}

let introTimer = 0;

/** Treasure levels open on a wide view that shows the X, then glide in to the starting spot. */
function playIntro(l: LevelDef, to: { x: number; y: number; zoom: number }) {
  if (l.goal.type !== 'reach') return;
  const [tx, ty] = l.goal.target;
  const span = Math.max(Math.abs(ty + 0.5 - to.y), Math.abs(tx + 0.5 - to.x)) * 2 + 12;
  cam.cx = (tx + 0.5 + to.x) / 2;
  cam.cy = (ty + 0.5 + to.y) / 2;
  cam.zoom = Math.max(minZoom(), Math.min(to.zoom, Math.min(w, h) / span));
  const target = world!;
  introTimer = window.setTimeout(() => {
    if (world === target && !glide && target.score() === 0) glideTo(to.x, to.y, to.zoom, 1500);
  }, 1600);
}

export function snapshot(): Snapshot {
  const wd = world!;
  const status: Status = wd.is_won() ? 'won' : wd.is_game_over() ? 'lost' : 'playing';
  const elapsedMs = startedAt === null ? 0 : (endedAt ?? clockNow(performance.now())) - startedAt;
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
    $fab.hidden = true;
    $vignette.hidden = true;
    $recenter.hidden = true;
    $oracle.hidden = true;
    $iceBtn.hidden = true;
    $flagKind.hidden = true;
  }
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
    iceMode = false;
    setProgressView(false);
  } else {
    resize();
  }
  syncClock();
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
  glide = null;
  invalidate();
}

// Smoothly glide the camera back to the centre of the world.
let glide: {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  t0: number;
  ms: number;
} | null = null;
const GLIDE_MS = 350;
/** The first reveal of a world zooms in until about this many cells span the shorter screen side. */
const FIRST_TAP_CELLS = 12;
const FIRST_TAP_MS = 650;

/** Smoothly moves (and zooms) the camera to a target; any drag or scroll takes over again. */
function glideTo(tx: number, ty: number, tz: number, ms = GLIDE_MS) {
  glide = { fx: cam.cx, fy: cam.cy, fz: cam.zoom, tx, ty, tz, t0: performance.now(), ms };
}

function recenter() {
  glideTo(HOME.x, HOME.y, cam.zoom);
}

/** On a world's first reveal, move in a little on that region. */
function focusOnFirstTap(x: number, y: number) {
  const close = Math.min(60, Math.max(30, Math.min(w, h) / FIRST_TAP_CELLS));
  const tz = Math.min(MAX_ZOOM, Math.max(cam.zoom, close));
  if (animationsOn()) {
    glideTo(x + 0.5, y + 0.5, tz, FIRST_TAP_MS);
  } else {
    cam.cx = x + 0.5;
    cam.cy = y + 0.5;
    cam.zoom = tz;
  }
}

function stepGlide(now: number) {
  if (!glide) return;
  const t = Math.min(1, (now - glide.t0) / glide.ms);
  const k = 1 - (1 - t) ** 3;
  cam.cx = glide.fx + (glide.tx - glide.fx) * k;
  cam.cy = glide.fy + (glide.ty - glide.fy) * k;
  cam.zoom = glide.fz * (glide.tz / glide.fz) ** k; // zoom evenly, not linearly
  if (t >= 1) glide = null;
  invalidate();
}

// --- HUD / banner -----------------------------------------------------------------------

export function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// The icon pass rewrites symbols in the DOM, so remember what was asked for instead of reading it back.
const lastText = new WeakMap<HTMLElement, string>();
function setText(node: HTMLElement, text: string) {
  if (lastText.get(node) === text) return;
  lastText.set(node, text);
  node.textContent = text;
}

function updateBanner(now: number) {
  const wd = world!;
  const key = wd.is_won() ? 'won' : wd.is_game_over() ? 'lost' : '';
  if (key !== bannerKey) {
    bannerKey = key;
    bannerDismissed = false;
    if (key) cb.onChange(); // save the result right away
    if (key === 'won' && level) {
      const stars = starsFor(wd.mistakes());
      $bannerTitle.textContent = `🧭 Level ${levelNumber(level)} complete!`;
      $bannerSub.textContent = `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)} · ${wd.mistakes() ? `${wd.mistakes()} mistake${wd.mistakes() > 1 ? 's' : ''}` : 'flawless'} · ${fmtTime((endedAt ?? 0) - (startedAt ?? 0))}`;
    } else if (key === 'won') {
      $bannerTitle.textContent = '🏝 Island cleared!';
      $bannerSub.textContent = `Time ${fmtTime((endedAt ?? 0) - (startedAt ?? 0))}${wonRecord ? ' · 🏆 New best!' : ''}${wonStreak > 1 ? ` · 🔥 ${wonStreak}-day streak` : ''}`;
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
  $b3d.hidden = !(wd.is_island() && (key === 'won' || isDebug()));
  $bNext.hidden = !(level && key === 'won' && nextLevel(level));
  $bProgress.hidden = key !== 'lost';
}

function updateHud(now: number) {
  const wd = world!;
  // far from the start (two cleanup chunks or more): offer a way back
  const far = Math.hypot(cam.cx - HOME.x, cam.cy - HOME.y) > 32 && !progressView;
  if ($recenter.hidden === far) $recenter.hidden = !far;
  const island = wd.is_island();
  const finished = wd.is_game_over() || wd.is_won();
  if (startedAt === null && wd.score() > 0) startedAt = now;
  if (startedAt !== null && endedAt === null && finished) endedAt = clockNow(now);

  const tail = wd.is_won() ? ' · cleared!' : wd.is_game_over() ? ' · game over' : '';
  if (level && level.goal.type !== 'clear-island') {
    const gp = wd.goal_progress();
    if (level.goal.type === 'clear-chunk') {
      setText($score, `🎯 ${gp[0]} / ${gp[1]} in the area${wd.is_won() ? ' ✓' : wd.is_game_over() ? ' ✕' : ''}`);
    } else {
      const [tx, ty] = level.goal.target;
      const dx = Math.round(tx + 0.5 - cam.cx);
      const dy = Math.round(ty + 0.5 - cam.cy);
      const dir = `${dy < 0 ? '↑' : dy > 0 ? '↓' : ''}${dx > 0 ? '→' : dx < 0 ? '←' : ''}`;
      setText($score, wd.is_won() ? '🧭 Treasure found ✓' : `🧭 X is ${Math.max(Math.abs(dx), Math.abs(dy))} away ${dir}`);
    }
    setText($timer, startedAt === null ? '00:00' : fmtTime((endedAt ?? clockNow(now)) - startedAt));
  } else if (island) {
    const total = wd.safe_total();
    const pct = total ? Math.floor((wd.score() / total) * 100) : 0;
    const left = wd.mines_total() - wd.flag_count();
    setText(
      $score,
      compactHud.matches
        ? `🏝 ${pct}% · 💣 ${left}${wd.is_won() ? ' ✓' : wd.is_game_over() ? ' ✕' : ''}`
        : `🏝 ${wd.score()} / ${total} (${pct}%) · 💣 ${left}${tail}`,
    );
    setText($timer, startedAt === null ? '00:00' : fmtTime((endedAt ?? clockNow(now)) - startedAt));
  } else {
    setText(
      $score,
      compactHud.matches
        ? `★ ${wd.points().toLocaleString()} · 📏 ${wd.farthest()}${wd.is_game_over() ? ' ✕' : ''}`
        : `★ ${wd.points().toLocaleString()} · 📏 ${wd.farthest()} away · 🚩 ${wd.flag_count()}${tail}`,
    );
  }
  const heartsMax = wd.hearts_max();
  $hearts.hidden = heartsMax === 0;
  if (heartsMax === 0) $vignette.hidden = true;
  if (heartsMax) {
    const left = Math.max(0, heartsMax - wd.mistakes());
    setText($hearts, '♥'.repeat(left) + '♡'.repeat(heartsMax - left));
    // one heart left (in a game that began with more): the heart jumps and the edges blush
    const tense = heartsMax > 1 && left === 1 && !wd.is_game_over() && !wd.is_won();
    $hearts.classList.toggle('last', tense);
    $vignette.hidden = !tense;
  }
  const oracles = wd.powerups_available();
  if (oracles === 0 && oracleMode) oracleMode = false;
  const clearers = wd.iceclearers_available();
  if (clearers === 0 && iceMode) iceMode = false;
  $iceBtn.hidden = clearers === 0;
  setText($iceN, `×${clearers}`);
  $iceBtn.setAttribute('aria-pressed', String(iceMode));
  $oracle.hidden = oracles === 0;
  setText($oracleN, `×${oracles}`);
  $oracle.setAttribute('aria-pressed', String(oracleMode));
  canvas.classList.toggle('targeting', oracleMode || iceMode);
  if (progressView) setText($progressText, progressSummary(wd));
  // the floating Reveal/Flag button (phones)
  $fab.hidden = progressView || !settings.modeSwitch;
  syncMarkUi();
  const [px, py] = [Math.floor(cam.cx), Math.floor(cam.cy)];
  setText($pos, `${px}, ${py} · ${Math.round(wd.density_at(px, py) * 100)}% mines`);
  updateBanner(now);
}

function frame(now: number) {
  requestAnimationFrame(frame);
  debugFrame(now);
  if (!active || !world) return;
  syncClock(now);
  stepKeyboard(now);
  stepGlide(now);
  if (wavesOn() && now - lastWave > 66) {
    lastWave = now;
    invalidate();
  }
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
    debugRender(() => render(now));
  }
  updateHud(now);
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

function render(now: number) {
  renderScene(now);
  if (settings.chunkBorders) drawChunkBorders(ctx, world!, cam, w, h);
  if (level && !progressView) drawLevelMarks(level);
}

// --- Adventure markings: the goal area, the start area and the X ------------------------------

const GOLD = '#d9a520';
const toScreen = (x: number, y: number): [number, number] => [(x - cam.cx) * cam.zoom + w / 2, (y - cam.cy) * cam.zoom + h / 2];

function drawLevelMarks(l: LevelDef) {
  const wd = world!;
  if (wd.is_won()) return;
  const g = l.goal;
  const start = startRect(l);
  const fresh = wd.score() === 0;
  ctx.save();
  if (g.type === 'clear-chunk') {
    const [x0, y0] = toScreen(g.chunk[0] * 16, g.chunk[1] * 16);
    const side = 16 * cam.zoom;
    ctx.fillStyle = 'rgba(217,165,32,0.10)';
    if (fresh) ctx.fillRect(x0, y0, side, side);
    glowRect(x0, y0, side, side, false);
    if (fresh) label(tr('Clear this area'), x0 + side / 2, y0 - 10);
  } else if (g.type === 'reach') {
    if (start && fresh) {
      const [x0, y0] = toScreen(start[0], start[1]);
      const sw = (start[2] - start[0] + 1) * cam.zoom;
      const sh = (start[3] - start[1] + 1) * cam.zoom;
      ctx.fillStyle = 'rgba(217,165,32,0.10)';
      ctx.fillRect(x0, y0, sw, sh);
      glowRect(x0, y0, sw, sh, true);
      label(tr('Start here'), x0 + sw / 2, y0 - 10);
    }
    drawTreasureTrail(start, g.target);
    drawTreasureX(g.target[0], g.target[1]);
  }
  ctx.restore();
}

function glowRect(x: number, y: number, rw: number, rh: number, dashed: boolean) {
  ctx.setLineDash(dashed ? [10, 7] : []);
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = 18;
  ctx.strokeStyle = 'rgba(217,165,32,0.55)';
  ctx.lineWidth = 7;
  ctx.strokeRect(x, y, rw, rh);
  ctx.shadowBlur = 6;
  ctx.strokeStyle = '#f4d35e';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x, y, rw, rh);
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
}

function label(text: string, x: number, y: number) {
  ctx.font = '700 13px Kalam, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(30,20,5,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#f4d35e';
  ctx.fillText(text, x, y);
}

/**
 * Zoomed out, a dashed trail runs from the start to the X, like the route on an old treasure map.
 * It fades away as you zoom in on the ground.
 */
function drawTreasureTrail(start: [number, number, number, number] | null, target: [number, number]) {
  const alpha = clamp01((24 - cam.zoom) / 12);
  if (alpha <= 0) return;
  const [fx, fy] = start ? [(start[0] + start[2] + 1) / 2, (start[1] + start[3] + 1) / 2] : [0.5, 0.5];
  const [ax, ay] = toScreen(fx, fy);
  const [bx, by] = toScreen(target[0] + 0.5, target[1] + 0.5);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 40) return;
  // a gentle bend, so it looks hand-drawn rather than ruled
  const cx = (ax + bx) / 2 - (dy / len) * len * 0.12;
  const cy = (ay + by) / 2 + (dx / len) * len * 0.12;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cx, cy, bx, by);
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(244, 236, 216, 0.75)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.setLineDash([2, 12]);
  ctx.strokeStyle = '#7a2417';
  ctx.lineWidth = 4;
  ctx.stroke();
  // a small ring where the journey starts
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(ax, ay, 7, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#7a2417';
  ctx.stroke();
  ctx.restore();
}

/** A red X on the treasure cell; off screen, an arrow on the edge points the way. */
function drawTreasureX(cx: number, cy: number) {
  const [sx, sy] = toScreen(cx + 0.5, cy + 0.5);
  const margin = 34;
  const inView = sx > margin / 2 && sx < w - margin / 2 && sy > margin / 2 && sy < h - margin / 2;
  if (!inView) {
    const ax = Math.min(w - margin, Math.max(margin, sx));
    const ay = Math.min(h - margin, Math.max(margin + 40, sy));
    const ang = Math.atan2(sy - ay, sx - ax);
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = '#b3261e';
    ctx.strokeStyle = '#f4ecd8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, -12);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-10, 12);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    return;
  }
  const size = Math.max(52, cam.zoom * 1.1); // big even when zoomed far out
  drawGlyph(ctx, 'treasure-x', sx - size / 2, sy - size / 2, size);
}

function renderScene(now: number) {
  const wd = world!;
  if (progressView) {
    draw(ctx, wd, cam, w, h, 'progress');
    return;
  }
  const finished = wd.is_game_over() || wd.is_won();
  const fx: Fx = {
    now,
    ripple,
    cleanups: cleanFx,
    waves: wavesOn(),
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
export function toast(msg: string) {
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
      ? level && startRect(level)
        ? 'Make your first tap inside the marked area'
        : 'Start near the center of the map'
      : `Too far: reveal within ${wd.reach()} cells of explored ground`,
  );
  sound.blocked();
  haptics.blocked();
  invalidate();
}

function drawShockwave(now: number, t0: number, origin: [number, number]) {
  const t = Math.max(0, (now - t0) / 700);
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
  if (progressView) return; // the progress map is for looking only
  const wd = world!;
  const [x, y] = screenToCell(cam, w, h, px, py);
  const before = {
    score: wd.score(),
    flags: wd.flag_count(),
    over: wd.is_game_over(),
    won: wd.is_won(),
    found: wd.powerups_found(),
    iceFound: wd.iceclearers_found(),
    mistakes: wd.mistakes(),
  };
  if (iceMode && !forceFlag) {
    useIceClearer(x, y);
    return;
  }
  if (oracleMode && !forceFlag) {
    useOracle(before, x, y);
    return;
  }
  const got = wd.collect(x, y);
  if (got) {
    // a power-up lying on a revealed square: tapping it picks it up
    if (got & 1) {
      bump('oraclesFound');
      toast(`✨ You picked up an oracle! (${wd.powerups_available()} ready)`);
    }
    if (got & 2) toast(`❄ You picked up an ice clearer! (${wd.iceclearers_available()} ready)`);
    sound.found();
    haptics.found();
    invalidate();
    cb.onChange();
    return;
  }
  if (forceFlag || flagMode) {
    if (wd.is_space() && (kindOverride ?? negKind)) wd.toggle_flag_negative(x, y);
    else wd.toggle_flag(x, y);
  } else if (isChordable(x, y)) {
    wd.chord(x, y);
  } else if (wd.is_out_of_reach(x, y)) {
    deny(x, y);
    return;
  } else {
    wd.reveal(x, y);
  }
  feedback(before, x, y);
  if (before.score === 0 && wd.score() > 0) focusOnFirstTap(x, y);
  invalidate();
  cb.onChange();
}

type Before = { score: number; flags: number; over: boolean; won: boolean; found: number; iceFound: number; mistakes: number };

function toggleOracleMode() {
  const wd = world;
  if (!wd || wd.powerups_available() === 0) return;
  iceMode = false;
  oracleMode = !oracleMode;
  if (oracleMode) {
    toast('Tap a hidden cell to learn the truth about it');
    maybeShowTip('oracle');
  }
  invalidate();
}

function toggleIceMode() {
  const wd = world;
  if (!wd || wd.iceclearers_available() === 0) return;
  oracleMode = false;
  iceMode = !iceMode;
  if (iceMode) {
    toast('Tap a water cell to make that whole stretch of water see-through');
    maybeShowTip('ice');
  }
  invalidate();
}

/** Spends an ice clearer on the tapped water: all the water connected to it turns to clear ice. */
function useIceClearer(x: number, y: number) {
  const wd = world!;
  const result = wd.use_ice_clearer(x, y);
  if (result === 2) {
    denied = { x, y, t0: performance.now() };
    toast(`Pick a water cell within ${wd.reach()} cells of explored ground`);
    sound.blocked();
    haptics.blocked();
  } else if (result === 3) {
    toast('That water is already clear');
  } else {
    iceMode = false;
    if (result === 1) {
      sound.ice();
      haptics.oracle();
      toast('❄ The ice is clear: you can see the mines beneath');
      cb.onChange();
    }
  }
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
    setBackgroundRealm(!!cfg?.space);
    sound.boom();
    haptics.boom();
    if (animate) {
      endFx = { kind: 'lost', t0: now, origin: [x, y] };
      shake();
    }
  } else if (!before.over && wd.mistakes() > before.mistakes) {
    sound.boom();
    haptics.boom();
    toast(`💥 A mine! ${wd.hearts_max() - wd.mistakes()} ♥ left`);
    if (animate) shake();
  } else if (!before.won && wd.is_won()) {
    if (!level) bump('wins');
    if (cfg?.space) unlockTrack(SECRET_TRACK);
    setBackgroundRealm(!!cfg?.space);
    const took = startedAt === null ? 0 : clockNow(now) - startedAt;
    if (level) {
      void recordResult(level.id, starsFor(wd.mistakes()), took).then(() => cb.onLevelResult());
    } else if (cfg?.mode === 'island') wonRecord = noteIslandWin(cfg.size, cfg.difficulty, took);
    if (cfg?.daily) wonStreak = noteDailyWin(cfg.daily, took);
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
    sound.flag();
    haptics.flag();
  } else if (flagDelta < 0) {
    sound.unflag();
  }

  // Chunks that were just finished get tidied away (numbers, flags and mines vanish).
  const cleaned = wd.take_clean_log();
  if (cleaned.length > 0) {
    bump('chunksTidied', cleaned.length / 2);
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

  if (wd.iceclearers_found() > before.iceFound) {
    toast(`❄ You found an ice clearer! (${wd.iceclearers_available()} ready)`);
    sound.found();
    haptics.found();
  }

  if (cfg?.mode === 'endless' && !level && revealed > 0) noteEndless(cfg.difficulty, wd.points(), wd.farthest());
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
  lastPointerTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
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
  // Shift + click places a negative flag (space maps only)
  if (e.shiftKey && world?.is_space() && !progressView) {
    kindOverride = true;
    activate(e.clientX, e.clientY, true);
    kindOverride = null;
    return;
  }
  handleTap(e.clientX, e.clientY, e.button === 2);
}

// A quick second tap on ground you have already discovered zooms in (or back out). Taps always act
// at once, so chording stays instant; the second tap of a pair is simply used for the zoom, and
// double-tapping a hidden cell never zooms (it just reveals, then the cell is discovered).
const DOUBLE_TAP_MS = 300;
/** Double-tap zoom is for touch screens only; on a computer the wheel zooms. */
let lastPointerTouch = false;
let lastDiscoveredTap: { x: number; y: number; t: number } | null = null;

function cancelPendingTap() {
  lastDiscoveredTap = null;
}

/** Any ground you have discovered: numbers, empty cells, tidied-up ground and cleared sea. */
function isDiscovered(x: number, y: number): boolean {
  const b = world!.view(x, y, 1, 1)[0];
  return (b & 0x30) === 0x20 || b === 0x0e;
}

function handleTap(px: number, py: number, secondary: boolean) {
  const plain = !secondary && !flagMode && !oracleMode && !iceMode && !progressView && !!world;
  const [cx, cy] = plain ? screenToCell(cam, w, h, px, py) : [0, 0];
  if (!plain || !isDiscovered(cx, cy)) {
    lastDiscoveredTap = null;
    activate(px, py, secondary);
    return;
  }
  const now = performance.now();
  if (lastPointerTouch && lastDiscoveredTap && now - lastDiscoveredTap.t < DOUBLE_TAP_MS && Math.hypot(px - lastDiscoveredTap.x, py - lastDiscoveredTap.y) < 36) {
    lastDiscoveredTap = null;
    doubleTapZoom(cx, cy);
    return;
  }
  lastDiscoveredTap = { x: px, y: py, t: now };
  activate(px, py, false); // a chord happens right away when the flags match the number (taps on tidied ground do nothing)
}

function doubleTapZoom(cx: number, cy: number) {
  const tz = cam.zoom < 36 ? Math.min(60, cam.zoom * 2.2) : Math.max(minZoom(), cam.zoom / 2.4);
  glideTo(cx + 0.5, cy + 0.5, tz, 420);
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

export type MarkMode = 'reveal' | 'flag' | 'neg';
export const getMarkMode = (): MarkMode => (!flagMode ? 'reveal' : negKind ? 'neg' : 'flag');

/** What a tap does: open cells, place a normal flag, or (in space) place a negative flag. */
export function setMarkMode(m: MarkMode) {
  flagMode = m !== 'reveal';
  if (m === 'flag') negKind = false;
  if (m === 'neg') negKind = true;
  syncMarkUi();
}

/** The desktop button and the M key go round: reveal, flag and (in space) negative flag. */
function toggleFlagMode() {
  const space = !!world?.is_space();
  const m = getMarkMode();
  setMarkMode(m === 'reveal' ? 'flag' : m === 'flag' && space ? 'neg' : 'reveal');
}

let uiMode = '';
function syncMarkUi() {
  const m = getMarkMode();
  const space = !!world?.is_space();
  const key = `${m}${space}${settings.modeSwitch}`;
  if (key === uiMode) return;
  uiMode = key;
  $mode.textContent = m === 'reveal' ? '⛏ Reveal' : m === 'neg' ? '🏴 Negative flag' : '🚩 Flag';
  $mode.setAttribute('aria-pressed', String(m !== 'reveal'));
  $fab.dataset.mode = m;
  $fab.classList.toggle('three', space);
  $fab.setAttribute('aria-pressed', String(m !== 'reveal'));
  // with the switch hidden, a small button picks the kind of flag a long press places
  $flagKind.hidden = !(space && !settings.modeSwitch);
  const kind = negKind ? '🏴' : '🚩';
  if ($flagKind.dataset.t !== kind) {
    $flagKind.dataset.t = kind;
    $flagKind.textContent = kind;
  }
}

// --- Desktop keyboard ------------------------------------------------------------------------
//   arrows / WASD pan (optional)   Space or Enter reveal (or chord) under the cursor
//   F flag the cell under the cursor   M switch Reveal/Flag   P progress   C centre
//   + / - zoom   O oracle   I ice clearer   Esc menu / cancel
const PAN_KEYS: Record<string, [number, number]> = {
  arrowleft: [-1, 0],
  a: [-1, 0],
  arrowright: [1, 0],
  d: [1, 0],
  arrowup: [0, -1],
  w: [0, -1],
  arrowdown: [0, 1],
  s: [0, 1],
};
const heldKeys = new Set<string>();
let lastKeyFrame = 0;
let cursor: [number, number] | null = null;

window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') cursor = [e.clientX, e.clientY];
});

function activateAtCursor(forceFlag: boolean) {
  if (cursor) activate(cursor[0], cursor[1], forceFlag);
  else if (forceFlag) toggleFlagMode(); // no mouse: fall back to switching mode
}

/** Moves the map while a pan key is held. */
function stepKeyboard(now: number) {
  const dt = Math.min(0.05, (now - lastKeyFrame) / 1000);
  lastKeyFrame = now;
  if (!heldKeys.size || !settings.keyboardMove) return;
  let dx = 0;
  let dy = 0;
  for (const k of heldKeys) {
    dx += PAN_KEYS[k][0];
    dy += PAN_KEYS[k][1];
  }
  if (!dx && !dy) return;
  const speed = 760 / cam.zoom; // cells per second: about the same on screen at any zoom
  const len = Math.hypot(dx, dy);
  cam.cx += (dx / len) * speed * dt;
  cam.cy += (dy / len) * speed * dt;
  glide = null;
  invalidate();
}

window.addEventListener('keydown', (e) => {
  if (!active || e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!el('settings').hidden || !el('viewer').hidden) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const menuOpen = !el('pause').hidden;
  if (k === 'escape') {
    if (progressView) setProgressView(false);
    else if (oracleMode || iceMode) oracleMode = iceMode = false;
    else cb.onMenu();
    return;
  }
  if (menuOpen) return;
  // Ctrl switches the reveal / flag toggle
  if (k === 'control') {
    if (!e.repeat) toggleFlagMode();
    return;
  }
  if (settings.keyboardMove && k in PAN_KEYS) {
    heldKeys.add(k);
    glide = null;
    e.preventDefault();
    return;
  }
  // let a focused button keep Space/Enter for itself
  if ((k === ' ' || k === 'enter') && e.target instanceof HTMLButtonElement) return;
  if (k === ' ' || k === 'enter') {
    e.preventDefault();
    activateAtCursor(false);
  } else if (k === 'f') activateAtCursor(true);
  else if (k === 'm') toggleFlagMode();
  else if (k === 'c' || k === 'home') recenter();
  else if (k === 'o') toggleOracleMode();
  else if (k === 'i') toggleIceMode();
  else if (k === 'p') setProgressView(!progressView);
  else if (k === '+' || k === '=') zoomAt(w / 2, h / 2, 1.3);
  else if (k === '-' || k === '_') zoomAt(w / 2, h / 2, 1 / 1.3);
});
window.addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => heldKeys.clear());
$mode.addEventListener('click', toggleFlagMode);
$fab.addEventListener('click', (e) => {
  if (!world?.is_space()) return toggleFlagMode();
  // three slots in space: negative flag | flag | pickaxe
  const slot = Math.min(2, Math.max(0, Math.floor(((e.clientX - $fab.getBoundingClientRect().left) / $fab.offsetWidth) * 3)));
  setMarkMode((['neg', 'flag', 'reveal'] as const)[slot]);
});
$flagKind.addEventListener('click', () => {
  negKind = !negKind;
  uiMode = '';
  syncMarkUi();
});
$home.addEventListener('click', recenter);
$recenter.addEventListener('click', recenter);
$menu.addEventListener('click', () => cb.onMenu());
$oracle.addEventListener('click', toggleOracleMode);
$iceBtn.addEventListener('click', toggleIceMode);
const settled = (fn: () => void) => () => {
  if (performance.now() - bannerShownAt > 500) fn();
};
$bNext.addEventListener('click', settled(() => level && cb.onNextLevel(level)));
el('b-restart').addEventListener('click', settled(() => cb.onRestart()));
el('b-menu').addEventListener('click', settled(() => cb.onHome()));
$b3d.addEventListener('click', settled(() => cb.onView3D()));
$bProgress.addEventListener(
  'click',
  settled(() => {
    bannerDismissed = true;
    $banner.hidden = true;
    setProgressView(true);
  }),
);
$progressBtn.addEventListener('click', () => setProgressView(!progressView));
el('progress-exit').addEventListener('click', () => setProgressView(false));
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
    camera: () => ({ cx: cam.cx, cy: cam.cy, zoom: cam.zoom }),
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

function setProgressView(on: boolean) {
  progressView = on;
  if (on) oracleMode = iceMode = false;
  $progressBar.hidden = !on;
  invalidate();
}

function progressSummary(wd: World): string {
  const over = wd.is_game_over() ? ' · game over' : wd.is_won() ? ' · cleared!' : '';
  if (wd.is_island()) {
    const total = wd.safe_total();
    const pct = total ? Math.floor((wd.score() / total) * 100) : 0;
    return `📊 ${wd.score().toLocaleString()} of ${total.toLocaleString()} safe cells found (${pct}%)${over}`;
  }
  return `📊 ${wd.score().toLocaleString()} cells found · ${wd.farthest()} cells from the start${over}`;
}

/** Shore waves animate only on islands, when zoomed in enough to see the shore, and if allowed. */
function wavesOn() {
  return settings.waves && animationsOn() && !progressView && !!world?.is_island() && cam.zoom >= 5;
}

// --- Hooks for the in-game menu --------------------------------------------------------------

export const toggleProgressView = () => setProgressView(!progressView);
export const isProgressView = () => progressView;


export function recenterView() {
  recenter();
}

export function startOracleTargeting() {
  toggleOracleMode();
}

export function startIceTargeting() {
  toggleIceMode();
}

export const iceClearersAvailable = () => (world ? world.iceclearers_available() : 0);
export const oraclesAvailable = () => (world ? world.powerups_available() : 0);
export const isOracleTargeting = () => oracleMode;
