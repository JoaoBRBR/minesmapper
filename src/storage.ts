// Saved worlds live in the browser's IndexedDB (per device + browser, survives
// restarts). Metadata and the (larger) progress arrays are kept in separate
// stores so the world list loads fast. If IndexedDB is unavailable (some private
// modes), an in-memory fallback keeps the app working for the session.

export type Mode = 'endless' | 'island';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'custom';
export type Status = 'playing' | 'won' | 'lost';

export interface WorldConfig {
  mode: Mode;
  /** Numeric seed actually used for generation. */
  seed: number;
  /** What the player typed (shown in the UI); may be a word. */
  seedText: string;
  /** Island side length in cells (island mode only). */
  size: number;
  difficulty: Difficulty;
  /** Mine probability near the centre / far away (or at the coast). */
  density: number;
  maxDensity: number;
  /**
   * World-generation version. Absent (1) on older saves, so their islands look as before;
   * 2 makes island features a fixed size, so bigger islands hold more biomes.
   */
  gen?: number;
  /** Set on the daily island: the (UTC) date it belongs to, e.g. 2026-11-17. */
  daily?: string;
}

export interface CamState {
  cx: number;
  cy: number;
  zoom: number;
}

export interface WorldMeta {
  id: string;
  name: string;
  config: WorldConfig;
  status: Status;
  /** Cells cleared so far. */
  cleared: number;
  /** Safe cells needed to clear the island (0 in endless mode). */
  total: number;
  /** Distance-weighted score (endless). Absent in saves made before it existed. */
  points?: number;
  /** Farthest revealed distance from the start, in cells (endless). */
  farthest?: number;
  elapsedMs: number;
  cam: CamState | null;
  /** Small JPEG data URL of the last view. */
  thumb: string | null;
  /** Bump when terrain/mine generation changes, so old saves can be handled. */
  worldgen: number;
  createdAt: number;
  updatedAt: number;
}

export const WORLDGEN_VERSION = 2;

/**
 * A cleared island, kept on its own: deleting the world it came from does not remove it, and the
 * 3D view only needs the settings (the terrain is rebuilt from the seed).
 */
export interface Trophy {
  /** Same id as the world it came from. */
  id: string;
  name: string;
  config: WorldConfig;
  /** Fastest clearing time (ms). */
  elapsedMs: number;
  /** Portrait of the whole island. */
  thumb: string | null;
  wonAt: number;
}

const DB_NAME = 'minefield';
const WORLDS = 'worlds';
const STATES = 'states';
const KV = 'kv';
const TROPHIES = 'trophies';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memWorlds = new Map<string, WorldMeta>();
const memStates = new Map<string, Int32Array>();
const memKV = new Map<string, unknown>();
const memTrophies = new Map<string, Trophy>();

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        // Runs for fresh installs (v0 -> v2) and upgrades (v1 -> v2); only add what is missing.
        const db = req.result;
        if (!db.objectStoreNames.contains(WORLDS)) db.createObjectStore(WORLDS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STATES)) db.createObjectStore(STATES);
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(TROPHIES)) db.createObjectStore(TROPHIES, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const wrap = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

/** All saved worlds, most recently played first. */
export async function listWorlds(): Promise<WorldMeta[]> {
  const db = await openDb();
  const all = db
    ? await wrap(db.transaction(WORLDS).objectStore(WORLDS).getAll() as IDBRequest<WorldMeta[]>)
    : [...memWorlds.values()];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getWorld(id: string): Promise<WorldMeta | undefined> {
  const db = await openDb();
  return db ? wrap(db.transaction(WORLDS).objectStore(WORLDS).get(id)) : memWorlds.get(id);
}

export async function getState(id: string): Promise<Int32Array | null> {
  const db = await openDb();
  const s = db ? await wrap(db.transaction(STATES).objectStore(STATES).get(id)) : memStates.get(id);
  return s && s.length > 0 ? s : null;
}

/** Saves metadata and (optionally) progress atomically. */
export async function saveWorld(meta: WorldMeta, state?: Int32Array): Promise<void> {
  const db = await openDb();
  if (!db) {
    memWorlds.set(meta.id, meta);
    if (state) memStates.set(meta.id, state);
    return;
  }
  const tx = db.transaction([WORLDS, STATES], 'readwrite');
  tx.objectStore(WORLDS).put(meta);
  if (state) tx.objectStore(STATES).put(state, meta.id);
  await done(tx);
}

export async function deleteWorld(id: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memWorlds.delete(id);
    memStates.delete(id);
    return;
  }
  const tx = db.transaction([WORLDS, STATES], 'readwrite');
  tx.objectStore(WORLDS).delete(id);
  tx.objectStore(STATES).delete(id);
  await done(tx);
}

/** Small app-level values (e.g. lifetime stats) that are not tied to a world. */
export async function getKV<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return db ? wrap(db.transaction(KV).objectStore(KV).get(key)) : (memKV.get(key) as T | undefined);
}

export async function setKV(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) {
    memKV.set(key, value);
    return;
  }
  const tx = db.transaction(KV, 'readwrite');
  tx.objectStore(KV).put(value, key);
  await done(tx);
}

/** Records (or updates) a trophy. The first win date, the portrait and the best time are kept. */
export async function saveTrophy(t: Omit<Trophy, 'wonAt'> & { wonAt?: number }): Promise<void> {
  const merge = (old: Trophy | undefined): Trophy => ({
    ...t,
    wonAt: old?.wonAt ?? t.wonAt ?? Date.now(),
    thumb: t.thumb ?? old?.thumb ?? null,
    elapsedMs: old && old.elapsedMs > 0 && (t.elapsedMs <= 0 || old.elapsedMs < t.elapsedMs) ? old.elapsedMs : t.elapsedMs,
  });
  const db = await openDb();
  if (!db) {
    memTrophies.set(t.id, merge(memTrophies.get(t.id)));
    return;
  }
  const tx = db.transaction(TROPHIES, 'readwrite');
  const store = tx.objectStore(TROPHIES);
  const old = (await wrap(store.get(t.id))) as Trophy | undefined;
  store.put(merge(old));
  await done(tx);
}

/** All trophies, most recent first. */
export async function listTrophies(): Promise<Trophy[]> {
  const db = await openDb();
  const all = db
    ? await wrap(db.transaction(TROPHIES).objectStore(TROPHIES).getAll() as IDBRequest<Trophy[]>)
    : [...memTrophies.values()];
  return all.sort((a, b) => b.wonAt - a.wonAt);
}

export async function deleteTrophy(id: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memTrophies.delete(id);
    return;
  }
  const tx = db.transaction(TROPHIES, 'readwrite');
  tx.objectStore(TROPHIES).delete(id);
  await done(tx);
}

/** Ask the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
