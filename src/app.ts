import init from './wasm/pkg/minefield';
import { setBackground } from './background';
import { registerServiceWorker, setupInstall } from './pwa';
import { haptics, vibrationSupported } from './haptics';
import { onSettingsChange, prefersReducedMotion, setSetting, settings, type Settings } from './settings';
import { sound } from './sound';
import { bump, flushStats, loadStats, resetStats, startPlay, stats, stopPlay } from './stats';
import { draw } from './render';
import { DIFFICULTIES, ISLAND_SIZES, makeWorld, randomSeed, seedFromText } from './config';
import {
  fmtTime,
  initGame,
  isFlagMode,
  loadWorld,
  oraclesAvailable,
  recenterView,
  setActive,
  setFlagMode,
  snapshot,
  startOracleTargeting,
  thumbnail,
} from './game';
import { initMusic } from './musicBridge';
import { initTheme } from './theme';
import {
  WORLDGEN_VERSION,
  deleteWorld,
  getState,
  getWorld,
  listWorlds,
  requestPersistence,
  saveWorld,
  type Difficulty,
  type Mode,
  type WorldConfig,
  type WorldMeta,
} from './storage';

type Screen = 'home' | 'creator' | 'stats' | 'trophies' | 'game';

const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const $homeScreen = el('home-screen');
const $creator = el('creator');
const $statsScreen = el('stats-screen');
const $trophies = el('trophies');
const $pause = el('pause');
const $worlds = el('worlds');
const $continue = el<HTMLButtonElement>('h-continue');

let screen: Screen = 'home';
let current: WorldMeta | null = null;
let saveTimer = 0;
let saveChain: Promise<void> = Promise.resolve();

// --- Screens ----------------------------------------------------------------------------

function show(next: Screen) {
  screen = next;
  $homeScreen.hidden = next !== 'home';
  $creator.hidden = next !== 'creator';
  $statsScreen.hidden = next !== 'stats';
  $trophies.hidden = next !== 'trophies';
  $pause.hidden = true;
  setActive(next === 'game');
  if (next === 'game') startPlay();
  else stopPlay();
  setBackground(next !== 'game');
  document.body.classList.toggle('in-game', next === 'game');
}

// --- Persistence ------------------------------------------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveCurrent(), 700);
}

/** Writes the open world to IndexedDB (serialised so saves never interleave). */
function saveCurrent(withThumb = false): Promise<void> {
  clearTimeout(saveTimer);
  if (!current || screen !== 'game') return saveChain;
  const s = snapshot();
  const meta: WorldMeta = {
    ...current,
    status: s.status,
    cleared: s.cleared,
    total: s.total,
    points: s.points,
    farthest: s.farthest,
    elapsedMs: s.elapsedMs,
    cam: s.cam,
    updatedAt: Date.now(),
    thumb: withThumb ? (thumbnail() ?? current.thumb) : current.thumb,
  };
  current = meta;
  saveChain = saveChain
    .then(() => saveWorld(meta, s.state))
    .catch((err) => console.error('Saving failed', err));
  return saveChain;
}

async function openWorld(id: string) {
  const [meta, state] = await Promise.all([getWorld(id), getState(id)]);
  if (!meta) return;
  current = meta;
  loadWorld(meta.config, state, meta.elapsedMs, meta.cam);
  show('game');
}

/** Wipes progress but keeps the same map (seed), then plays it. */
async function restartWorld(id: string) {
  const meta = await getWorld(id);
  if (!meta) return;
  const fresh: WorldMeta = {
    ...meta,
    status: 'playing',
    cleared: 0,
    total: 0,
    points: 0,
    farthest: 0,
    elapsedMs: 0,
    cam: null,
    thumb: null,
    updatedAt: Date.now(),
  };
  await saveWorld(fresh, new Int32Array(0));
  bump('restarts');
  await openWorld(id);
}

function confirmRestart(meta: { name: string; status: string; cleared: number }) {
  if (meta.status !== 'playing' || meta.cleared === 0) return true;
  return confirm(`Restart "${meta.name}"? Your progress on this world will be lost.`);
}

// --- Home -------------------------------------------------------------------------------

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...kids: (Node | string)[]
) {
  const n = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) n.className = cls;
  Object.assign(n, rest);
  n.append(...kids);
  return n;
}

function describe(m: WorldMeta) {
  const c = m.config;
  const pct = m.total ? Math.floor((m.cleared / m.total) * 100) : 0;
  const mode = c.mode === 'island' ? `🏝 Island ${c.size}` : '♾ Endless';
  const progress =
    c.mode === 'island'
      ? `${pct}% cleared`
      : `★ ${(m.points ?? m.cleared).toLocaleString()} pts · 📏 ${m.farthest ?? 0} away · ${m.cleared} cleared`;
  const time = c.mode === 'island' && m.elapsedMs > 0 ? ` · ${fmtTime(m.elapsedMs)}` : '';
  return { line1: `${mode} · ${c.difficulty}`, line2: `${progress}${time}` };
}

/** Only islands you have cleared can be viewed in 3D. */
function canView3D(m: WorldMeta) {
  return m.config.mode === 'island' && m.status === 'won';
}

function worldCard(m: WorldMeta) {
  const { line1, line2 } = describe(m);
  const badge =
    m.status === 'won' ? ['badge won', '🏝 Cleared'] : m.status === 'lost' ? ['badge lost', '💥 Lost'] : ['badge', 'Playing'];
  const thumb = node('div', { class: 'thumb' });
  if (m.thumb) thumb.style.backgroundImage = `url(${m.thumb})`;

  const primary = node('button', {
    class: 'primary',
    textContent: m.status === 'playing' ? '▶ Play' : '👁 View',
    onclick: () => void openWorld(m.id),
  });
  const restart = node('button', {
    textContent: '↻ Restart',
    title: 'Same map, fresh start',
    onclick: async () => {
      if (confirmRestart(m)) await restartWorld(m.id);
    },
  });
  const del = node('button', {
    class: 'danger',
    textContent: '🗑',
    title: 'Delete world',
    ariaLabel: `Delete ${m.name}`,
    onclick: async () => {
      if (!confirm(`Delete "${m.name}" forever?`)) return;
      await deleteWorld(m.id);
      if (current?.id === m.id) current = null;
      await renderHome();
    },
  } as Partial<HTMLButtonElement>);
  const view3d = canView3D(m)
    ? node('button', { textContent: '🌍 3D', title: 'See the island in 3D', onclick: () => void openViewer(m) })
    : null;
  const buttons: HTMLElement[] = [primary, restart, ...(view3d ? [view3d] : []), del];
  // Lost worlds: make Restart the main action.
  if (m.status === 'lost') restart.classList.add('primary');

  return node(
    'article',
    { class: `card ${m.status}` },
    thumb,
    node(
      'div',
      { class: 'info' },
      node('div', { class: 'name' }, m.name, node('span', { class: badge[0], textContent: badge[1] })),
      node('div', { class: 'meta', textContent: line1 }),
      node('div', { class: 'meta', textContent: line2 }),
      node('div', { class: 'meta dim', textContent: `Seed ${m.config.seedText} · ${ago(m.updatedAt)}` }),
    ),
    node('div', { class: 'card-actions' }, ...buttons),
  );
}

async function renderHome() {
  const worlds = await listWorlds();
  $worlds.replaceChildren(
    ...(worlds.length
      ? worlds.map(worldCard)
      : [node('p', { class: 'empty', textContent: 'No worlds yet. Create your first one!' })]),
  );
  const cleared = worlds.filter((m) => m.config.mode === 'island' && m.status === 'won').length;
  el('h-trophies').textContent = cleared ? `🏆 Finished islands (${cleared})` : '🏆 Finished islands';
  const last = worlds.find((m) => m.status === 'playing');
  $continue.hidden = !last;
  if (last) {
    $continue.textContent = `▶ Continue "${last.name}"`;
    $continue.onclick = () => void openWorld(last.id);
  }
}

async function goHome() {
  if (screen === 'game') await saveCurrent(true);
  current = null;
  show('home');
  await renderHome();
}

// --- 3D viewer and finished islands ------------------------------------------------------

let viewer: { dispose(): void; setAutoRotate(on: boolean): void } | null = null;
let viewerToken = 0;
let autoRotate = true;
const $viewer = el('viewer');

async function openViewer(meta: WorldMeta) {
  if (meta.config.mode !== 'island') return;
  closeViewer();
  const token = viewerToken;
  const c = meta.config;
  $viewer.hidden = false;
  el('viewer-title').textContent = meta.name;
  el('viewer-sub').textContent = `${
    meta.status === 'won' ? `🏆 Cleared in ${fmtTime(meta.elapsedMs)}` : 'Island in progress'
  } · ${c.size}×${c.size} · ${c.difficulty}`;
  const msg = el('viewer-msg');
  msg.hidden = false;
  msg.textContent = 'Raising the island…';
  try {
    // The terrain depends only on the seed, so it can be rebuilt from the saved settings.
    const world = makeWorld(c);
    const cells = world.island_snapshot();
    const size = world.island_size();
    world.free();
    const mod = await import('./viewer3d');
    if (token !== viewerToken) return; // closed while loading
    viewer = mod.openIsland(el('viewer-stage'), { size, cells });
    viewer.setAutoRotate(autoRotate);
    msg.hidden = true;
  } catch (err) {
    console.warn('3D view failed', err);
    msg.textContent = 'The 3D view is not available on this device.';
  }
}

function closeViewer() {
  viewerToken++;
  viewer?.dispose();
  viewer = null;
  $viewer.hidden = true;
}

function bindViewer() {
  el('viewer-close').addEventListener('click', closeViewer);
  const rotate = el<HTMLButtonElement>('viewer-rotate');
  rotate.addEventListener('click', () => {
    autoRotate = !autoRotate;
    rotate.setAttribute('aria-pressed', String(autoRotate));
    viewer?.setAutoRotate(autoRotate);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$viewer.hidden) closeViewer();
  });
  el('h-trophies').addEventListener('click', () => void openTrophies());
  el('trophies-back').addEventListener('click', () => void goHome());
}

async function openTrophies() {
  const wins = (await listWorlds()).filter((m) => m.config.mode === 'island' && m.status === 'won');
  el('trophy-list').replaceChildren(
    ...(wins.length
      ? wins.map((m) => {
          const c = m.config;
          const thumb = node('div', { class: 'thumb' });
          if (m.thumb) thumb.style.backgroundImage = `url(${m.thumb})`;
          return node(
            'article',
            { class: 'card won' },
            thumb,
            node(
              'div',
              { class: 'info' },
              node('div', { class: 'name' }, m.name, node('span', { class: 'badge won', textContent: '🏝 Cleared' })),
              node('div', { class: 'meta', textContent: `${c.size}×${c.size} · ${c.difficulty} · ${fmtTime(m.elapsedMs)}` }),
              node('div', { class: 'meta dim', textContent: `Seed ${c.seedText} · ${ago(m.updatedAt)}` }),
            ),
            node(
              'div',
              { class: 'card-actions' },
              node('button', { class: 'primary', textContent: '🌍 View in 3D', onclick: () => void openViewer(m) }),
              node('button', { textContent: '👁 Open map', onclick: () => void openWorld(m.id) }),
            ),
          );
        })
      : [node('p', { class: 'empty', textContent: 'No finished islands yet. Clear one to hang it here!' })]),
  );
  show('trophies');
}

// --- Stats screen -----------------------------------------------------------------------

function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const clock = (ms: number) => fmtTime(ms);

function tile(label: string, value: string) {
  return node('div', { class: 'tile' }, node('b', { textContent: value }), node('span', { textContent: label }));
}

function table(head: string[], rows: (string | { text: string; none?: boolean })[][]) {
  const cell = (c: string | { text: string; none?: boolean }, tag: 'th' | 'td') => {
    const t = typeof c === 'string' ? { text: c } : c;
    return node(tag, { textContent: t.text, className: 'none' in t && t.none ? 'none' : '' });
  };
  return node(
    'table',
    { class: 'records' },
    node('thead', {}, node('tr', {}, ...head.map((h) => cell(h, 'th')))),
    node('tbody', {}, ...rows.map((r) => node('tr', {}, ...r.map((c) => cell(c, 'td'))))),
  );
}

async function renderStats() {
  const n = (v: number) => v.toLocaleString();
  const games = stats.wins + stats.losses;
  $statsScreen.querySelector<HTMLElement>('#stats-since')!.textContent =
    `Since ${new Date(stats.since).toLocaleDateString()}`;
  el('stats-tiles').replaceChildren(
    tile('Time played', fmtDuration(stats.playMs)),
    tile('Worlds created', n(stats.worldsCreated)),
    tile('Islands cleared', n(stats.wins)),
    tile('Mines hit', n(stats.losses)),
    tile('Win rate', games ? `${Math.round((stats.wins / games) * 100)}%` : '–'),
    tile('Cells cleared', n(stats.cellsCleared)),
    tile('Flags placed', n(stats.flagsPlaced)),
    tile('Areas tidied', n(stats.chunksTidied)),
    tile('Oracles found', n(stats.oraclesFound)),
    tile('Oracles used', n(stats.oraclesUsed)),
    tile('Restarts', n(stats.restarts)),
  );

  const diffs = ['easy', 'normal', 'hard'] as const;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const time = (key: string) => {
    const ms = stats.bestIslandMs[key];
    return ms === undefined ? { text: '–', none: true } : { text: clock(ms) };
  };
  el('stats-islands').replaceChildren(
    table(
      ['Size', ...diffs.map(cap)],
      Object.entries(ISLAND_SIZES).map(([name, size]) => [
        `${cap(name)} (${size})`,
        ...diffs.map((d) => time(`${size}|${d}`)),
      ]),
    ),
  );
  el('stats-endless').replaceChildren(
    table(
      ['Difficulty', 'Best score', 'Farthest'],
      diffs.map((d) => {
        const b = stats.endlessBest[d];
        return b
          ? [cap(d), `★ ${n(b.points)}`, `📏 ${n(b.farthest)}`]
          : [cap(d), { text: '–', none: true }, { text: '–', none: true }];
      }),
    ),
  );

  const worlds = await listWorlds();
  const count = (s: string) => worlds.filter((w) => w.status === s).length;
  el('stats-worlds').textContent = worlds.length
    ? `${worlds.length} saved: ${count('playing')} in progress, ${count('won')} cleared, ${count('lost')} lost.`
    : 'No saved worlds.';
}

async function openStats() {
  await renderStats();
  show('stats');
}

// --- Pause menu -------------------------------------------------------------------------

/** Fills the menu with the current state each time it opens. */
function syncMenu() {
  el('pause-name').textContent = current?.name ?? '';
  el('menu-pos').textContent = el('pos').textContent ?? '';
  const flagging = isFlagMode();
  document.querySelectorAll<HTMLButtonElement>('#m-mode button').forEach((b) => {
    const on = (b.dataset.v === 'flag') === flagging;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const oracles = oraclesAvailable();
  const oracle = el<HTMLButtonElement>('m-oracle');
  oracle.hidden = oracles === 0;
  oracle.textContent = `✨ Use an oracle (×${oracles})`;
  const island = current?.config.mode === 'island';
  el('m-3d').hidden = !(island && snapshot().status === 'won');
}

function openPause() {
  if (screen !== 'game') return;
  if (!$pause.hidden) return closePause();
  syncMenu();
  $pause.hidden = false;
}
const closePause = () => ($pause.hidden = true);

function bindGameMenu() {
  document.querySelectorAll<HTMLButtonElement>('#m-mode button').forEach((b) =>
    b.addEventListener('click', () => {
      setFlagMode(b.dataset.v === 'flag');
      closePause();
    }),
  );
  el('m-center').addEventListener('click', () => {
    recenterView();
    closePause();
  });
  el('m-3d').addEventListener('click', () => {
    closePause();
    if (current) {
      const s = snapshot();
      void openViewer({ ...current, status: s.status, elapsedMs: s.elapsedMs });
    }
  });
  el('m-oracle').addEventListener('click', () => {
    closePause();
    startOracleTargeting();
  });
  el('p-resume').addEventListener('click', closePause);
  el('p-restart').addEventListener('click', () => void restartCurrent());
  el('p-exit').addEventListener('click', () => void goHome());
  $pause.addEventListener('click', (e) => {
    if (e.target === $pause) closePause();
  });
}

async function restartCurrent() {
  if (!current) return;
  const s = snapshot();
  if (!confirmRestart({ name: current.name, status: s.status, cleared: s.cleared })) return;
  await saveChain;
  await restartWorld(current.id);
}

// --- Creator ----------------------------------------------------------------------------

interface Seg {
  get(): string;
  set(v: string): void;
}

function segmented(id: string, onChange: (v: string) => void): Seg {
  const root = el(id);
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
  const set = (v: string) =>
    buttons.forEach((b) => {
      const on = b.dataset.v === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      set(b.dataset.v!);
      onChange(b.dataset.v!);
    }),
  );
  return { get: () => buttons.find((b) => b.classList.contains('on'))?.dataset.v ?? '', set };
}

const $name = el<HTMLInputElement>('c-name');
const $seed = el<HTMLInputElement>('c-seed');
const $d0 = el<HTMLInputElement>('c-d0');
const $d1 = el<HTMLInputElement>('c-d1');
const $preview = el<HTMLCanvasElement>('c-preview');
let previewTimer = 0;

const modeSeg = segmented('c-mode', () => {
  syncCreatorVisibility();
  refreshPreview();
});
const sizeSeg = segmented('c-size', () => refreshPreview());
const diffSeg = segmented('c-diff', (v) => {
  if (v !== 'custom') applyPreset(v as Exclude<Difficulty, 'custom'>);
  refreshPreview();
});

function applyPreset(d: Exclude<Difficulty, 'custom'>) {
  $d0.value = String(Math.round(DIFFICULTIES[d].density * 100));
  $d1.value = String(Math.round(DIFFICULTIES[d].maxDensity * 100));
  syncSliderLabels();
}

function syncSliderLabels() {
  el('c-d0-val').textContent = `${$d0.value}%`;
  el('c-d1-val').textContent = `${$d1.value}%`;
}

function syncCreatorVisibility() {
  const island = modeSeg.get() === 'island';
  el('c-size-wrap').hidden = !island;
  el('c-mode-hint').textContent = island
    ? 'A finite island surrounded by water. Clear every safe cell to win, lakes included: water turns to see-through ice once you reach it. You can only reveal near explored ground. Rare oracles hide under safe cells: spend one to learn the truth about a cell.'
    : 'An infinite map. Score points by clearing cells: the farther from the start, the more each is worth (and the denser the mines). You can only reveal near explored ground. Rare oracles hide under safe cells: spend one to learn the truth about a cell.';
  el('c-d1-label').firstChild!.textContent = island ? 'Mines at the coast ' : 'Mines far away ';
}

function readConfig(): WorldConfig {
  const text = $seed.value.trim() || String(randomSeed());
  return {
    mode: modeSeg.get() as Mode,
    seed: seedFromText(text),
    seedText: text,
    size: Number(sizeSeg.get()),
    difficulty: diffSeg.get() as Difficulty,
    density: Number($d0.value) / 100,
    maxDensity: Number($d1.value) / 100,
  };
}

function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(drawPreview, 120);
}

function drawPreview() {
  const cfg = readConfig();
  const hint = el('c-seed-hint');
  hint.textContent = /^\d+$/.test(cfg.seedText) ? '' : `Seed number: ${cfg.seed}`;
  const css = Math.min(320, Math.floor($preview.parentElement!.clientWidth) || 320);
  const dpr = window.devicePixelRatio || 1;
  $preview.style.width = $preview.style.height = `${css}px`;
  $preview.width = $preview.height = Math.round(css * dpr);
  const pctx = $preview.getContext('2d')!;
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const world = makeWorld(cfg);
  const zoom = cfg.mode === 'island' ? css / (cfg.size * 1.05) : 1.5;
  draw(pctx, world, { cx: 0.5, cy: 0.5, zoom }, css, css, 'preview');
  el('c-stats').textContent =
    cfg.mode === 'island'
      ? `${world.land_total().toLocaleString()} playable cells${world.lake_total() ? ` (${world.lake_total().toLocaleString()} in lakes)` : ''} · about ${world.mines_total().toLocaleString()} mines`
      : `Preview of the area around the start (${Math.round(css / zoom)}×${Math.round(css / zoom)} cells)`;
  world.free();
}

async function openCreator() {
  const n = (await listWorlds()).length + 1;
  modeSeg.set('island');
  sizeSeg.set(String(ISLAND_SIZES.medium));
  diffSeg.set('normal');
  applyPreset('normal');
  $seed.value = String(randomSeed());
  $name.value = `Island ${n}`;
  $name.dataset.auto = '1';
  syncCreatorVisibility();
  show('creator');
  drawPreview();
}

function bindCreator() {
  $name.addEventListener('input', () => delete $name.dataset.auto);
  el('c-mode').addEventListener('click', async () => {
    if ($name.dataset.auto) {
      const n = (await listWorlds()).length + 1;
      $name.value = `${modeSeg.get() === 'island' ? 'Island' : 'Endless'} ${n}`;
    }
  });
  $seed.addEventListener('input', refreshPreview);
  el('c-dice').addEventListener('click', () => {
    $seed.value = String(randomSeed());
    refreshPreview();
  });
  const onSlider = (changed: HTMLInputElement) => {
    if (+$d1.value < +$d0.value) (changed === $d0 ? $d1 : $d0).value = changed.value;
    diffSeg.set('custom');
    syncSliderLabels();
    refreshPreview();
  };
  $d0.addEventListener('input', () => onSlider($d0));
  $d1.addEventListener('input', () => onSlider($d1));
  el('c-cancel').addEventListener('click', () => void goHome());
  el('c-create').addEventListener('click', async () => {
    const config = readConfig();
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const meta: WorldMeta = {
      id,
      name: $name.value.trim() || 'Unnamed world',
      config,
      status: 'playing',
      cleared: 0,
      total: 0,
      points: 0,
      farthest: 0,
      elapsedMs: 0,
      cam: null,
      thumb: null,
      worldgen: WORLDGEN_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    await saveWorld(meta, new Int32Array(0));
    bump('worldsCreated');
    await openWorld(id);
  });
  window.addEventListener('resize', () => {
    if (screen === 'creator') refreshPreview();
  });
}

// --- Settings dialog --------------------------------------------------------------------

const $settings = el('settings');

/** Settings that are plain on/off switches. */
type ToggleKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function bindSettings() {
  // The same switches live in the Settings dialog and in the game menu; keep them all in sync.
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[data-setting]')];
  const sync = () => inputs.forEach((i) => (i.checked = settings[i.dataset.setting as ToggleKey]));
  sync();
  onSettingsChange(sync);
  for (const input of inputs) {
    input.addEventListener('change', () => {
      const key = input.dataset.setting as ToggleKey;
      setSetting(key, input.checked);
      // Give immediate feedback when something is switched on.
      if (input.checked && key === 'sound') sound.test();
      if (input.checked && key === 'vibration') haptics.test();
    });
  }
  // Choice groups (e.g. number style): a segmented control stored as one setting.
  const groups = [...document.querySelectorAll<HTMLElement>('[data-setting-choice]')];
  const syncGroups = () =>
    groups.forEach((g) =>
      g.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        const on = b.dataset.v === String(settings[g.dataset.settingChoice as keyof Settings]);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }),
    );
  syncGroups();
  onSettingsChange(syncGroups);
  for (const g of groups) {
    g.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b?.dataset.v) setSetting(g.dataset.settingChoice as 'numberStyle', b.dataset.v as Settings['numberStyle']);
    });
  }
  // Sliders (music volume): 0-100 in the UI, 0-1 in the setting.
  const ranges = [...document.querySelectorAll<HTMLInputElement>('input[data-setting-range]')];
  const syncRanges = () => ranges.forEach((r) => (r.value = String(Math.round(settings.musicVolume * 100))));
  syncRanges();
  onSettingsChange(syncRanges);
  for (const r of ranges) r.addEventListener('input', () => setSetting('musicVolume', Number(r.value) / 100));
  if (!vibrationSupported) {
    for (const i of inputs.filter((x) => x.dataset.setting === 'vibration')) {
      i.disabled = true;
      i.closest('.switch')?.classList.add('disabled');
    }
    el('s-vibration-hint').textContent = 'Not supported by this browser (for example iPhone Safari).';
  }
  if (prefersReducedMotion()) {
    el('s-animations-hint').textContent = 'Off automatically: your device asks to reduce motion.';
  }
  const open = () => ($settings.hidden = false);
  const close = () => ($settings.hidden = true);
  el('h-settings').addEventListener('click', open);
  el('s-close').addEventListener('click', close);
  $settings.addEventListener('click', (e) => {
    if (e.target === $settings) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$settings.hidden) {
      e.stopPropagation();
      close();
    }
  });
}

// --- Boot -------------------------------------------------------------------------------

export async function start() {
  await init();
  await loadStats();
  initTheme();
  initMusic();
  requestPersistence();
  initGame({
    onChange: scheduleSave,
    onMenu: openPause,
    onRestart: () => void restartCurrent(),
    onView3D: () => {
      if (!current) return;
      const s = snapshot();
      void openViewer({ ...current, status: s.status, elapsedMs: s.elapsedMs });
    },
  });
  bindCreator();
  bindSettings();
  bindGameMenu();
  bindViewer();
  setupInstall(el<HTMLButtonElement>('h-install'), el('ios-hint'));
  const $update = el('update');
  el('update-reload').addEventListener('click', () => location.reload());
  el('update-dismiss').addEventListener('click', () => ($update.hidden = true));
  registerServiceWorker(() => ($update.hidden = false));

  el('h-new').addEventListener('click', () => void openCreator());
  el('h-stats').addEventListener('click', () => void openStats());
  el('stats-back').addEventListener('click', () => void goHome());
  el('stats-reset').addEventListener('click', async () => {
    if (!confirm('Reset all lifetime stats and records? Your saved worlds are not affected.')) return;
    await resetStats();
    await renderStats();
  });

  // Never lose progress when the tab is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void saveCurrent(true);
      stopPlay();
      void flushStats();
    } else if (screen === 'game') {
      startPlay();
    }
  });
  window.addEventListener('pagehide', () => {
    void saveCurrent(true);
    stopPlay();
    void flushStats();
  });

  show('home');
  await renderHome();
}
