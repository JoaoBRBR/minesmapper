import init from './wasm/pkg/minefield';
import { holdBackground, setBackground, setBackgroundRealm } from './background';
import { registerServiceWorker, setupInstall } from './pwa';
import { haptics, vibrationSupported } from './haptics';
import { onSettingsChange, prefersReducedMotion, setSetting, settings, type Settings } from './settings';
import { sound } from './sound';
import { bump, dailyStreak, flushStats, freezeStats, loadStats, resetStats, startPlay, stats, stopPlay } from './stats';
import { draw } from './render';
import { DIFFICULTIES, ISLAND_SIZES, levelConfig, SIZE_STEPS, WORLD_GEN, dailyConfig, makeWorld, randomSeed, seedFromText, todayKey } from './config';
import {
  fmtTime,
  initGame,
  toast,
  loadWorld,
  setActive,
  snapshot,
  thumbnail,
} from './game';
import { lang, setLang, tr } from './i18n';
import { currentTrack, initMusic, nextTrack, onMusicChange, playMenuMusic, playlist, previousTrack, toggleRepeat, unlockTrack } from './music';
import { initEagle } from './eagle';
import { initCursor } from './cursor';
import { SECRET_TRACK, TRACKS } from './tracks';
import { initDebug, isDebug, onDebugChange } from './debug';
import { LEVELS, getLevel, isSpaceUnlocked, isUnlocked, levelNumber, loadProgress, nextLevel, type LevelDef } from './levels';
import { initTheme } from './theme';
import {
  WORLDGEN_VERSION,
  clearAllData,
  deleteTrophy,
  deleteWorld,
  getState,
  getWorld,
  listTrophies,
  listWorlds,
  requestPersistence,
  saveTrophy,
  saveWorld,
  type Difficulty,
  type Mode,
  type Trophy,
  type WorldConfig,
  type WorldMeta,
} from './storage';

type Screen = 'home' | 'worlds' | 'creator' | 'adventure' | 'stats' | 'trophies' | 'game';

const el = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const $homeScreen = el('home-screen');
const $worldsScreen = el('worlds-screen');
const $creator = el('creator');
const $adventure = el('adventure');
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
  $worldsScreen.hidden = next !== 'worlds';
  $creator.hidden = next !== 'creator';
  $adventure.hidden = next !== 'adventure';
  $statsScreen.hidden = next !== 'stats';
  $trophies.hidden = next !== 'trophies';
  $pause.hidden = true;
  setActive(next === 'game');
  if (next === 'game') startPlay();
  else stopPlay();
  setBackground(next !== 'game');
  document.body.classList.toggle('in-game', next === 'game');
  if (next !== 'game') playMenuMusic();
}

// --- Persistence ------------------------------------------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveCurrent(), 700);
}

/** Writes the open world to IndexedDB (serialised so saves never interleave). */
let wiping = false;

function saveCurrent(withThumb = false): Promise<void> {
  clearTimeout(saveTimer);
  if (wiping) return saveChain;
  if (!current || screen !== 'game') return saveChain;
  const s = snapshot();
  // finished islands become trophies; adventure levels do not, except the space ones (meteors)
  const isWin = s.status === 'won' && current.config.mode === 'island' && (!current.config.level || current.config.space === true);
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
    // a cleared island always gets its portrait, so its trophy has one
    thumb: withThumb || (isWin && !current.thumb) ? (thumbnail() ?? current.thumb) : current.thumb,
  };
  current = meta;
  saveChain = saveChain
    .then(() => saveWorld(meta, s.state))
    .then(() =>
      isWin
        ? saveTrophy({ id: meta.id, name: meta.name, config: meta.config, elapsedMs: meta.elapsedMs, thumb: meta.thumb })
        : undefined,
    )
    .catch((err) => console.error('Saving failed', err));
  return saveChain;
}

async function openWorld(id: string) {
  const [meta, state] = await Promise.all([getWorld(id), getState(id)]);
  if (!meta) return;
  // A level's design may have changed since this was saved: start it over on the current one.
  const def = getLevel(meta.config.level);
  if (def && JSON.stringify(meta.config) !== JSON.stringify(levelConfig(def))) {
    await saveWorld({ ...meta, config: levelConfig(def), status: 'playing', cleared: 0, total: 0, elapsedMs: 0, cam: null, thumb: null }, new Int32Array(0));
    return openWorld(id);
  }
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
  return confirm(tr(`Restart "${meta.name}"? Your progress on this world will be lost.`));
}

// --- Home -------------------------------------------------------------------------------

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
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
  return m.config.mode === 'island' && (m.status === 'won' || isDebug());
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
      const keeps = m.config.mode === 'island' && m.status === 'won';
      if (!confirm(tr(`Delete "${m.name}" forever?${keeps ? '\n\nIts trophy stays in Finished islands.' : ''}`))) return;
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
  const all = await listWorlds();
  const worlds = all.filter((m) => !m.config.level); // adventure levels live on their own screen
  $worlds.replaceChildren(
    ...(worlds.length
      ? worlds.map(worldCard)
      : [node('p', { class: 'empty', textContent: 'No worlds yet. Create your first one!' })]),
  );
  const today = worlds.find((m) => m.id === `daily-${todayKey()}`);
  const daily = el('h-daily');
  daily.textContent = !today || (today.status === 'playing' && today.cleared === 0)
    ? '📅 Start daily island'
    : today.status === 'won'
      ? `📅 Daily island · cleared ${fmtTime(today.elapsedMs)}`
      : today.status === 'lost'
        ? '📅 Daily island · lost'
        : `📅 Continue daily island · ${today.total ? Math.floor((today.cleared / today.total) * 100) : 0}%`;
  const cleared = (await listTrophies()).length;
  el('h-trophies').textContent = cleared ? `🏆 Trophy room (${cleared})` : '🏆 Trophy room';
  const last = all.find((m) => m.status === 'playing');
  $continue.hidden = !last;
  if (last) {
    $continue.textContent = `▶ Continue "${last.name}"`;
    $continue.onclick = () => void openWorld(last.id);
  }
}

/** Leaving an overworld game you actually played puts the overworld back on the menu background. */
function noteLeavingGame() {
  if (screen === 'game' && current && !current.config.space && snapshot().cleared > 0) setBackgroundRealm(false);
}

async function goHome() {
  noteLeavingGame();
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
    const space = world.is_space();
    world.free();
    const mod = await import('./viewer3d');
    if (token !== viewerToken) return; // closed while loading
    viewer = mod.openIsland(el('viewer-stage'), { size, cells, space });
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

/** Shows a trophy in 3D (the terrain is rebuilt from its seed, so the world itself is not needed). */
function trophyAsWorld(t: Trophy): WorldMeta {
  return {
    id: t.id,
    name: t.name,
    config: t.config,
    status: 'won',
    cleared: 0,
    total: 0,
    elapsedMs: t.elapsedMs,
    cam: null,
    thumb: t.thumb,
    worldgen: t.config.gen ?? 1,
    createdAt: t.wonAt,
    updatedAt: t.wonAt,
  };
}

async function openTrophies() {
  const trophies = await listTrophies();
  const stillThere = new Set<string>();
  for (const t of trophies) if (await getWorld(t.id)) stillThere.add(t.id);
  el('trophy-list').replaceChildren(
    ...(trophies.length
      ? trophies.map((t) => {
          const c = t.config;
          const thumb = node('div', { class: 'thumb' });
          if (t.thumb) thumb.style.backgroundImage = `url(${t.thumb})`;
          const actions: HTMLElement[] = [
            node('button', { class: 'primary', textContent: '🌍 View in 3D', onclick: () => void openViewer(trophyAsWorld(t)) }),
          ];
          // the world itself may have been deleted: then there is no map to open
          if (stillThere.has(t.id)) actions.push(node('button', { textContent: '👁 Open map', onclick: () => void openWorld(t.id) }));
          actions.push(
            node('button', {
              class: 'danger',
              textContent: '🗑',
              title: 'Remove this trophy',
              ariaLabel: `Remove the trophy ${t.name}`,
              onclick: async () => {
                if (!confirm(tr(`Remove "${t.name}" from your Finished islands?`))) return;
                await deleteTrophy(t.id);
                await openTrophies();
              },
            } as Partial<HTMLButtonElement>),
          );
          return node(
            'article',
            { class: 'card won' },
            thumb,
            node(
              'div',
              { class: 'info' },
              node('div', { class: 'name' }, t.name, node('span', { class: 'badge won', textContent: '🏝 Cleared' })),
              node('div', { class: 'meta', textContent: `${c.size}×${c.size} · ${c.difficulty} · ${fmtTime(t.elapsedMs)}` }),
              node('div', { class: 'meta dim', textContent: `Seed ${c.seedText} · ${ago(t.wonAt)}` }),
            ),
            node('div', { class: 'card-actions' }, ...actions),
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
    tile('Daily islands cleared', n(Object.keys(stats.dailyWins).length)),
    tile('Daily streak', dailyStreak() ? `🔥 ${dailyStreak()}` : '–'),
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

// --- Daily island -----------------------------------------------------------------------

/** One island per UTC day, the same for everyone. Continues today's island if you already started it. */
async function openDaily() {
  const key = todayKey();
  const id = `daily-${key}`;
  if (!(await getWorld(id))) {
    const now = Date.now();
    await saveWorld(
      {
        id,
        name: `Daily island · ${key}`,
        config: dailyConfig(key),
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
      },
      new Int32Array(0),
    );
    bump('worldsCreated');
  }
  await openWorld(id);
}

// --- Adventure ---------------------------------------------------------------------------

const levelWorldId = (l: LevelDef) => `adv-${l.id}`;
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

async function openAdventure() {
  noteLeavingGame();
  if (screen === 'game') await saveCurrent(true);
  current = null;
  show('adventure');
  await renderAdventure();
}

/** A small picture of a level's map (no mines shown), filled in shortly after the cards appear. */
function paintLevelThumb(canvas: HTMLCanvasElement, l: LevelDef) {
  const css = 132;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = Math.round(css * dpr);
  const pctx = canvas.getContext('2d')!;
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const world = makeWorld(levelConfig(l));
  const zoom = l.mode === 'island' ? css / ((l.size ?? 64) * 1.05) : 2.6;
  draw(pctx, world, { cx: 0.5, cy: 0.5, zoom }, css, css, 'preview');
  world.free();
}

async function renderAdventure() {
  const [progress, metas] = await Promise.all([loadProgress(), listWorlds()]);
  const total = LEVELS.length * 3;
  const got = LEVELS.reduce((n, l) => n + (progress[l.id]?.stars ?? 0), 0);
  el('adv-stars').textContent = `★ ${got} / ${total}`;
  const thumbs: [HTMLCanvasElement, LevelDef][] = [];
  el('levels').replaceChildren(
    ...LEVELS.map((l, i) => {
      const open = isDebug() || isUnlocked(progress, i);
      const res = progress[l.id];
      const meta = metas.find((m) => m.id === levelWorldId(l));
      const status = !open
        ? 'Locked'
        : res
          ? `Best ${fmtTime(res.bestMs)}`
          : meta?.status === 'playing' && meta.cleared > 0
            ? 'In progress'
            : 'New';
      const canvas = node('canvas', { class: 'lv-thumb' });
      thumbs.push([canvas, l]);
      return node(
        'button',
        { class: `level${open ? '' : ' locked'}`, disabled: !open, onclick: () => openBrief(l) },
        node('span', { class: 'lv-pic' }, canvas, node('span', { class: 'lv-num', textContent: String(i + 1) }), ...(open ? [] : [node('span', { class: 'lv-lock', textContent: '🔒' })])),
        node('b', { class: 'lv-title', textContent: l.title }),
        node('span', { class: 'lv-mode', textContent: l.space ? (l.mode === 'island' ? '☄ Meteor' : '☾ Moon') : l.mode === 'island' ? '🏝 Island' : '♾ Endless' }),
        node('span', { class: 'lv-stars', textContent: stars(open ? (res?.stars ?? 0) : 0) }),
        node('small', { class: 'lv-status', textContent: status }),
      );
    }),
  );
  // paint one at a time so the screen appears at once
  let k = 0;
  const next = () => {
    const t = thumbs[k++];
    if (!t || screen !== 'adventure') return;
    paintLevelThumb(t[0], t[1]);
    setTimeout(next, 0);
  };
  setTimeout(next, 0);
}

function goalLine(l: LevelDef) {
  const g = l.goal;
  const hearts = `${l.hearts} ♥ · three stars for no mistakes`;
  if (g.type === 'clear-chunk') return `Goal: clear the glowing area · ${hearts}`;
  if (g.type === 'reach') return `Goal: reveal the X · ${hearts}`;
  return `Goal: clear every safe square · ${hearts}`;
}

async function openBrief(l: LevelDef) {
  const meta = await getWorld(levelWorldId(l));
  el('brief-title').textContent = `Level ${levelNumber(l)} · ${l.title}`;
  el('brief-body').replaceChildren(...l.intro.map((t) => node('p', { textContent: t })));
  el('brief-goal').textContent = goalLine(l);
  const go = el<HTMLButtonElement>('brief-go');
  go.textContent = meta?.status === 'playing' && meta.cleared > 0 ? '▶ Continue' : meta ? '↻ Play again' : 'Begin';
  go.onclick = () => void startLevel(l);
  el('brief').hidden = false;
}

function closeBrief() {
  el('brief').hidden = true;
}

async function startLevel(l: LevelDef) {
  closeBrief();
  const id = levelWorldId(l);
  const meta = await getWorld(id);
  if (meta && meta.status === 'playing') return openWorld(id);
  if (meta) return restartWorld(id);
  const now = Date.now();
  await saveWorld(
    {
      id,
      name: `Level ${levelNumber(l)} · ${l.title}`,
      config: levelConfig(l),
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
    },
    new Int32Array(0),
  );
  await openWorld(id);
}

// --- Pause menu -------------------------------------------------------------------------

/** Fills the menu with the current state each time it opens. */
function syncMenu() {
  el('pause-name').textContent = current?.name ?? '';
  const island = current?.config.mode === 'island';
  const can3d = island && (snapshot().status === 'won' || isDebug());
  el('m-3d').hidden = !can3d;
  el('pm-3d').hidden = !can3d;
}

function openPause() {
  if (screen !== 'game') return;
  if (!$pause.hidden) return closePause();
  syncMenu();
  $pause.hidden = false;
}
const closePause = () => ($pause.hidden = true);

function bindGameMenu() {
  for (const id of ['m-3d', 'pm-3d'])
    el(id).addEventListener('click', () => {
    closePause();
    if (current) {
      const s = snapshot();
      void openViewer({ ...current, status: s.status, elapsedMs: s.elapsedMs });
    }
  });
  el('p-resume').addEventListener('click', closePause);
  for (const id of ['p-restart', 'pm-restart']) el(id).addEventListener('click', () => void restartCurrent());
  for (const id of ['p-exit', 'pm-exit']) {
    el(id).addEventListener('click', () => void (current?.config.level ? openAdventure() : goHome()));
  }
  el('pm-advanced').addEventListener('click', () => el('h-settings').click());
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
let spaceUnlocked = false;
const realmSeg = segmented('c-realm', (v) => {
  if (v === 'space' && !spaceUnlocked) {
    realmSeg.set('overworld');
    toast('Beat a space map in Adventure to unlock Space.');
    return;
  }
  syncCreatorVisibility();
  refreshPreview();
});
const isSpaceRealm = () => realmSeg.get() === 'space';
const worldKindName = () => (isSpaceRealm() ? (modeSeg.get() === 'island' ? 'Meteor' : 'Moon') : modeSeg.get() === 'island' ? 'Island' : 'Endless');
const $size = el<HTMLInputElement>('c-size');
const $hearts = el<HTMLInputElement>('c-hearts');
const sizeStep = () => SIZE_STEPS[Number($size.value)];
function syncSizeLabels() {
  const s = sizeStep();
  el('c-size-val').textContent = `${s.name[0].toUpperCase()}${s.name.slice(1)} · ${s.size}×${s.size}`;
  el('c-hearts-val').textContent = Number($hearts.value) ? `${$hearts.value} ♥` : 'off';
}
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
  const space = isSpaceRealm();
  const set = (id: string, text: string) => {
    const b = el(id);
    if (b.dataset.t !== text) {
      b.dataset.t = text;
      b.textContent = text;
    }
  };
  set('c-endless-btn', space ? '☾ Moon' : '♾ Endless');
  set('c-island-btn', space ? '☄ Meteor' : '🏝 Island');
  set('c-space-btn', spaceUnlocked ? '☄ Space' : '🔒 Space');
  el('c-realm-hint').textContent = space
    ? 'Craters instead of coasts, and a dark sky. Some mines are negative: they subtract from the numbers around them. Use the purple flag for those.'
    : spaceUnlocked
      ? ''
      : 'Space opens when you beat a space map in Adventure.';
  el('c-size-wrap').hidden = !island;
  el('c-mode-hint').textContent = space
    ? island
      ? 'A finite meteor floating in the void. Clear every safe cell to win. You can only reveal near explored ground, and rare oracles hide under safe cells.'
      : 'An endless cratered moon. Score points by clearing cells: the farther from the start, the more each is worth (and the denser the mines).'
    : island
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
    size: sizeStep().size,
    difficulty: diffSeg.get() as Difficulty,
    density: Number($d0.value) / 100,
    maxDensity: Number($d1.value) / 100,
    gen: WORLD_GEN,
    ...(isSpaceRealm() ? { space: true } : {}),
    ...(Number($hearts.value) ? { hearts: Number($hearts.value) } : {}),
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
  spaceUnlocked = isDebug() || isSpaceUnlocked(await loadProgress());
  realmSeg.set('overworld');
  modeSeg.set('island');
  $size.value = String(SIZE_STEPS.findIndex((s) => s.size === ISLAND_SIZES.medium));
  $hearts.value = '0';
  el<HTMLDetailsElement>('c-advanced').open = false;
  syncSizeLabels();
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
      $name.value = `${worldKindName()} ${n}`;
    }
  });
  el('c-realm').addEventListener('click', async () => {
    if ($name.dataset.auto) {
      const n = (await listWorlds()).length + 1;
      $name.value = `${worldKindName()} ${n}`;
    }
  });
  for (const r of [$size, $hearts])
    r.addEventListener('input', () => {
      syncSizeLabels();
      refreshPreview();
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
    // no vibration motor (a computer, iPhone Safari): hide every vibration control
    for (const id of ['s-vibration-row', 'm-vibration-row']) el(id).hidden = true;
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

/** The previous / next / repeat controls (in Settings and in the desktop game menu) and the credits. */
function bindMusicPlayer() {
  const sync = () => {
    const t = currentTrack();
    document.querySelectorAll('[data-music-title]').forEach((e) => (e.textContent = t?.title ?? '–'));
    document.querySelectorAll('[data-music-artist]').forEach((e) => (e.textContent = t?.artist ?? ''));
    document.querySelectorAll<HTMLElement>('[data-music="repeat"]').forEach((b) => b.setAttribute('aria-pressed', String(settings.musicRepeat)));
    const open = new Set(playlist().map((p) => p.id));
    el('credits').replaceChildren(
      ...TRACKS.filter((t) => open.has(t.id)).map((t) => node('p', {}, ...t.credit.flatMap((l, i) => (i ? [node('br'), l] : [l])))),
    );
  };
  sync();
  onMusicChange(sync);
  onSettingsChange(sync);
  document.querySelectorAll<HTMLElement>('[data-music]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.music;
      if (a === 'prev') previousTrack();
      else if (a === 'next') nextTrack();
      else toggleRepeat();
    }),
  );
}

/** The audio and vibration buttons floating on the main menu. */
function bindQuickToggles() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-quick]')];
  const tokens = () => ({
    music: settings.music ? '♪' : '♫',
    sound: settings.sound ? '🔊' : '🔇',
    vibration: settings.vibration && vibrationSupported ? '📳' : '📴',
  });
  const sync = () => {
    const t = tokens();
    for (const b of buttons) {
      const token = t[b.dataset.quick as keyof typeof t];
      if (b.dataset.t === token) continue;
      b.dataset.t = token;
      b.textContent = token;
    }
  };
  sync();
  onSettingsChange(sync);
  for (const b of buttons) {
    const kind = b.dataset.quick;
    if (kind === 'vibration' && !vibrationSupported) b.hidden = true;
    b.addEventListener('click', () => {
      if (kind === 'music') setSetting('music', !settings.music);
      else if (kind === 'sound') {
        setSetting('sound', !settings.sound);
        if (settings.sound) sound.test();
      } else {
        setSetting('vibration', !settings.vibration);
        if (settings.vibration) haptics.test();
      }
    });
  }
}

// --- Boot -------------------------------------------------------------------------------

/** Islands cleared before trophies had their own storage get one now. */
async function backfillTrophies() {
  try {
    const have = new Set((await listTrophies()).map((t) => t.id));
    for (const m of await listWorlds()) {
      if (m.config.mode === 'island' && m.status === 'won' && !have.has(m.id)) {
        await saveTrophy({ id: m.id, name: m.name, config: m.config, elapsedMs: m.elapsedMs, thumb: m.thumb, wonAt: m.updatedAt });
      }
    }
  } catch (err) {
    console.warn('Could not carry over earlier trophies', err);
  }
}

export async function start() {
  await init();
  await loadStats();
  await backfillTrophies();
  // a player who already beat a space map has the space track
  {
    const done = await loadProgress();
    if (LEVELS.some((l) => l.space && done[l.id])) unlockTrack(SECRET_TRACK);
  }
  initTheme();
  initMusic();
  initEagle();
  initCursor();
  requestPersistence();
  initGame({
    onChange: scheduleSave,
    onMenu: openPause,
    onHome: () => void goHome(),
    onRestart: () => void restartCurrent(),
    onNextLevel: (l) => {
      const next = nextLevel(l);
      if (next) void saveCurrent(true).then(() => openBrief(next));
    },
    onLevelResult: () => void 0,
    onView3D: () => {
      if (!current) return;
      const s = snapshot();
      void openViewer({ ...current, status: s.status, elapsedMs: s.elapsedMs });
    },
  });
  bindCreator();
  // phones: the drifting background map stops while any menu, screen or dialog covers it
  const phone = matchMedia('(max-width: 720px), (pointer: coarse)');
  let holdQueued = false;
  const syncHold = () => {
    holdQueued = false;
    const covered = !!document.querySelector('.overlay:not([hidden]), .screen:not(#home-screen):not([hidden])');
    holdBackground(phone.matches && covered);
  };
  new MutationObserver(() => {
    if (holdQueued) return;
    holdQueued = true;
    requestAnimationFrame(syncHold);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  initDebug(toast);
  // screens built from saved progress are redrawn when the switch flips
  onDebugChange(() => {
    if (screen === 'adventure') void renderAdventure();
    else if (screen === 'worlds') void renderHome();
    else if (screen === 'game') syncMenu();
  });
  bindSettings();
  bindGameMenu();
  bindViewer();
  setupInstall(el<HTMLButtonElement>('h-install'), el('ios-hint'));
  const $update = el('update');
  el('update-reload').addEventListener('click', () => location.reload());
  el('update-dismiss').addEventListener('click', () => ($update.hidden = true));
  registerServiceWorker(() => ($update.hidden = false));

  const $lang = el('h-lang');
  $lang.textContent = lang.toUpperCase();
  $lang.addEventListener('click', () => setLang(lang === 'en' ? 'pt' : 'en'));
  el('s-clear').addEventListener('click', async () => {
    if (!confirm(tr('Clear all data? Every world, trophy, record, setting and your Adventure progress will be deleted from this device.'))) return;
    if (!confirm(tr('This cannot be undone. Are you absolutely sure you want to erase everything and start from scratch?'))) return;
    wiping = true;
    freezeStats();
    stopPlay();
    await saveChain.catch(() => undefined);
    await clearAllData();
    location.reload();
  });
  el('h-new').addEventListener('click', () => void openCreator());
  el('w-new').addEventListener('click', () => void openCreator());
  el('h-worlds').addEventListener('click', () => show('worlds'));
  el('worlds-back').addEventListener('click', () => void goHome());
  bindQuickToggles();
  bindMusicPlayer();
  el('h-daily').addEventListener('click', () => void openDaily());
  el('h-adventure').addEventListener('click', () => void openAdventure());
  el('adv-back').addEventListener('click', () => void goHome());
  el('brief-cancel').addEventListener('click', closeBrief);
  el('h-stats').addEventListener('click', () => void openStats());
  el('stats-back').addEventListener('click', () => void goHome());
  el('stats-reset').addEventListener('click', async () => {
    if (!confirm(tr('Reset all lifetime stats and records? Your saved worlds are not affected.'))) return;
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
