//! Infinite minesweeper world.
//!
//! The world is stateless: whether a cell is a mine, and what the terrain
//! looks like, are pure functions of `(seed, x, y)`. Only what the player has
//! touched (revealed / flagged / exploded cells) is stored.

mod island;
mod noise;
pub mod solver;
mod terrain;

use island::Island;
use noise::hash;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use terrain::{Terrain, B_OCEAN, CH, SEA};
use wasm_bindgen::prelude::*;

/// Terrain chunks kept in memory before the cache is flushed.
const MAX_CACHED_CHUNKS: usize = 4096;

/// You may only reveal a cell within this many cells (Chebyshev) of an already
/// revealed one, so a lucky far-away click can't skip the work in between.
const REACH: i32 = 3;
/// Endless mode: the very first click must be this close to the origin.
const FIRST_CLICK_RADIUS: i32 = 8;

/// Points for clearing a cell at distance `d` from the origin: farther is worth more
/// (and more dangerous, since mines get denser).
fn cell_points(d: f64) -> f64 {
    1.0 + d / 100.0
}

fn dist_from_origin(x: i32, y: i32) -> f64 {
    ((x as f64).powi(2) + (y as f64).powi(2)).sqrt()
}

/// Probability that a safe cell hides a reveal-one-cell power-up ("oracle"), by local
/// mine density. Derived from `examples/calibrate.rs`: a perfect solver is forced into a
/// coin-flip about this often per cleared cell, so oracles are exactly as rare as the
/// guesses they cure (measured per 1000 cells: 0.06 @20%, 0.44 @24%, 7.9 @28%, 32 @30%,
/// 81 @34%, 132 @36%). The table is that curve made roughly three times more generous, with a
/// floor of about one oracle per 800 safe cells, so they are a pleasant find everywhere.
const POWERUP_RATE: [(f32, f64); 12] = [
    (0.00, 0.0012),
    (0.20, 0.0012),
    (0.22, 0.0016),
    (0.24, 0.0035),
    (0.26, 0.008),
    (0.28, 0.03),
    (0.30, 0.09),
    (0.32, 0.12),
    (0.34, 0.17),
    (0.36, 0.22),
    (0.45, 0.25),
    (1.00, 0.25),
];

fn powerup_rate(density: f32) -> f64 {
    for pair in POWERUP_RATE.windows(2) {
        let ((d0, r0), (d1, r1)) = (pair[0], pair[1]);
        if density <= d1 {
            let t = ((density - d0) / (d1 - d0)).clamp(0.0, 1.0) as f64;
            return r0 + (r1 - r0) * t;
        }
    }
    POWERUP_RATE[POWERUP_RATE.len() - 1].1
}

/// Side of a "cleanup chunk": when every safe cell in one is revealed, the numbers, flags
/// and mines inside it (away from unfinished ground) are tidied away.
const CLEAN_CHUNK: i32 = 16;

/// Chance that a safe cell hides an "ice clearer" power-up. Fixed and small on purpose: they
/// are meant to be rare, found by luck.
const ICE_CLEARER_RATE: f64 = 0.0003;
/// An ice clearer thins the ice over at most this many water cells (nearest to where it is used).
const MAX_ICE_CELLS: usize = 6000;

fn clean_key(x: i32, y: i32) -> (i32, i32) {
    (x.div_euclid(CLEAN_CHUNK), y.div_euclid(CLEAN_CHUNK))
}

/// Max cells recorded per action in the reveal log (the log only drives animation).
const MAX_LOG: usize = 60_000;

/// Safety valve: a single click never reveals more than this many cells.
const MAX_FLOOD: usize = 100_000;

/// Cell state encoding returned by [`World::view`] (byte 0 of each cell):
/// bits 0-3 = adjacent mine count, bits 4-5 = state.
pub const ST_HIDDEN: u8 = 0x00;
pub const ST_FLAG: u8 = 0x10;
pub const ST_REVEALED: u8 = 0x20;
/// Hidden or flagged water cell that is under see-through ice (bit 6) ...
pub const ST_ICE: u8 = 0x40;
/// ... and a mine can be made out beneath it (bit 7). Only set together with `ST_ICE`.
pub const ST_ICE_MINE: u8 = 0x80;
/// Set on a cell inside a tidied-up area: draw it as plain cleared ground (bit 7).
pub const ST_CLEAN: u8 = 0x80;
/// Set on a revealed cell that held a power-up (bit 6, outside the state/count bits).
pub const ST_POWERUP: u8 = 0x40;
pub const ST_MINE: u8 = 0x30; // low bit 1 = exploded, 0 = shown after loss
/// Bump when the `export_state` layout changes.
const STATE_VERSION: i32 = 4;

/// Hidden state with low nibble 0xF = not playable (water outside the island).
pub const ST_VOID: u8 = 0x0f;
/// Open sea inside a cleared chunk: still unplayable, but shown with its water colour.
pub const ST_SEA: u8 = 0x0e;

#[wasm_bindgen]
pub struct World {
    seed: u32,
    /// Mine probability at the origin, rising towards `max_density` with distance.
    base_density: f32,
    max_density: f32,
    /// Distance (cells) over which the density closes ~63% of the gap to max.
    ramp_len: f32,
    terrain: Terrain,
    chunks: RefCell<HashMap<(i32, i32), Rc<Vec<u8>>>>,
    /// First click: this cell and its neighbours are guaranteed safe.
    safe_origin: Option<(i32, i32)>,
    revealed: HashSet<(i32, i32)>,
    flagged: HashSet<(i32, i32)>,
    exploded: HashSet<(i32, i32)>,
    game_over: bool,
    won: bool,
    /// `(x, y, depth)` triples for cells revealed since the last `take_reveal_log`.
    reveal_log: Vec<i32>,
    /// Distance-weighted score and the farthest revealed distance (derived from `revealed`).
    points: f64,
    farthest: f64,
    /// Power-ups found (revealed cells that hid one) and spent.
    powerups_found: u32,
    powerups_used: u32,
    /// Revealed cells whose power-up the player has picked up (by tapping it).
    collected: HashSet<(i32, i32)>,
    /// Per cleanup chunk: (safe cells in it, safe cells revealed so far).
    chunk_stats: HashMap<(i32, i32), (u16, u16)>,
    clean_chunks: HashSet<(i32, i32)>,
    /// Chunks that became clean since the last `take_clean_log` (`cx, cy` pairs).
    clean_log: Vec<i32>,
    /// Ice clearers found / spent, where they were used, and the water cells now see-through.
    ice_found: u32,
    ice_used: u32,
    ice_seeds: Vec<(i32, i32)>,
    ice_cells: HashSet<(i32, i32)>,
    island: Option<Island>,
    /// Mines on the island (island mode only; recomputed after the first click).
    mines_total: u32,
    /// Mistakes allowed before the game is lost; 0 = the first mine ends it.
    hearts_max: u32,
    goal: Goal,
    /// Where the very first tap may land `(x0, y0, x1, y1)`, inclusive; `None` = anywhere allowed.
    first_area: Option<(i32, i32, i32, i32)>,
}

/// What wins the game besides clearing the whole island.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Goal {
    None,
    /// Clear this cleanup chunk (chunk units).
    Chunk(i32, i32),
    /// Reveal this cell.
    Reach(i32, i32),
}

#[wasm_bindgen]
impl World {
    /// `density` is the mine probability at the origin (classic is ~0.16-0.21).
    /// Mines get denser with distance from the origin, approaching
    /// `max_density` (over roughly `ramp_len` cells). `ramp_len <= 0` disables it.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, density: f32, max_density: f32, ramp_len: f32) -> World {
        let base = density.clamp(0.0, 1.0);
        World {
            seed,
            base_density: base,
            max_density: max_density.clamp(base, 1.0),
            ramp_len,
            terrain: Terrain::new(seed),
            chunks: RefCell::new(HashMap::new()),
            safe_origin: None,
            revealed: HashSet::new(),
            flagged: HashSet::new(),
            exploded: HashSet::new(),
            game_over: false,
            won: false,
            reveal_log: Vec::new(),
            points: 0.0,
            farthest: 0.0,
            powerups_found: 0,
            powerups_used: 0,
            collected: HashSet::new(),
            chunk_stats: HashMap::new(),
            clean_chunks: HashSet::new(),
            clean_log: Vec::new(),
            ice_found: 0,
            ice_used: 0,
            ice_seeds: Vec::new(),
            ice_cells: HashSet::new(),
            island: None,
            mines_total: 0,
            hearts_max: 0,
            goal: Goal::None,
            first_area: None,
        }
    }

    /// Mistakes allowed before the game is lost (0 = the first mine ends the game).
    pub fn set_hearts(&mut self, hearts: u32) {
        self.hearts_max = hearts;
    }

    pub fn hearts_max(&self) -> u32 {
        self.hearts_max
    }

    /// Mines stepped on so far.
    pub fn mistakes(&self) -> u32 {
        self.exploded.len() as u32
    }

    /// Win by clearing one cleanup chunk (chunk units) instead of the whole island.
    pub fn set_goal_chunk(&mut self, cx: i32, cy: i32) {
        self.goal = Goal::Chunk(cx, cy);
    }

    /// Win by revealing one cell. That cell and its neighbours are never mines.
    pub fn set_goal_reach(&mut self, x: i32, y: i32) {
        self.goal = Goal::Reach(x, y);
    }

    /// 0 = none, 1 = clear a chunk, 2 = reach a cell.
    pub fn goal_kind(&self) -> u32 {
        match self.goal {
            Goal::None => 0,
            Goal::Chunk(..) => 1,
            Goal::Reach(..) => 2,
        }
    }

    /// Restricts where the first tap may land (cells, inclusive corners).
    pub fn set_first_area(&mut self, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.first_area = Some((x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)));
    }

    /// Cells of the chunk goal still hidden / total safe cells in it: `[done, total]`.
    pub fn goal_progress(&self) -> Vec<u32> {
        match self.goal {
            Goal::Chunk(cx, cy) => {
                let k = (cx, cy);
                if self.clean_chunks.contains(&k) {
                    let t = self.chunk_safe_total(k) as u32;
                    return vec![t, t];
                }
                match self.chunk_stats.get(&k) {
                    Some(&(t, d)) => vec![d as u32, t as u32],
                    None => vec![0, self.chunk_safe_total(k) as u32],
                }
            }
            Goal::Reach(x, y) => vec![self.revealed.contains(&(x, y)) as u32, 1],
            Goal::None => vec![0, 0],
        }
    }

    /// A bounded island of `size` x `size` cells surrounded by water. Mine
    /// density rises from `density` at the centre to `max_density` at the coast.
    pub fn new_island(seed: u32, size: u32, density: f32, max_density: f32, generation: u32) -> World {
        let terrain = Terrain::new_island(seed, size as i32, generation);
        let island = Island::build(&terrain, size as i32);
        let mut w = World::new(seed, density, max_density, island.size as f32 * 0.35);
        w.terrain = terrain;
        w.island = Some(island);
        w.recount_mines();
        w
    }

    /// Drops cached terrain chunks (callers that render each chunk once, such as
    /// the menu background, use this so the cache never grows).
    pub fn clear_chunk_cache(&self) {
        self.chunks.borrow_mut().clear();
    }

    pub fn is_island(&self) -> bool {
        self.island.is_some()
    }

    /// Side length of the island in cells (0 in endless mode).
    pub fn island_size(&self) -> u32 {
        self.island.as_ref().map_or(0, |i| i.size as u32)
    }

    /// Playable land cells (0 in endless mode).
    pub fn land_total(&self) -> u32 {
        self.island.as_ref().map_or(0, |i| i.land_count)
    }

    /// The island's whole terrain for 3D viewing: `size * size` cells, row-major from the
    /// north-west corner, two bytes each: `[biome, elevation]` (elevation 0..=255, sea level is
    /// about 107). Land cut off from the island is flattened into shallow water. Empty in
    /// endless mode. Depends only on the seed, never on progress.
    pub fn island_snapshot(&self) -> Vec<u8> {
        let Some(island) = &self.island else { return Vec::new() };
        let h = island.half();
        let n = (2 * h) as usize;
        let mut out = Vec::with_capacity(n * n * 2);
        for y in -h..h {
            for x in -h..h {
                let e = self.terrain.elevation(x, y);
                let (mut biome, _) = self.terrain.cell(x, y);
                let mut height = e;
                if e >= SEA && !island.contains(x, y) {
                    biome = B_OCEAN;
                    height = SEA - 0.02;
                }
                out.push(biome);
                out.push((height.clamp(0.0, 1.0) * 255.0) as u8);
            }
        }
        out
    }

    /// Playable cells that are inner-lake water (0 in endless mode).
    pub fn lake_total(&self) -> u32 {
        self.island.as_ref().map_or(0, |i| i.lake_count)
    }

    pub fn mines_total(&self) -> u32 {
        self.mines_total
    }

    /// Safe cells that must be revealed to clear the island.
    pub fn safe_total(&self) -> u32 {
        self.land_total().saturating_sub(self.mines_total)
    }

    pub fn is_won(&self) -> bool {
        self.won
    }

    /// Whether a cell can be played (always true in endless mode).
    pub fn is_playable(&self, x: i32, y: i32) -> bool {
        self.island.as_ref().map_or(true, |i| i.contains(x, y))
    }

    fn recount_mines(&mut self) {
        let Some(island) = &self.island else { return };
        let h = island.half();
        let mut n = 0;
        for y in -h..h {
            for x in -h..h {
                if island.contains(x, y) && self.is_mine(x, y) {
                    n += 1;
                }
            }
        }
        self.mines_total = n;
    }

    /// Serialises player progress (not the world itself, which is deterministic).
    /// Layout: `[version, flags, origin_x, origin_y, n, (x, y) * n]` followed by
    /// the same `[n, (x, y) * n]` block for flagged and then exploded cells, then
    /// (version 2) the number of power-ups spent. Version 1 saves have no such field.
    /// `flags`: bit0 = has first-click origin, bit1 = game over, bit2 = won.
    pub fn export_state(&self) -> Vec<i32> {
        let (ox, oy) = self.safe_origin.unwrap_or((0, 0));
        let flags = self.safe_origin.is_some() as i32
            | (self.game_over as i32) << 1
            | (self.won as i32) << 2;
        let mut out = vec![STATE_VERSION, flags, ox, oy];
        for set in [&self.revealed, &self.flagged, &self.exploded] {
            let mut cells: Vec<(i32, i32)> = set.iter().copied().collect();
            cells.sort_unstable();
            out.push(cells.len() as i32);
            for (x, y) in cells {
                out.push(x);
                out.push(y);
            }
        }
        out.push(self.powerups_used as i32);
        out.push(self.ice_used as i32);
        out.push(self.ice_seeds.len() as i32);
        for &(x, y) in &self.ice_seeds {
            out.push(x);
            out.push(y);
        }
        // Version 4: the power-ups picked up so far.
        let mut got: Vec<(i32, i32)> = self.collected.iter().copied().collect();
        got.sort_unstable();
        out.push(got.len() as i32);
        for (x, y) in got {
            out.push(x);
            out.push(y);
        }
        out
    }

    /// Restores progress saved by [`export_state`] into this (fresh) world.
    /// Returns false, leaving the world untouched, if the data is invalid.
    pub fn import_state(&mut self, data: &[i32]) -> bool {
        fn read_set(data: &[i32], pos: &mut usize) -> Option<HashSet<(i32, i32)>> {
            let n = *data.get(*pos)?;
            if n < 0 {
                return None;
            }
            let n = n as usize;
            let end = pos.checked_add(1)?.checked_add(n.checked_mul(2)?)?;
            let body = data.get(*pos + 1..end)?;
            *pos = end;
            Some(body.chunks_exact(2).map(|c| (c[0], c[1])).collect())
        }
        let version = data.first().copied().unwrap_or(0);
        if data.len() < 4 || !(1..=STATE_VERSION).contains(&version) {
            return false;
        }
        let mut pos = 4;
        let (Some(revealed), Some(flagged), Some(exploded)) =
            (read_set(data, &mut pos), read_set(data, &mut pos), read_set(data, &mut pos))
        else {
            return false;
        };
        let used = if version >= 2 {
            match data.get(pos) {
                Some(&u) if u >= 0 => {
                    pos += 1;
                    u as u32
                }
                _ => return false,
            }
        } else {
            0
        };
        // Version 3 adds the ice clearers: how many were spent, and where.
        let mut ice_used = 0u32;
        let mut ice_seeds: Vec<(i32, i32)> = Vec::new();
        if version >= 3 {
            let (Some(&u), Some(&n)) = (data.get(pos), data.get(pos + 1)) else {
                return false;
            };
            if u < 0 || n < 0 {
                return false;
            }
            let end = pos
                .checked_add(2)
                .and_then(|p| (n as usize).checked_mul(2).and_then(|m| p.checked_add(m)));
            let Some(body) = end.and_then(|e| data.get(pos + 2..e)) else {
                return false;
            };
            ice_used = u as u32;
            ice_seeds = body.chunks_exact(2).map(|c| (c[0], c[1])).collect();
            pos = end.unwrap();
        }
        // Version 4 adds the picked-up power-ups; older saves picked up everything they revealed.
        let collected = if version >= 4 {
            match read_set(data, &mut pos) {
                Some(c) => Some(c),
                None => return false,
            }
        } else {
            None
        };
        if pos != data.len() {
            return false;
        }
        let flags = data[1];
        self.safe_origin = (flags & 1 != 0).then_some((data[2], data[3]));
        self.game_over = flags & 2 != 0;
        self.won = flags & 4 != 0;
        self.revealed = revealed;
        self.flagged = flagged;
        self.exploded = exploded;
        self.collected = collected.unwrap_or_else(|| {
            self.revealed
                .iter()
                .copied()
                .filter(|&(x, y)| self.is_powerup(x, y) || self.is_iceclearer(x, y))
                .collect()
        });
        self.powerups_used = used;
        self.ice_used = ice_used;
        self.ice_seeds = ice_seeds;
        self.reveal_log.clear();
        self.recompute_score();
        self.recount_mines();
        if self.won {
            self.tidy_whole_island();
        }
        true
    }

    pub fn is_game_over(&self) -> bool {
        self.game_over
    }

    /// Distance-weighted score: each cleared cell is worth `1 + distance / 100`.
    pub fn points(&self) -> u32 {
        self.points.floor() as u32
    }

    /// Distance from the origin of the farthest revealed cell, in cells.
    pub fn farthest(&self) -> u32 {
        self.farthest.floor() as u32
    }

    /// How far (in cells) from explored ground you may reveal.
    pub fn reach(&self) -> u32 {
        REACH as u32
    }

    /// Whether the frontier rule allows revealing this cell. The first click is
    /// restricted to the start area in endless mode, and free on an island.
    pub fn can_reveal(&self, x: i32, y: i32) -> bool {
        if self.revealed.is_empty() {
            if let Some((x0, y0, x1, y1)) = self.first_area {
                return (x0..=x1).contains(&x) && (y0..=y1).contains(&y);
            }
            return self.island.is_some() || (x.abs() <= FIRST_CLICK_RADIUS && y.abs() <= FIRST_CLICK_RADIUS);
        }
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                if self.revealed.contains(&(x + dx, y + dy)) {
                    return true;
                }
            }
        }
        false
    }

    /// True when a tap on this cell would be refused only because it is too far
    /// from explored ground (so the UI can explain why).
    pub fn is_out_of_reach(&self, x: i32, y: i32) -> bool {
        !self.game_over
            && !self.won
            && self.is_playable(x, y)
            && !self.revealed.contains(&(x, y))
            && !self.flagged.contains(&(x, y))
            && !self.is_settled(x, y)
            && !self.can_reveal(x, y)
    }

    fn recompute_score(&mut self) {
        self.points = 0.0;
        self.farthest = 0.0;
        let revealed: Vec<(i32, i32)> = self.revealed.iter().copied().collect();
        // Rebuild the tidy-up bookkeeping from the revealed cells.
        self.chunk_stats.clear();
        self.clean_chunks.clear();
        self.clean_log.clear();
        self.ice_found = self.collected.iter().filter(|&&(x, y)| self.is_iceclearer(x, y)).count() as u32;
        self.ice_cells.clear();
        for seed in self.ice_seeds.clone() {
            self.flood_ice(seed);
        }
        let mut per_chunk: HashMap<(i32, i32), u16> = HashMap::new();
        for &(x, y) in &revealed {
            *per_chunk.entry(clean_key(x, y)).or_insert(0) += 1;
        }
        for (k, n) in per_chunk {
            let total = self.chunk_safe_total(k);
            self.chunk_stats.insert(k, (total, n));
            if total > 0 && n >= total {
                self.clean_chunks.insert(k);
            }
        }
        self.powerups_found = self.collected.iter().filter(|&&(x, y)| self.is_powerup(x, y)).count() as u32;
        for (x, y) in revealed {
            let d = dist_from_origin(x, y);
            self.points += cell_points(d);
            self.farthest = self.farthest.max(d);
        }
    }

    /// Power-ups under cells of a finished chunk are picked up for the player, since that ground is
    /// about to be tidied away and could no longer be tapped.
    fn collect_in_chunk(&mut self, k: (i32, i32)) {
        for y in k.1 * CLEAN_CHUNK..(k.1 + 1) * CLEAN_CHUNK {
            for x in k.0 * CLEAN_CHUNK..(k.0 + 1) * CLEAN_CHUNK {
                if self.revealed.contains(&(x, y)) {
                    self.collect(x, y);
                }
            }
        }
    }

    /// Picks up the power-up under a revealed cell. Returns a bit mask: 1 = an oracle was
    /// collected, 2 = an ice clearer, 0 = nothing (no power-up there, or already taken).
    pub fn collect(&mut self, x: i32, y: i32) -> u32 {
        if !self.revealed.contains(&(x, y)) || self.collected.contains(&(x, y)) {
            return 0;
        }
        let mut got = 0;
        if self.is_powerup(x, y) {
            self.powerups_found += 1;
            got |= 1;
        }
        if self.is_iceclearer(x, y) {
            self.ice_found += 1;
            got |= 2;
        }
        if got != 0 {
            self.collected.insert((x, y));
        }
        got
    }

    /// Playable, non-mine cells in a cleanup chunk.
    fn chunk_safe_total(&self, k: (i32, i32)) -> u16 {
        let mut n = 0;
        for y in k.1 * CLEAN_CHUNK..(k.1 + 1) * CLEAN_CHUNK {
            for x in k.0 * CLEAN_CHUNK..(k.0 + 1) * CLEAN_CHUNK {
                if self.is_playable(x, y) && !self.is_mine(x, y) {
                    n += 1;
                }
            }
        }
        n
    }

    /// Terrain at this cell is water (ocean or deep ocean).
    fn is_water(&self, x: i32, y: i32) -> bool {
        let chunk = self.chunk(x.div_euclid(CH), y.div_euclid(CH));
        chunk[((y.rem_euclid(CH) * CH + x.rem_euclid(CH)) * 2) as usize] <= B_OCEAN
    }

    /// Makes every water cell connected to `seed` see-through (up to `MAX_ICE_CELLS`).
    fn flood_ice(&mut self, seed: (i32, i32)) {
        let mut queue = VecDeque::from([seed]);
        let mut seen: HashSet<(i32, i32)> = HashSet::from([seed]);
        let mut count = 0;
        while let Some((x, y)) = queue.pop_front() {
            if count >= MAX_ICE_CELLS {
                break;
            }
            if !self.is_playable(x, y) || !self.is_water(x, y) {
                continue;
            }
            self.ice_cells.insert((x, y));
            count += 1;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let p = (x + dx, y + dy);
                    if seen.insert(p) {
                        queue.push_back(p);
                    }
                }
            }
        }
    }

    /// Bits describing a hidden/flagged cell's ice state (see `ST_ICE`).
    fn ice_bits(&self, x: i32, y: i32, biome: u8) -> u8 {
        if biome <= B_OCEAN && self.ice_cells.contains(&(x, y)) {
            ST_ICE | if self.is_mine(x, y) { ST_ICE_MINE } else { 0 }
        } else {
            0
        }
    }

    /// The number shown on a revealed cell. Mines hidden inside tidied-up ground are left
    /// out, so the number only counts mines the player can still see or has yet to find.
    fn display_count(&self, x: i32, y: i32) -> u8 {
        let n = self.adjacent(x, y);
        if n == 0 || self.game_over || self.clean_chunks.is_empty() {
            return n;
        }
        let mut hidden = 0;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (nx, ny) = (x + dx, y + dy);
                if (dx != 0 || dy != 0) && self.is_settled(nx, ny) && self.is_mine(nx, ny) {
                    hidden += 1;
                }
            }
        }
        n - hidden
    }

    /// Counts a newly revealed safe cell towards its chunk, marking the chunk
    /// clean when it was the last one.
    fn note_revealed(&mut self, x: i32, y: i32) {
        let k = clean_key(x, y);
        if !self.chunk_stats.contains_key(&k) {
            let total = self.chunk_safe_total(k);
            self.chunk_stats.insert(k, (total, 0));
        }
        let stat = self.chunk_stats.get_mut(&k).unwrap();
        stat.1 += 1;
        if stat.1 >= stat.0 && self.clean_chunks.insert(k) {
            self.clean_log.extend([k.0, k.1]);
            self.collect_in_chunk(k);
        }
    }

    /// A cell is tidied away when its chunk is clean and every neighbour outside the
    /// chunk is also clean (or not part of the game), so nothing next to unfinished
    /// ground ever loses information the player still needs.
    pub fn is_settled(&self, x: i32, y: i32) -> bool {
        let k = clean_key(x, y);
        if !self.clean_chunks.contains(&k) || !self.is_playable(x, y) {
            return false;
        }
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (nx, ny) = (x + dx, y + dy);
                let nk = clean_key(nx, ny);
                if nk != k && !self.clean_chunks.contains(&nk) && self.is_playable(nx, ny) {
                    return false;
                }
            }
        }
        true
    }

    /// On a win the whole island is spotless, including chunks that held only mines
    /// (nothing to reveal, so they never completed on their own).
    fn tidy_whole_island(&mut self) {
        let Some(island) = &self.island else { return };
        let h = island.half();
        let (lo, hi) = (clean_key(-h, -h), clean_key(h - 1, h - 1));
        for cy in lo.1..=hi.1 {
            for cx in lo.0..=hi.0 {
                self.clean_chunks.insert((cx, cy));
            }
        }
    }

    /// Whether a cleanup chunk (in chunk units) has been fully cleared.
    pub fn is_chunk_clean(&self, cx: i32, cy: i32) -> bool {
        self.clean_chunks.contains(&(cx, cy))
    }

    /// Side length (cells) of a cleanup chunk.
    pub fn clean_chunk_size(&self) -> i32 {
        CLEAN_CHUNK
    }

    /// Chunks that finished since the last call, as `(cx, cy)` pairs in chunk units.
    pub fn take_clean_log(&mut self) -> Vec<i32> {
        std::mem::take(&mut self.clean_log)
    }

    /// Whether a (safe) cell hides a power-up. Deterministic from the seed.
    pub fn is_powerup(&self, x: i32, y: i32) -> bool {
        if !self.is_playable(x, y) || self.is_mine(x, y) {
            return false;
        }
        let threshold = (powerup_rate(self.density_at(x, y)) * u32::MAX as f64) as u32;
        hash(self.seed ^ 0xa5a5_1234, x, y) < threshold
    }

    /// Whether a (safe) cell hides an ice clearer. Random, fixed rate, deterministic from the seed.
    pub fn is_iceclearer(&self, x: i32, y: i32) -> bool {
        if !self.is_playable(x, y) || self.is_mine(x, y) {
            return false;
        }
        let threshold = (ICE_CLEARER_RATE * u32::MAX as f64) as u32;
        hash(self.seed ^ 0x1cec_1ea5, x, y) < threshold
    }

    pub fn iceclearers_found(&self) -> u32 {
        self.ice_found
    }

    pub fn iceclearers_available(&self) -> u32 {
        self.ice_found.saturating_sub(self.ice_used)
    }

    /// Spends an ice clearer on a water cell near explored ground: the whole stretch of water it
    /// belongs to becomes see-through, mines faintly visible. Returns 0 = none available,
    /// 1 = done, 2 = not allowed there (not water, or too far; nothing is spent), 3 = already clear.
    pub fn use_ice_clearer(&mut self, x: i32, y: i32) -> u32 {
        if self.iceclearers_available() == 0 {
            return 0;
        }
        if self.game_over
            || self.won
            || !self.is_playable(x, y)
            || !self.is_water(x, y)
            || !(self.revealed.contains(&(x, y)) || self.can_reveal(x, y))
        {
            return 2;
        }
        if self.ice_cells.contains(&(x, y)) {
            return 3;
        }
        self.ice_used += 1;
        self.ice_seeds.push((x, y));
        self.flood_ice((x, y));
        1
    }

    /// Power-ups collected so far (including spent ones).
    pub fn powerups_found(&self) -> u32 {
        self.powerups_found
    }

    /// Power-ups ready to use.
    pub fn powerups_available(&self) -> u32 {
        self.powerups_found.saturating_sub(self.powerups_used)
    }

    /// Spends a power-up to learn the truth about one hidden cell: a safe cell is
    /// revealed, a mine is flagged. Returns 0 = none available, 1 = revealed a safe
    /// cell, 2 = marked a mine, 3 = not allowed there (nothing is spent).
    /// The frontier rule applies, so it can't be used to skip far ahead.
    pub fn use_oracle(&mut self, x: i32, y: i32) -> u32 {
        if self.powerups_available() == 0 {
            return 0;
        }
        if self.game_over
            || self.won
            || !self.is_playable(x, y)
            || self.revealed.contains(&(x, y))
            || self.is_settled(x, y)
            || !self.can_reveal(x, y)
        {
            return 3;
        }
        if self.is_mine(x, y) {
            if self.flagged.contains(&(x, y)) {
                return 3;
            }
            self.flagged.insert((x, y));
            self.powerups_used += 1;
            2
        } else {
            self.flagged.remove(&(x, y));
            self.powerups_used += 1;
            self.reveal_unchecked(x, y);
            1
        }
    }

    /// Number of cells revealed so far.
    pub fn score(&self) -> u32 {
        self.revealed.len() as u32
    }

    pub fn flag_count(&self) -> u32 {
        self.flagged.len() as u32
    }

    /// Mine probability at a cell (grows with distance from the origin).
    pub fn density_at(&self, x: i32, y: i32) -> f32 {
        if self.ramp_len <= 0.0 {
            return self.base_density;
        }
        let d = ((x as f32).powi(2) + (y as f32).powi(2)).sqrt();
        self.base_density + (self.max_density - self.base_density) * (1.0 - (-d / self.ramp_len).exp())
    }

    pub fn is_mine(&self, x: i32, y: i32) -> bool {
        if !self.is_playable(x, y) {
            return false;
        }
        if let Some((ox, oy)) = self.safe_origin {
            if (x - ox).abs() <= 1 && (y - oy).abs() <= 1 {
                return false;
            }
        }
        if let Goal::Reach(gx, gy) = self.goal {
            if (x - gx).abs() <= 1 && (y - gy).abs() <= 1 {
                return false;
            }
        }
        let threshold = (self.density_at(x, y) as f64 * u32::MAX as f64) as u32;
        hash(self.seed, x, y) < threshold
    }

    fn chunk(&self, cx: i32, cy: i32) -> Rc<Vec<u8>> {
        let mut cache = self.chunks.borrow_mut();
        if cache.len() >= MAX_CACHED_CHUNKS {
            cache.clear();
        }
        cache
            .entry((cx, cy))
            .or_insert_with(|| Rc::new(self.terrain.chunk(cx, cy, self.island.as_ref())))
            .clone()
    }

    pub fn adjacent(&self, x: i32, y: i32) -> u8 {
        let mut n = 0;
        for dy in -1..=1 {
            for dx in -1..=1 {
                if (dx != 0 || dy != 0) && self.is_mine(x + dx, y + dy) {
                    n += 1;
                }
            }
        }
        n
    }

    /// Reveals a cell (flood-filling empty regions). Returns cells newly revealed.
    pub fn reveal(&mut self, x: i32, y: i32) -> u32 {
        if !self.can_reveal(x, y) {
            return 0;
        }
        self.reveal_unchecked(x, y)
    }

    /// `reveal` without the frontier rule (chording, and tests).
    fn reveal_unchecked(&mut self, x: i32, y: i32) -> u32 {
        // Tidied-up ground is inert: a mine hidden there can no longer be tapped.
        if self.is_settled(x, y) {
            return 0;
        }
        if self.game_over
            || self.won
            || !self.is_playable(x, y)
            || self.flagged.contains(&(x, y))
            || self.revealed.contains(&(x, y))
            || self.exploded.contains(&(x, y))
        {
            return 0;
        }
        if self.safe_origin.is_none() {
            self.safe_origin = Some((x, y));
            self.recount_mines();
        }
        if self.is_mine(x, y) {
            self.exploded.insert((x, y));
            // hearts off (0) means the first mine ends the game; with hearts, losing the last one does
            if self.exploded.len() as u32 >= self.hearts_max.max(1) {
                self.game_over = true;
            }
            return 0;
        }
        let mut queue = VecDeque::from([(x, y, 0i32)]);
        let mut count = 0u32;
        while let Some((cx, cy, depth)) = queue.pop_front() {
            if !self.is_playable(cx, cy)
                || self.revealed.contains(&(cx, cy))
                || self.flagged.contains(&(cx, cy))
                || self.is_mine(cx, cy)
            {
                continue;
            }
            self.revealed.insert((cx, cy));
            count += 1;
            let d = dist_from_origin(cx, cy);
            self.points += cell_points(d);
            self.farthest = self.farthest.max(d);
            self.note_revealed(cx, cy);
            if self.reveal_log.len() < MAX_LOG * 3 {
                self.reveal_log.extend([cx, cy, depth]);
            }
            if self.adjacent(cx, cy) == 0 && self.revealed.len() < MAX_FLOOD {
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        queue.push_back((cx + dx, cy + dy, depth + 1));
                    }
                }
            }
        }
        if self.island.is_some() && self.revealed.len() as u32 >= self.safe_total() {
            self.won = true;
            self.tidy_whole_island();
        }
        let reached = match self.goal {
            Goal::Chunk(cx, cy) => self.clean_chunks.contains(&(cx, cy)),
            Goal::Reach(x, y) => self.revealed.contains(&(x, y)),
            Goal::None => false,
        };
        if reached {
            self.won = true;
        }
        count
    }

    /// Cells revealed since the last call, as `(x, y, depth)` triples where
    /// `depth` is the flood-fill distance from the clicked cell (for animation).
    pub fn take_reveal_log(&mut self) -> Vec<i32> {
        std::mem::take(&mut self.reveal_log)
    }

    /// Toggles a flag on a hidden cell. Returns true if the cell is now flagged.
    pub fn toggle_flag(&mut self, x: i32, y: i32) -> bool {
        if self.game_over
            || self.won
            || !self.is_playable(x, y)
            || self.revealed.contains(&(x, y))
            || self.exploded.contains(&(x, y))
            || self.is_settled(x, y)
        {
            return false;
        }
        if !self.flagged.remove(&(x, y)) {
            self.flagged.insert((x, y));
            return true;
        }
        false
    }

    /// Chording: on a revealed number whose flags match its count, reveal the
    /// remaining neighbours. Returns cells newly revealed.
    pub fn chord(&mut self, x: i32, y: i32) -> u32 {
        if self.game_over || self.won || !self.revealed.contains(&(x, y)) || self.is_settled(x, y) {
            return 0;
        }
        let n = self.adjacent(x, y);
        if n == 0 {
            return 0;
        }
        let mut flags = 0;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let p = (x + dx, y + dy);
                // Mines hidden inside tidied-up ground count as marked.
                if self.flagged.contains(&p)
                    || self.exploded.contains(&p)
                    || (self.is_settled(p.0, p.1) && self.is_mine(p.0, p.1)) {
                    flags += 1;
                }
            }
        }
        if flags != n {
            return 0;
        }
        let mut total = 0;
        for dy in -1..=1 {
            for dx in -1..=1 {
                if dx != 0 || dy != 0 {
                    total += self.reveal_unchecked(x + dx, y + dy);
                }
            }
        }
        total
    }

    /// Cell data for a `w` x `h` window with top-left `(x0, y0)`, row-major,
    /// three bytes per cell: `[state | adjacent_count, biome, shade]`.
    pub fn view(&self, x0: i32, y0: i32, w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((w * h * 3) as usize);
        let mut last_key = (i32::MIN, i32::MIN);
        let mut chunk: Rc<Vec<u8>> = Rc::new(Vec::new());
        let mut last_clean = (i32::MIN, i32::MIN, false);
        for y in y0..y0 + h as i32 {
            for x in x0..x0 + w as i32 {
                let p = (x, y);
                let ck = clean_key(x, y);
                if (ck.0, ck.1) != (last_clean.0, last_clean.1) {
                    last_clean = (ck.0, ck.1, self.clean_chunks.contains(&ck));
                }
                // On a loss everything is shown, including mines in tidied-up areas.
                let settled = !self.game_over && last_clean.2 && self.is_settled(x, y);
                let key = (x.div_euclid(CH), y.div_euclid(CH));
                if key != last_key {
                    chunk = self.chunk(key.0, key.1);
                    last_key = key;
                }
                let i = ((y.rem_euclid(CH) * CH + x.rem_euclid(CH)) * 2) as usize;
                let biome = chunk[i];
                let state = if self.exploded.contains(&p) {
                    ST_MINE | 1
                } else if settled {
                    ST_CLEAN | ST_REVEALED
                } else if self.revealed.contains(&p) {
                    ST_REVEALED
                        | self.display_count(x, y)
                        | if (self.is_powerup(x, y) || self.is_iceclearer(x, y)) && !self.collected.contains(&p) { ST_POWERUP } else { 0 }
                } else if self.game_over && self.is_mine(x, y) {
                    ST_MINE
                } else if self.flagged.contains(&p) {
                    ST_FLAG | self.ice_bits(x, y, biome)
                } else if self.island.is_some() && !self.is_playable(x, y) {
                    // sea beside a finished shoreline chunk shows its water
                    if last_clean.2 {
                        ST_SEA
                    } else {
                        ST_VOID
                    }
                } else {
                    ST_HIDDEN | self.ice_bits(x, y, biome)
                };
                // The palette only looks at the top 5 bits of the shade, so bit 0 is free to say
                // "this revealed cell held an ice clearer" (an oracle is the plain star).
                let mut shade = chunk[i + 1] & 0xf8;
                if state & 0x30 == ST_REVEALED && state & ST_CLEAN == 0 && self.is_iceclearer(x, y) {
                    shade |= 1;
                }
                out.push(state);
                out.push(biome);
                out.push(shade);
            }
        }
        out
    }
}

impl solver::Board for World {
    fn cell(&self, x: i32, y: i32) -> solver::Cell {
        if !self.is_playable(x, y) {
            solver::Cell::Void
        } else if self.revealed.contains(&(x, y)) {
            solver::Cell::Num(self.adjacent(x, y))
        } else {
            solver::Cell::Hidden
        }
    }
}

impl World {
    /// Every revealed cell (not exported to JS).
    pub fn revealed_cells(&self) -> Vec<(i32, i32)> {
        self.revealed.iter().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mines_are_deterministic() {
        let a = World::new(42, 0.2, 0.2, 0.0);
        let b = World::new(42, 0.2, 0.2, 0.0);
        for x in -50..50 {
            for y in -50..50 {
                assert_eq!(a.is_mine(x, y), b.is_mine(x, y));
            }
        }
    }

    #[test]
    fn density_is_roughly_respected() {
        let w = World::new(7, 0.2, 0.2, 0.0);
        let mut mines = 0;
        for x in -100..100 {
            for y in -100..100 {
                mines += w.is_mine(x, y) as u32;
            }
        }
        let ratio = mines as f32 / 40_000.0;
        assert!((0.17..0.23).contains(&ratio), "ratio was {ratio}");
    }

    #[test]
    fn first_click_is_safe_for_any_seed() {
        for seed in 0..200 {
            let mut w = World::new(seed, 0.3, 0.3, 0.0);
            w.reveal(-3, 5);
            assert!(!w.is_game_over(), "seed {seed}");
            assert!(w.score() >= 1);
        }
    }

    #[test]
    fn works_with_negative_and_huge_coordinates() {
        let mut w = World::new(1, 0.15, 0.3, 200.0);
        w.reveal(-5, 7);
        w.reveal_unchecked(-2_000_000, 2_000_000);
        assert!(!w.is_game_over());
        let v = w.view(-2_000_005, 1_999_995, 10, 10);
        assert_eq!(v.len(), 300);
    }

    #[test]
    fn flood_fill_terminates_on_empty_world() {
        let mut w = World::new(1, 0.0, 0.0, 0.0);
        let n = w.reveal(0, 0);
        assert!(n as usize >= MAX_FLOOD && (n as usize) < MAX_FLOOD + 10_000);
    }

    #[test]
    fn hitting_a_mine_ends_the_game() {
        let mut w = World::new(3, 0.5, 0.5, 0.0);
        w.reveal(0, 0);
        let mine = (-20..20)
            .flat_map(|x| (-20..20).map(move |y| (x, y)))
            .find(|&(x, y)| w.is_mine(x, y))
            .unwrap();
        w.reveal_unchecked(mine.0, mine.1);
        assert!(w.is_game_over());
        let v = w.view(mine.0, mine.1, 1, 1);
        assert_eq!(v[0], ST_MINE | 1);
    }

    #[test]
    fn flags_block_reveal_and_toggle() {
        let mut w = World::new(5, 0.1, 0.1, 0.0);
        assert!(w.toggle_flag(4, 4));
        assert_eq!(w.reveal(4, 4), 0);
        assert!(!w.toggle_flag(4, 4));
    }

    #[test]
    fn density_ramps_up_with_distance() {
        let w = World::new(11, 0.15, 0.30, 200.0);
        assert!((w.density_at(0, 0) - 0.15).abs() < 1e-6);
        assert!(w.density_at(300, 0) > w.density_at(50, 0));
        assert!(w.density_at(100_000, 0) <= 0.30 + 1e-6);
        let count = |cx: i32| {
            (0..100)
                .flat_map(|x| (0..100).map(move |y| (x + cx, y)))
                .filter(|&(x, y)| w.is_mine(x, y))
                .count()
        };
        assert!(count(2000) > count(0) + 500, "far region should be denser");
    }

    #[test]
    fn view_matches_single_cell_terrain() {
        let w = World::new(21, 0.15, 0.15, 0.0);
        let t = Terrain::new(21);
        let v = w.view(-40, -33, 70, 70);
        for (i, (x, y)) in (-33..37).flat_map(|y| (-40..30).map(move |x| (x, y))).enumerate() {
            let (b, sh) = t.cell(x, y);
            assert_eq!((v[i * 3 + 1], v[i * 3 + 2]), (b, sh & 0xf8), "at {x},{y}");
        }
    }

    #[test]
    fn water_is_unplayable_and_mine_free() {
        let w = World::new_island(8, 128, 0.15, 0.25, 2);
        assert!(w.is_island());
        assert!(!w.is_playable(-1000, 0));
        assert!(!w.is_mine(-1000, 0));
        let mut w = w;
        assert_eq!(w.reveal(-1000, 0), 0);
        assert!(!w.toggle_flag(-1000, 0));
        assert_eq!(w.view(-1000, 0, 1, 1)[0], ST_VOID);
    }

    #[test]
    fn mines_only_on_land_and_totals_add_up() {
        let w = World::new_island(2, 128, 0.2, 0.2, 2);
        assert!(w.land_total() > 2000);
        assert!(w.mines_total() > 0 && w.mines_total() < w.land_total());
        assert_eq!(w.safe_total(), w.land_total() - w.mines_total());
    }

    #[test]
    fn clearing_every_safe_cell_wins_the_island() {
        let mut w = World::new_island(3, 96, 0.12, 0.2, 2);
        w.reveal(0, 0);
        assert!(!w.is_game_over());
        for y in -48..48 {
            for x in -48..48 {
                if w.is_playable(x, y) && !w.is_mine(x, y) {
                    w.reveal_unchecked(x, y);
                }
            }
        }
        assert!(w.is_won(), "revealed {} of {}", w.score(), w.safe_total());
        assert_eq!(w.score(), w.safe_total());
        assert!(!w.is_game_over());
    }

    #[test]
    fn first_click_on_the_island_is_safe_for_many_seeds() {
        for seed in 0..30 {
            let mut w = World::new_island(seed, 96, 0.25, 0.3, 2);
            let c = (-48..48)
                .flat_map(|y| (-48..48).map(move |x| (x, y)))
                .find(|&(x, y)| w.is_playable(x, y))
                .unwrap();
            w.reveal(c.0, c.1);
            assert!(!w.is_game_over(), "seed {seed}");
        }
    }

    #[test]
    fn mines_get_denser_towards_the_coast() {
        let w = World::new_island(4, 192, 0.12, 0.30, 2);
        assert!(w.density_at(80, 0) > w.density_at(5, 0) + 0.05);
    }

    #[test]
    fn state_round_trips() {
        for island in [false, true] {
            let make = || {
                if island {
                    World::new_island(6, 96, 0.15, 0.25, 2)
                } else {
                    World::new(6, 0.15, 0.25, 300.0)
                }
            };
            let mut a = make();
            a.reveal(0, 0);
            a.toggle_flag(3, 3);
            a.reveal(2, 1);
            let data = a.export_state();
            let mut b = make();
            assert!(b.import_state(&data));
            assert_eq!(a.score(), b.score());
            assert_eq!(a.flag_count(), b.flag_count());
            assert_eq!(a.mines_total(), b.mines_total());
            assert_eq!(a.view(-20, -20, 40, 40), b.view(-20, -20, 40, 40));
            assert_eq!(data, b.export_state());
        }
    }

    #[test]
    fn lost_and_won_states_survive_a_round_trip() {
        let mut w = World::new(3, 0.5, 0.5, 0.0);
        w.reveal(0, 0);
        let mine = (-20..20)
            .flat_map(|x| (-20..20).map(move |y| (x, y)))
            .find(|&(x, y)| w.is_mine(x, y))
            .unwrap();
        w.reveal_unchecked(mine.0, mine.1);
        let mut b = World::new(3, 0.5, 0.5, 0.0);
        assert!(b.import_state(&w.export_state()));
        assert!(b.is_game_over());
    }

    #[test]
    fn invalid_state_is_rejected_and_harmless() {
        let mut w = World::new(1, 0.15, 0.15, 0.0);
        assert!(!w.import_state(&[]));
        assert!(!w.import_state(&[99, 0, 0, 0, 0, 0, 0]));
        assert!(!w.import_state(&[1, 0, 0, 0, 5, 1, 2]));
        assert!(!w.import_state(&[1, 0, 0, 0, -1]));
        assert!(!w.import_state(&[1, 0, 0, 0, 0, 0, 0, 7]));
        assert!(w.import_state(&[1, 0, 0, 0, 0, 0, 0]));
        assert_eq!(w.score(), 0);
    }

    #[test]
    fn reveal_log_records_order_and_depth() {
        let mut w = World::new(1, 0.0, 0.0, 0.0);
        let n = w.reveal(0, 0);
        let log = w.take_reveal_log();
        assert_eq!(log.len() as u32, n.min(MAX_LOG as u32) * 3);
        assert_eq!(&log[..3], &[0, 0, 0]);
        // depths never decrease (breadth-first)
        let depths: Vec<i32> = log.chunks(3).map(|c| c[2]).collect();
        assert!(depths.windows(2).all(|p| p[0] <= p[1]));
        assert!(w.take_reveal_log().is_empty());
    }

    #[test]
    fn endless_first_click_must_be_near_the_start() {
        let mut w = World::new(9, 0.15, 0.15, 0.0);
        assert!(!w.can_reveal(50, 0));
        assert_eq!(w.reveal(50, 0), 0);
        assert_eq!(w.score(), 0);
        assert!(!w.is_game_over());
        assert!(w.can_reveal(8, -8));
        assert!(w.reveal(8, -8) > 0);
    }

    #[test]
    fn island_first_click_can_be_anywhere_on_land() {
        let w = World::new_island(2, 128, 0.15, 0.25, 2);
        let land = (-64..64)
            .flat_map(|y| (-64..64).map(move |x| (x, y)))
            .find(|&(x, y)| w.is_playable(x, y) && x.abs() > 30)
            .unwrap();
        assert!(w.can_reveal(land.0, land.1));
    }

    #[test]
    fn reach_is_three_cells_from_explored_ground() {
        let mut w = World::new(4, 0.15, 0.15, 0.0);
        // Only the origin is revealed.
        assert!(w.import_state(&[1, 1, 0, 0, 1, 0, 0, 0, 0]));
        for (x, y, ok) in [(3, 0, true), (0, -3, true), (3, 3, true), (4, 0, false), (4, 4, false), (-4, 2, false)] {
            assert_eq!(w.can_reveal(x, y), ok, "({x}, {y})");
        }
        assert!(w.is_out_of_reach(10, 10));
        assert!(!w.is_out_of_reach(2, 2));
        assert_eq!(w.reveal(10, 10), 0);
        assert_eq!(w.score(), 1);
        // A cell that is already revealed is never "out of reach".
        assert!(!w.is_out_of_reach(0, 0));
    }

    #[test]
    fn points_grow_with_distance_and_farthest_is_tracked() {
        let mut w = World::new(5, 0.15, 0.15, 0.0);
        // Revealed: (0,0) worth 1.0 and (30,40) at distance 50 worth 1.5.
        assert!(w.import_state(&[1, 1, 0, 0, 2, 0, 0, 30, 40, 0, 0]));
        assert_eq!(w.points(), 2);
        assert_eq!(w.farthest(), 50);
        // Live updates match a rebuild from saved state.
        let mut live = World::new(5, 0.15, 0.15, 0.0);
        live.reveal(0, 0);
        let mut rebuilt = World::new(5, 0.15, 0.15, 0.0);
        assert!(rebuilt.import_state(&live.export_state()));
        assert_eq!(live.points(), rebuilt.points());
        assert_eq!(live.farthest(), rebuilt.farthest());
        assert!(live.points() >= live.score());
    }

    #[test]
    fn solver_is_sound_on_real_worlds() {
        // Everything the solver calls safe must be safe, and every mine a mine,
        // across many seeds and densities, played out until it gets stuck.
        for (seed, density) in (0..40u32).zip([0.12f32, 0.16, 0.20, 0.24].iter().cycle()) {
            let mut w = World::new(seed, *density, *density, 0.0);
            w.reveal(0, 0);
            for _ in 0..60 {
                if w.score() > 2500 {
                    break;
                }
                let a = solver::analyze(&w, &w.revealed_cells());
                for &(x, y) in &a.safe {
                    assert!(!w.is_mine(x, y), "seed {seed}: solver said ({x},{y}) is safe");
                }
                for &(x, y) in &a.mines {
                    assert!(w.is_mine(x, y), "seed {seed}: solver said ({x},{y}) is a mine");
                }
                if a.safe.is_empty() {
                    break;
                }
                for (x, y) in a.safe {
                    w.reveal(x, y);
                }
                assert!(!w.is_game_over(), "seed {seed}: solver walked into a mine");
            }
        }
    }

    #[test]
    fn powerup_rate_is_monotonic_and_bounded() {
        let mut last = 0.0;
        for i in 0..=100 {
            let r = powerup_rate(i as f32 / 100.0);
            assert!(r >= last - 1e-12 && (0.0012..=0.25).contains(&r), "d={} r={r}", i);
            last = r;
        }
    }

    #[test]
    fn powerups_follow_density_and_never_hide_under_mines() {
        let count = |density: f32, side: i32| {
            let w = World::new(77, density, density, 0.0);
            let mut n = 0;
            for x in 0..side {
                for y in 0..side {
                    if w.is_powerup(x + 20, y + 20) {
                        assert!(!w.is_mine(x + 20, y + 20));
                        n += 1;
                    }
                }
            }
            n
        };
        let hard = count(0.28, 120); // ~3% of ~10k safe cells
        assert!((200..460).contains(&hard), "hard: {hard}");
        let calm = count(0.15, 200); // ~0.12% of ~34k safe cells
        assert!((15..90).contains(&calm), "calm: {calm}");
        assert!(hard as f64 / 120.0f64.powi(2) > calm as f64 / 200.0f64.powi(2) * 10.0);
    }

    #[test]
    fn power_ups_are_picked_up_by_tapping_them() {
        let mut w = World::new(31, 0.30, 0.30, 0.0);
        let p = (-30..30)
            .flat_map(|y| (-30..30).map(move |x| (x, y)))
            .find(|&(x, y)| w.is_powerup(x, y))
            .expect("a power-up at 30% density");
        w.reveal_unchecked(p.0, p.1);
        assert_eq!(w.powerups_found(), 0, "revealing alone does not collect");
        assert_eq!(w.collect(p.0 + 100, p.1), 0, "nothing under an unrevealed cell");
        assert_eq!(w.collect(p.0, p.1) & 1, 1);
        assert_eq!(w.powerups_found(), 1);
        assert_eq!(w.collect(p.0, p.1), 0, "only once");
        assert_eq!(w.powerups_available(), 1);
        let saved = w.export_state();
        let mut b = World::new(31, 0.30, 0.30, 0.0);
        assert!(b.import_state(&saved));
        assert_eq!(b.powerups_found(), 1);
        assert_eq!(b.collect(p.0, p.1), 0, "still picked up after a reload");
    }

    #[test]
    fn oracle_flags_mines_reveals_safe_cells_and_is_spent() {
        let mut w = World::new(31, 0.30, 0.30, 0.0);
        let p = (-30..30)
            .flat_map(|y| (-30..30).map(move |x| (x, y)))
            .find(|&(x, y)| w.is_powerup(x, y))
            .expect("a power-up at 30% density");
        // Only the power-up cell is revealed (and is the first-click origin).
        assert!(w.import_state(&[2, 1, p.0, p.1, 1, p.0, p.1, 0, 0, 0]));
        assert_eq!(w.powerups_found(), 1);
        assert_eq!(w.powerups_available(), 1);
        let near = |w: &World, want_mine: bool| {
            (-3..=3)
                .flat_map(|dy| (-3..=3).map(move |dx| (p.0 + dx, p.1 + dy)))
                .find(|&(x, y)| (x, y) != p && w.is_mine(x, y) == want_mine && !w.revealed.contains(&(x, y)))
                .unwrap()
        };
        // Out of reach: refused, nothing spent.
        assert_eq!(w.use_oracle(p.0 + 40, p.1), 3);
        assert_eq!(w.powerups_available(), 1);
        // A mine gets flagged.
        let mine = near(&w, true);
        assert_eq!(w.use_oracle(mine.0, mine.1), 2);
        assert!(w.flagged.contains(&mine));
        assert_eq!(w.powerups_available(), 0);
        // Nothing left to spend.
        let safe = near(&w, false);
        assert_eq!(w.use_oracle(safe.0, safe.1), 0);
        assert!(!w.is_game_over());
    }

    #[test]
    fn oracle_reveals_a_safe_cell_and_state_keeps_the_spent_count() {
        let mut w = World::new(31, 0.30, 0.30, 0.0);
        let p = (-30..30)
            .flat_map(|y| (-30..30).map(move |x| (x, y)))
            .find(|&(x, y)| w.is_powerup(x, y))
            .unwrap();
        assert!(w.import_state(&[2, 1, p.0, p.1, 1, p.0, p.1, 0, 0, 0]));
        let safe = (-3..=3)
            .flat_map(|dy| (-3..=3).map(move |dx| (p.0 + dx, p.1 + dy)))
            .find(|&(x, y)| (x, y) != p && !w.is_mine(x, y) && !w.revealed.contains(&(x, y)))
            .unwrap();
        assert_eq!(w.use_oracle(safe.0, safe.1), 1);
        assert!(w.revealed.contains(&safe));
        assert_eq!(w.powerups_available(), 0);
        let mut b = World::new(31, 0.30, 0.30, 0.0);
        assert!(b.import_state(&w.export_state()));
        assert_eq!(b.powerups_found(), w.powerups_found());
        assert_eq!(b.powerups_available(), 0);
    }

    #[test]
    fn version_one_saves_still_load() {
        let mut w = World::new(2, 0.15, 0.15, 0.0);
        assert!(w.import_state(&[1, 1, 0, 0, 1, 0, 0, 0, 0]));
        assert_eq!(w.powerups_available(), w.powerups_found());
        // A v2 save must carry the spent counter.
        assert!(!w.import_state(&[2, 1, 0, 0, 1, 0, 0, 0, 0]));
        assert!(w.import_state(&[2, 1, 0, 0, 1, 0, 0, 0, 0, 0]));
    }

    /// Reveals every safe cell in the given cell rectangle (bypassing the frontier rule).
    fn clear_area(w: &mut World, x0: i32, y0: i32, x1: i32, y1: i32) {
        for y in y0..y1 {
            for x in x0..x1 {
                if w.is_playable(x, y) && !w.is_mine(x, y) {
                    w.reveal_unchecked(x, y);
                }
            }
        }
    }

    #[test]
    fn a_fully_cleared_chunk_is_tidied_away_except_next_to_unfinished_ground() {
        let mut w = World::new(12, 0.2, 0.2, 0.0);
        w.reveal(0, 0);
        // Clear a 3x3 block of cleanup chunks: cells -16..32 on both axes.
        clear_area(&mut w, -16, -16, 32, 32);
        assert!(!w.is_game_over());
        for k in [(0, 0), (-1, -1), (1, 1), (-1, 1)] {
            assert!(w.clean_chunks.contains(&k), "chunk {k:?} should be clean");
        }
        // Centre chunk: every cell (even on its border) has only clean neighbours.
        for (x, y) in [(8, 8), (0, 0), (15, 15), (0, 15)] {
            assert!(w.is_settled(x, y), "({x},{y})");
        }
        // The outer ring touches chunks that are not finished, so its far edge stays as is.
        assert!(!w.is_settled(-16, -16));
        assert!(!w.is_settled(31, 8));
        // A mine inside the tidied area is drawn as plain ground and is inert.
        let mine = (0..16)
            .flat_map(|y| (0..16).map(move |x| (x, y)))
            .find(|&(x, y)| w.is_mine(x, y))
            .expect("a mine in the centre chunk");
        assert_eq!(w.view(mine.0, mine.1, 1, 1)[0], ST_CLEAN | ST_REVEALED);
        assert_eq!(w.reveal(mine.0, mine.1), 0);
        assert!(!w.is_game_over());
        assert!(!w.toggle_flag(mine.0, mine.1));
        // A numbered cell inside shows no number, one on the unfinished rim still does.
        let rim = w.view(-16, -16, 1, 1)[0];
        assert_eq!(rim & ST_CLEAN, 0);
    }

    #[test]
    fn newly_clean_chunks_are_logged_once() {
        let mut w = World::new(12, 0.2, 0.2, 0.0);
        w.reveal(0, 0);
        clear_area(&mut w, 0, 0, 16, 16);
        let log = w.take_clean_log();
        assert!(log.chunks(2).any(|c| c == [0, 0]), "{log:?}");
        assert!(w.take_clean_log().is_empty());
    }

    #[test]
    fn tidy_state_survives_a_save_and_load() {
        let mut a = World::new(12, 0.2, 0.2, 0.0);
        a.reveal(0, 0);
        clear_area(&mut a, -16, -16, 32, 32);
        let mut b = World::new(12, 0.2, 0.2, 0.0);
        assert!(b.import_state(&a.export_state()));
        assert_eq!(a.view(-20, -20, 56, 56), b.view(-20, -20, 56, 56));
        assert!(b.take_clean_log().is_empty());
    }

    #[test]
    fn a_won_island_is_completely_tidy_and_a_lost_world_shows_everything() {
        let mut w = World::new_island(3, 96, 0.12, 0.2, 2);
        w.reveal(0, 0);
        clear_area(&mut w, -48, -48, 48, 48);
        assert!(w.is_won());
        for y in -48..48 {
            for x in -48..48 {
                if w.is_playable(x, y) {
                    assert!(w.is_settled(x, y), "({x},{y})");
                    assert_eq!(w.view(x, y, 1, 1)[0] & ST_CLEAN, ST_CLEAN);
                }
            }
        }
        // On a loss, tidy-up is suspended so every mine is visible.
        let mut l = World::new(12, 0.2, 0.2, 0.0);
        l.reveal(0, 0);
        clear_area(&mut l, -16, -16, 32, 32);
        let mine = (0..16)
            .flat_map(|y| (0..16).map(move |x| (x, y)))
            .find(|&(x, y)| l.is_mine(x, y))
            .unwrap();
        l.exploded.insert((40, 40));
        l.game_over = true;
        assert_eq!(l.view(mine.0, mine.1, 1, 1)[0] & ST_CLEAN, 0);
        assert_eq!(l.view(mine.0, mine.1, 1, 1)[0] & 0x30, ST_MINE);
    }

    #[test]
    fn chording_counts_mines_hidden_in_tidied_ground() {
        let mut w = World::new(12, 0.2, 0.2, 0.0);
        w.reveal(0, 0);
        clear_area(&mut w, -16, -16, 32, 32);
        // A tidied mine counts as marked even though the player never flagged it.
        let mine = (0..16)
            .flat_map(|y| (0..16).map(move |x| (x, y)))
            .find(|&(x, y)| w.is_mine(x, y) && w.is_settled(x, y))
            .unwrap();
        assert!(!w.flagged.contains(&mine));
        // Chording on an adjacent revealed number must not blow up or panic.
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            w.chord(mine.0 + dx, mine.1 + dy);
        }
        assert!(!w.is_game_over());
    }

    #[test]
    fn numbers_next_to_tidied_ground_ignore_the_hidden_mines() {
        let mut w = World::new(12, 0.2, 0.2, 0.0);
        w.reveal(0, 0);
        clear_area(&mut w, -16, -16, 32, 32);
        let (mut checked, mut reduced) = (0, 0);
        for y in -16..32 {
            for x in -16..32 {
                if !w.revealed.contains(&(x, y)) || w.is_settled(x, y) {
                    continue;
                }
                let hidden = (-1..=1)
                    .flat_map(|dy| (-1..=1).map(move |dx| (dx, dy)))
                    .filter(|&(dx, dy)| (dx, dy) != (0, 0) && w.is_settled(x + dx, y + dy) && w.is_mine(x + dx, y + dy))
                    .count() as u8;
                let shown = w.view(x, y, 1, 1)[0] & 0x0f;
                assert_eq!(shown, w.adjacent(x, y) - hidden, "({x},{y})");
                checked += 1;
                reduced += (hidden > 0) as u32;
            }
        }
        assert!(checked > 50 && reduced > 5, "checked {checked}, reduced {reduced}");
        // After a loss the real numbers come back.
        w.exploded.insert((40, 40));
        w.game_over = true;
        for y in -16..32 {
            for x in -16..32 {
                if w.revealed.contains(&(x, y)) {
                    assert_eq!(w.view(x, y, 1, 1)[0] & 0x0f, w.adjacent(x, y));
                }
            }
        }
    }

    #[test]
    fn a_won_island_with_lakes_counts_lake_cells_as_cells_to_clear() {
        let w = World::new_island(5, 192, 0.12, 0.2, 2);
        // Safe cells to clear include any lake cells (they are playable).
        assert_eq!(w.safe_total(), w.land_total() - w.mines_total());
    }

    #[test]
    fn island_snapshot_describes_every_cell() {
        let w = World::new_island(9, 96, 0.15, 0.28, 2);
        let snap = w.island_snapshot();
        assert_eq!(snap.len(), 96 * 96 * 2);
        let sea = (SEA * 255.0) as u8;
        let mut land = 0;
        for y in -48..48i32 {
            for x in -48..48i32 {
                let i = (((y + 48) * 96 + (x + 48)) * 2) as usize;
                let (biome, height) = (snap[i], snap[i + 1]);
                if w.is_playable(x, y) && biome > B_OCEAN {
                    land += 1;
                    assert!(height >= sea, "land below sea level at ({x},{y})");
                }
                if biome <= B_OCEAN {
                    assert!(height <= sea + 1, "water above sea level at ({x},{y})");
                }
            }
        }
        assert!(land > 1000);
        // Endless worlds have no island to show.
        assert!(World::new(1, 0.15, 0.15, 0.0).island_snapshot().is_empty());
    }

    #[test]
    fn ice_clearer_makes_a_whole_water_body_see_through() {
        let seed = (0..400u32)
            .find(|&sd| {
                let w = World::new(sd, 0.15, 0.15, 0.0);
                w.is_water(0, 0) && w.is_water(3, 3)
            })
            .expect("a seed that starts in water");
        let mut w = World::new(seed, 0.15, 0.15, 0.0);
        w.reveal(0, 0);
        // The opening flood may by chance have uncovered a clearer; this test hands them out itself.
        w.ice_found = 0;
        let icy = |w: &World| {
            w.view(-30, -30, 60, 60)
                .chunks(3)
                .enumerate()
                .filter(|(_, c)| c[0] & 0x30 != 0x20 && c[0] & ST_ICE != 0)
                .count()
        };
        // Revealing water does not melt any ice by itself, and without a clearer nothing happens.
        assert_eq!(icy(&w), 0);
        assert_eq!(w.use_ice_clearer(0, 0), 0);

        w.ice_found = 2;
        // Too far from explored ground: refused, and nothing is spent.
        assert_eq!(w.use_ice_clearer(900, 900), 2);
        assert_eq!(w.iceclearers_available(), 2);

        assert_eq!(w.use_ice_clearer(0, 0), 1);
        assert_eq!(w.iceclearers_available(), 1);
        assert_eq!(w.use_ice_clearer(0, 0), 3, "already clear");
        assert_eq!(w.iceclearers_available(), 1);

        let v = w.view(-30, -30, 60, 60);
        let mut ice = 0;
        for (i, c) in v.chunks(3).enumerate() {
            let (x, y) = (-30 + (i % 60) as i32, -30 + (i / 60) as i32);
            let hidden = c[0] & 0x30 == 0 || c[0] & 0x30 == ST_FLAG;
            if hidden && c[0] & ST_ICE != 0 {
                ice += 1;
                assert!(c[1] <= B_OCEAN, "ice on land at ({x},{y})");
                assert_eq!(c[0] & ST_ICE_MINE != 0, w.is_mine(x, y), "mine hint wrong at ({x},{y})");
            } else if hidden {
                assert_eq!(c[0] & ST_ICE_MINE, 0);
            }
        }
        assert!(ice > 20, "expected a see-through stretch of water, got {ice} cells");

        // It survives a save and a load.
        let mut b = World::new(seed, 0.15, 0.15, 0.0);
        assert!(b.import_state(&w.export_state()));
        assert_eq!(w.view(-30, -30, 60, 60), b.view(-30, -30, 60, 60));
        assert_eq!(b.ice_used, 1);
    }

    #[test]
    fn ice_clearers_are_rare_random_and_never_under_mines() {
        let w = World::new(21, 0.15, 0.15, 0.0);
        let mut n = 0;
        for x in 0..300 {
            for y in 0..300 {
                if w.is_iceclearer(x, y) {
                    assert!(!w.is_mine(x, y));
                    n += 1;
                }
            }
        }
        // 90,000 cells, about 85% safe, at 0.03%: around 23
        assert!((8..60).contains(&n), "found {n}");
    }

    #[test]
    fn older_saves_without_ice_data_still_load() {
        let mut w = World::new(2, 0.15, 0.15, 0.0);
        assert!(w.import_state(&[2, 1, 0, 0, 1, 0, 0, 0, 0, 0]));
        assert_eq!(w.ice_used, 0);
        assert!(!w.import_state(&[3, 1, 0, 0, 1, 0, 0, 0, 0, 0]), "v3 needs the ice counters");
        assert!(w.import_state(&[3, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn sea_inside_a_cleared_coastal_chunk_shows_its_water() {
        let mut w = World::new_island(9, 192, 0.12, 0.2, 2);
        let h = 96;
        // A chunk with both island and open sea in it.
        let (cx, cy) = (-h / CLEAN_CHUNK..h / CLEAN_CHUNK)
            .flat_map(|cy| (-h / CLEAN_CHUNK..h / CLEAN_CHUNK).map(move |cx| (cx, cy)))
            .find(|&(cx, cy)| {
                let cells: Vec<bool> = (0..CLEAN_CHUNK * CLEAN_CHUNK)
                    .map(|i| w.is_playable(cx * CLEAN_CHUNK + i % CLEAN_CHUNK, cy * CLEAN_CHUNK + i / CLEAN_CHUNK))
                    .collect();
                let land = cells.iter().filter(|&&p| p).count();
                (60..200).contains(&land)
            })
            .expect("a coastal chunk");
        let (x0, y0) = (cx * CLEAN_CHUNK, cy * CLEAN_CHUNK);
        let first = (0..CLEAN_CHUNK * CLEAN_CHUNK)
            .map(|i| (x0 + i % CLEAN_CHUNK, y0 + i / CLEAN_CHUNK))
            .find(|&(x, y)| w.is_playable(x, y) && !w.is_mine(x, y))
            .unwrap();
        w.reveal(first.0, first.1);
        // Before the chunk is finished, its sea is just unexplored paper.
        let sea_cells: Vec<(i32, i32)> = (0..CLEAN_CHUNK * CLEAN_CHUNK)
            .map(|i| (x0 + i % CLEAN_CHUNK, y0 + i / CLEAN_CHUNK))
            .filter(|&(x, y)| !w.is_playable(x, y))
            .collect();
        assert!(!sea_cells.is_empty());
        assert!(sea_cells.iter().all(|&(x, y)| w.view(x, y, 1, 1)[0] == ST_VOID));
        clear_area(&mut w, x0, y0, x0 + CLEAN_CHUNK, y0 + CLEAN_CHUNK);
        assert!(w.is_chunk_clean(cx, cy), "chunk should be finished");
        assert!(sea_cells.iter().all(|&(x, y)| w.view(x, y, 1, 1)[0] == ST_SEA));
        // Sea in a chunk that was not touched stays unexplored.
        assert_eq!(w.view(-1000, 0, 1, 1)[0], ST_VOID);
    }

    #[test]
    fn losing_every_heart_ends_the_game() {
        let mut w = World::new_island(5, 96, 0.2, 0.3, 2);
        w.set_hearts(2);
        w.reveal(0, 0);
        let mines: Vec<(i32, i32)> = (-48..48)
            .flat_map(|y| (-48..48).map(move |x| (x, y)))
            .filter(|&(x, y)| w.is_mine(x, y) && !w.is_settled(x, y))
            .take(3)
            .collect();
        assert_eq!(mines.len(), 3);
        w.reveal_unchecked(mines[0].0, mines[0].1);
        assert!(!w.is_game_over());
        assert_eq!(w.mistakes(), 1);
        w.reveal_unchecked(mines[0].0, mines[0].1);
        assert_eq!(w.mistakes(), 1, "tapping the same mine twice costs nothing");
        w.reveal_unchecked(mines[1].0, mines[1].1);
        assert!(w.is_game_over(), "losing the last heart ends the game");
    }

    #[test]
    fn first_tap_is_limited_to_the_start_area() {
        let mut w = World::new(3, 0.15, 0.2, 0.0);
        w.set_first_area(100, 100, 110, 110);
        assert!(!w.can_reveal(0, 0));
        assert!(w.can_reveal(105, 105));
        assert_eq!(w.reveal(0, 0), 0);
        assert!(w.reveal(105, 105) > 0);
    }

    #[test]
    fn reaching_the_goal_cell_wins_and_keeps_it_safe() {
        let mut w = World::new(3, 0.2, 0.2, 0.0);
        w.set_goal_reach(20, -30);
        for dy in -1..=1 {
            for dx in -1..=1 {
                assert!(!w.is_mine(20 + dx, -30 + dy));
            }
        }
        assert_eq!(w.goal_kind(), 2);
        w.reveal_unchecked(20, -30);
        assert!(w.is_won());
    }

    #[test]
    fn clearing_the_goal_chunk_wins() {
        let mut w = World::new(8, 0.12, 0.12, 0.0);
        w.set_goal_chunk(0, 0);
        for y in 0..CLEAN_CHUNK {
            for x in 0..CLEAN_CHUNK {
                if !w.is_mine(x, y) {
                    w.reveal(x, y);
                }
            }
        }
        assert!(w.is_chunk_clean(0, 0));
        assert!(w.is_won());
    }
}
