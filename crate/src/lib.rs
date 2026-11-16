//! Infinite minesweeper world.
//!
//! The world is stateless: whether a cell is a mine, and what the terrain
//! looks like, are pure functions of `(seed, x, y)`. Only what the player has
//! touched (revealed / flagged / exploded cells) is stored.

mod island;
mod noise;
mod terrain;

use island::Island;
use noise::hash;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use terrain::{Terrain, CH};
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

/// Max cells recorded per action in the reveal log (the log only drives animation).
const MAX_LOG: usize = 60_000;

/// Safety valve: a single click never reveals more than this many cells.
const MAX_FLOOD: usize = 100_000;

/// Cell state encoding returned by [`World::view`] (byte 0 of each cell):
/// bits 0-3 = adjacent mine count, bits 4-5 = state.
pub const ST_HIDDEN: u8 = 0x00;
pub const ST_FLAG: u8 = 0x10;
pub const ST_REVEALED: u8 = 0x20;
pub const ST_MINE: u8 = 0x30; // low bit 1 = exploded, 0 = shown after loss
/// Bump when the `export_state` layout changes.
const STATE_VERSION: i32 = 1;

/// Hidden state with low nibble 0xF = not playable (water outside the island).
pub const ST_VOID: u8 = 0x0f;

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
    island: Option<Island>,
    /// Mines on the island (island mode only; recomputed after the first click).
    mines_total: u32,
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
            island: None,
            mines_total: 0,
        }
    }

    /// A bounded island of `size` x `size` cells surrounded by water. Mine
    /// density rises from `density` at the centre to `max_density` at the coast.
    pub fn new_island(seed: u32, size: u32, density: f32, max_density: f32) -> World {
        let terrain = Terrain::new_island(seed, size as i32);
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
    /// the same `[n, (x, y) * n]` block for flagged and then exploded cells.
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
        if data.len() < 4 || data[0] != STATE_VERSION {
            return false;
        }
        let mut pos = 4;
        let (Some(revealed), Some(flagged), Some(exploded)) =
            (read_set(data, &mut pos), read_set(data, &mut pos), read_set(data, &mut pos))
        else {
            return false;
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
        self.reveal_log.clear();
        self.recompute_score();
        self.recount_mines();
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
            && !self.can_reveal(x, y)
    }

    fn recompute_score(&mut self) {
        self.points = 0.0;
        self.farthest = 0.0;
        for &(x, y) in &self.revealed {
            let d = dist_from_origin(x, y);
            self.points += cell_points(d);
            self.farthest = self.farthest.max(d);
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
        if self.game_over
            || self.won
            || !self.is_playable(x, y)
            || self.flagged.contains(&(x, y))
            || self.revealed.contains(&(x, y))
        {
            return 0;
        }
        if self.safe_origin.is_none() {
            self.safe_origin = Some((x, y));
            self.recount_mines();
        }
        if self.is_mine(x, y) {
            self.exploded.insert((x, y));
            self.game_over = true;
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
        if self.game_over || self.won || !self.revealed.contains(&(x, y)) {
            return 0;
        }
        let n = self.adjacent(x, y);
        if n == 0 {
            return 0;
        }
        let mut flags = 0;
        for dy in -1..=1 {
            for dx in -1..=1 {
                if self.flagged.contains(&(x + dx, y + dy)) {
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
        for y in y0..y0 + h as i32 {
            for x in x0..x0 + w as i32 {
                let p = (x, y);
                let state = if self.exploded.contains(&p) {
                    ST_MINE | 1
                } else if self.revealed.contains(&p) {
                    ST_REVEALED | self.adjacent(x, y)
                } else if self.game_over && self.is_mine(x, y) {
                    ST_MINE
                } else if self.flagged.contains(&p) {
                    ST_FLAG
                } else if self.island.is_some() && !self.is_playable(x, y) {
                    ST_VOID
                } else {
                    ST_HIDDEN
                };
                let key = (x.div_euclid(CH), y.div_euclid(CH));
                if key != last_key {
                    chunk = self.chunk(key.0, key.1);
                    last_key = key;
                }
                let i = ((y.rem_euclid(CH) * CH + x.rem_euclid(CH)) * 2) as usize;
                out.push(state);
                out.push(chunk[i]);
                out.push(chunk[i + 1]);
            }
        }
        out
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
            assert_eq!((v[i * 3 + 1], v[i * 3 + 2]), t.cell(x, y), "at {x},{y}");
        }
    }

    #[test]
    fn water_is_unplayable_and_mine_free() {
        let w = World::new_island(8, 128, 0.15, 0.25);
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
        let w = World::new_island(2, 128, 0.2, 0.2);
        assert!(w.land_total() > 2000);
        assert!(w.mines_total() > 0 && w.mines_total() < w.land_total());
        assert_eq!(w.safe_total(), w.land_total() - w.mines_total());
    }

    #[test]
    fn clearing_every_safe_cell_wins_the_island() {
        let mut w = World::new_island(3, 96, 0.12, 0.2);
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
            let mut w = World::new_island(seed, 96, 0.25, 0.3);
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
        let w = World::new_island(4, 192, 0.12, 0.30);
        assert!(w.density_at(80, 0) > w.density_at(5, 0) + 0.05);
    }

    #[test]
    fn state_round_trips() {
        for island in [false, true] {
            let make = || {
                if island {
                    World::new_island(6, 96, 0.15, 0.25)
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
        let w = World::new_island(2, 128, 0.15, 0.25);
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
}
