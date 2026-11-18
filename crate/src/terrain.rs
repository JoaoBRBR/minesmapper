//! Terrain: elevation, moisture and temperature fields combined into biomes.
//!
//! Output per cell is `(biome, shade)`:
//! * `biome` - one of the `B_*` ids below (the TS palette mirrors this order).
//! * `shade` - 0..=255, 128 is neutral. Water: darker = deeper. Land: hillshade
//!   (light from the north-west) plus a little altitude brightening.

use crate::island::Island;
use crate::noise::{fbm, hash};

pub const CH: i32 = 32;
pub const SEA: f32 = 0.42;

/// Feature size on islands (generation 2+), relative to the endless world.
const ISLAND_DETAIL: f32 = 0.6;

pub const B_DEEP_OCEAN: u8 = 0;
pub const B_OCEAN: u8 = 1;
pub const B_BEACH: u8 = 2;
pub const B_DESERT: u8 = 3;
pub const B_BADLANDS: u8 = 4;
pub const B_SAVANNA: u8 = 5;
pub const B_GRASSLAND: u8 = 6;
pub const B_FOREST: u8 = 7;
pub const B_JUNGLE: u8 = 8;
pub const B_SWAMP: u8 = 9;
pub const B_TAIGA: u8 = 10;
pub const B_TUNDRA: u8 = 11;
pub const B_ROCK: u8 = 12;
pub const B_SNOW: u8 = 13;
#[allow(dead_code)]
pub const BIOME_COUNT: usize = 14;

// Space biomes (moons and meteors): the same ids continue after the overworld ones.
pub const B_REGOLITH: u8 = 14;
pub const B_CRATER_FLOOR: u8 = 15;
pub const B_CRATER_RIM: u8 = 16;
pub const B_MOON_ICE: u8 = 17;
/// All biome ids, overworld and space.
pub const BIOME_TOTAL: usize = 18;

/// Crater layers: grid cell size, smallest and largest radius, and chance (out of 256) that a grid
/// cell holds a crater. Big, medium and small ones overlap, which gives a believable pocked surface.
const CRATER_LAYERS: [(i32, f32, f32, u32); 3] = [(96, 16.0, 34.0, 210), (40, 6.0, 15.0, 200), (16, 2.5, 5.5, 160)];

fn contrast(v: f32, k: f32) -> f32 {
    ((v - 0.5) * k + 0.5).clamp(0.0, 1.0)
}

/// Pure biome lookup. `h` is height above sea level (0..1), `m` moisture, `t` temperature.
pub fn classify(h: f32, m: f32, t: f32) -> u8 {
    if h < 0.045 {
        return if t < 0.18 { B_TUNDRA } else { B_BEACH };
    }
    if h > 0.80 {
        return if t < 0.55 { B_SNOW } else { B_ROCK };
    }
    if h > 0.64 {
        return if t < 0.30 { B_SNOW } else { B_ROCK };
    }
    if t < 0.30 {
        return if m < 0.45 { B_TUNDRA } else { B_TAIGA };
    }
    if t < 0.58 {
        return if m < 0.33 {
            B_GRASSLAND
        } else if m < 0.72 {
            B_FOREST
        } else if h < 0.16 {
            B_SWAMP
        } else {
            B_TAIGA
        };
    }
    // hot
    if m < 0.26 {
        if h > 0.38 {
            B_BADLANDS
        } else {
            B_DESERT
        }
    } else if m < 0.50 {
        B_SAVANNA
    } else if m < 0.72 {
        B_GRASSLAND
    } else if h < 0.14 {
        B_SWAMP
    } else {
        B_JUNGLE
    }
}

#[derive(Clone, Copy)]
pub struct Terrain {
    seed: u32,
    /// > 0 in island mode: half the island's side length, in cells.
    island_half: f32,
    /// Multiplier on noise feature size (smaller islands get finer detail).
    detail: f32,
    /// Moons and meteors: craters instead of overworld biomes, void instead of water.
    space: bool,
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Terrain {
    pub fn new(seed: u32) -> Self {
        Terrain { seed, island_half: 0.0, detail: 1.0, space: false }
    }

    /// Terrain whose elevation is pulled below sea level towards the edges of a
    /// `size` x `size` square, producing an island surrounded by water.
    ///
    /// `generation` 1 is the original look: the size of every feature grew with the island, so
    /// small, medium and large islands were the same picture at different resolutions.
    /// From generation 2 features have a fixed size in cells, so a bigger island holds more
    /// coast, more mountains and many more biomes.
    pub fn new_island(seed: u32, size: i32, generation: u32) -> Self {
        let detail = if generation <= 1 { (size as f32 / 256.0).clamp(0.3, 1.0) } else { ISLAND_DETAIL };
        Terrain { seed, island_half: size as f32 / 2.0, detail, space: false }
    }

    /// The same terrain seen as a moon (endless) or a meteor (island): craters, no water.
    pub fn with_space(mut self, on: bool) -> Self {
        self.space = on;
        self
    }

    /// Height offset and surface class from every crater covering this cell.
    /// Class: 0 plain, 1 floor, 2 rim, 3 ejecta blanket, 4 ice in a deep floor.
    fn crater_at(&self, x: i32, y: i32) -> (f32, u8) {
        let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
        let mut height = 0.0f32;
        let mut best = (f32::MAX, 0u8);
        for (li, &(g, rmin, rmax, presence)) in CRATER_LAYERS.iter().enumerate() {
            let salt = 0xC0FF_EE00u32.wrapping_add(li as u32 * 0x9E37);
            let (gx0, gy0) = (x.div_euclid(g), y.div_euclid(g));
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (gx, gy) = (gx0 + dx, gy0 + dy);
                    let h = hash(self.seed ^ salt, gx, gy);
                    if (h & 0xff) >= presence {
                        continue;
                    }
                    let h2 = hash(self.seed ^ salt ^ 0x5bd1_e995, gx, gy);
                    let cx = (gx * g) as f32 + ((h >> 8) & 0xff) as f32 / 256.0 * g as f32;
                    let cy = (gy * g) as f32 + ((h2 >> 8) & 0xff) as f32 / 256.0 * g as f32;
                    let r = rmin + (h2 & 0xff) as f32 / 255.0 * (rmax - rmin);
                    let t = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt() / r;
                    if t > 1.8 {
                        continue;
                    }
                    let depth = 0.085 * (0.5 + 0.5 * r / rmax);
                    let bowl = if t < 0.9 { -depth * (1.0 - (t / 0.9).powi(2)) } else { 0.0 };
                    let rim = depth * 0.45 * (-((t - 1.0) / 0.2).powi(2)).exp();
                    height += bowl + rim;
                    if t < best.0 {
                        let class = if t < 0.88 {
                            if li < 2 && t < 0.55 && (h >> 16) & 7 == 0 { 4 } else { 1 }
                        } else if t < 1.12 {
                            2
                        } else if t < 1.5 {
                            3
                        } else {
                            0
                        };
                        best = (t, class);
                    }
                }
            }
        }
        (height, best.1)
    }

    fn space_elevation(&self, x: i32, y: i32) -> f32 {
        let o = self.octaves([(96, 0.50), (40, 0.28), (16, 0.14), (6, 0.08)]);
        let e = contrast(fbm(self.seed ^ 0x1111_1111, x, y, &o), 1.7);
        let (craters, _) = self.crater_at(x, y);
        if self.island_half <= 0.0 {
            // a moon: solid ground as far as you can go
            return (SEA + 0.14 + (e - 0.5) * 0.08 + craters).max(SEA + 0.02);
        }
        // a meteor: a lumpy rock in the void, its edge bitten by craters, no holes in the middle
        let dn = ((x as f32 + 0.5).powi(2) + (y as f32 + 0.5).powi(2)).sqrt() / self.island_half;
        let shaped = 0.5 + (e - 0.5) * 0.55;
        let offset = 0.18 * (1.0 - smoothstep(dn / 0.6)) - 0.8 * smoothstep((dn - 0.65) / 0.35);
        let v = shaped + offset + craters * 0.7;
        let v = if dn < 0.7 { v.max(SEA + 0.02) } else { v };
        v.clamp(0.0, 1.0)
    }

    fn octaves<const N: usize>(&self, base: [(i32, f32); N]) -> [(i32, f32); N] {
        base.map(|(scale, w)| (((scale as f32 * self.detail).round() as i32).max(2), w))
    }

    pub fn elevation(&self, x: i32, y: i32) -> f32 {
        if self.space {
            return self.space_elevation(x, y);
        }
        let o = self.octaves([(96, 0.50), (40, 0.28), (16, 0.14), (6, 0.08)]);
        let e = contrast(fbm(self.seed ^ 0x1111_1111, x, y, &o), 1.7);
        if self.island_half <= 0.0 {
            return e;
        }
        // The radial shape dominates (so every seed yields a real island); noise
        // only perturbs it, carving coves, peninsulas and inner lakes.
        let dn = ((x as f32 + 0.5).powi(2) + (y as f32 + 0.5).powi(2)).sqrt() / self.island_half;
        let shaped = 0.5 + (e - 0.5) * 0.55;
        let offset = 0.18 * (1.0 - smoothstep(dn / 0.6)) - 0.8 * smoothstep((dn - 0.65) / 0.35);
        (shaped + offset).clamp(0.0, 1.0)
    }

    pub fn moisture(&self, x: i32, y: i32) -> f32 {
        contrast(fbm(self.seed ^ 0x2222_2222, x, y, &self.octaves([(72, 0.55), (28, 0.30), (10, 0.15)])), 2.0)
    }

    pub fn temperature(&self, x: i32, y: i32) -> f32 {
        contrast(fbm(self.seed ^ 0x3333_3333, x, y, &self.octaves([(140, 0.60), (50, 0.30), (18, 0.10)])), 2.0)
    }

    /// Biome + shade for a cell, given its elevation and the elevations of its
    /// NW and SE diagonal neighbours (for hillshading).
    fn make_cell(&self, x: i32, y: i32, e: f32, e_nw: f32, e_se: f32) -> (u8, u8) {
        if e < SEA {
            let depth = (e / SEA).clamp(0.0, 1.0); // 0 = abyss, 1 = shoreline
            let biome = if e < 0.28 { B_DEEP_OCEAN } else { B_OCEAN };
            return (biome, (30.0 + depth * 190.0) as u8);
        }
        if self.space {
            let (_, class) = self.crater_at(x, y);
            let boulders = self.moisture(x, y) > 0.78;
            let (biome, tint) = match class {
                1 => (B_CRATER_FLOOR, -14.0),
                4 => (B_MOON_ICE, 0.0),
                2 => (B_CRATER_RIM, 20.0),
                3 => (B_REGOLITH, 8.0),
                _ => (if boulders { B_ROCK } else { B_REGOLITH }, 0.0),
            };
            let shade = 128.0 + (e_nw - e_se) * 900.0 + tint;
            return (biome, shade.clamp(0.0, 255.0) as u8);
        }
        let h = ((e - SEA) / (1.0 - SEA)).clamp(0.0, 1.0);
        let biome = classify(h, self.moisture(x, y), self.temperature(x, y));
        let slope = (e_nw - e_se) * 520.0;
        let shade = 128.0 + slope + (h - 0.35) * 50.0;
        (biome, shade.clamp(0.0, 255.0) as u8)
    }

    /// Single-cell lookup (tests / island generation). `chunk` is the fast path.
    #[allow(dead_code)]
    pub fn cell(&self, x: i32, y: i32) -> (u8, u8) {
        self.make_cell(
            x,
            y,
            self.elevation(x, y),
            self.elevation(x - 1, y - 1),
            self.elevation(x + 1, y + 1),
        )
    }

    /// `CH * CH` cells as `[biome, shade]` pairs, row-major, for chunk `(cx, cy)`.
    pub fn chunk(&self, cx: i32, cy: i32, island: Option<&Island>) -> Vec<u8> {
        let (ox, oy) = (cx * CH, cy * CH);
        let side = (CH + 2) as usize;
        let mut elev = vec![0f32; side * side];
        for j in 0..side {
            for i in 0..side {
                elev[j * side + i] = self.elevation(ox + i as i32 - 1, oy + j as i32 - 1);
            }
        }
        let mut out = Vec::with_capacity((CH * CH * 2) as usize);
        for ly in 0..CH as usize {
            for lx in 0..CH as usize {
                let e = elev[(ly + 1) * side + lx + 1];
                let nw = elev[ly * side + lx];
                let se = elev[(ly + 2) * side + lx + 2];
                let (x, y) = (ox + lx as i32, oy + ly as i32);
                let (mut b, mut s) = self.make_cell(x, y, e, nw, se);
                // Land cut off from the main island (islets) is drawn as shallows.
                if let Some(isl) = island {
                    if e >= SEA && !isl.contains(x, y) {
                        (b, s) = (B_OCEAN, 205);
                    }
                }
                out.push(b);
                out.push(s);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terrain_is_stable() {
        let t = Terrain::new(9);
        assert_eq!(t.cell(123, -456), t.cell(123, -456));
    }

    #[test]
    fn chunk_matches_cell_lookup() {
        let t = Terrain::new(4);
        let c = t.chunk(-2, 3, None);
        for ly in [0, 5, 31] {
            for lx in [0, 7, 31] {
                let (x, y) = (-2 * CH + lx, 3 * CH + ly);
                let i = ((ly * CH + lx) * 2) as usize;
                assert_eq!((c[i], c[i + 1]), t.cell(x, y));
            }
        }
    }

    #[test]
    fn every_biome_appears_and_water_is_reasonable() {
        let mut counts = [0u32; BIOME_COUNT];
        let mut total = 0u32;
        for seed in 1..=6u32 {
            let t = Terrain::new(seed);
            for y in (-1500..1500).step_by(7) {
                for x in (-1500..1500).step_by(7) {
                    counts[t.cell(x, y).0 as usize] += 1;
                    total += 1;
                }
            }
        }
        let pct = |n: u32| n as f32 * 100.0 / total as f32;
        let water = pct(counts[0] + counts[1]);
        println!("{counts:?} water={water:.1}%");
        for (b, &n) in counts.iter().enumerate() {
            assert!(pct(n) > 0.5, "biome {b} is too rare: {:.2}%", pct(n));
            assert!(pct(n) < 35.0, "biome {b} dominates: {:.2}%", pct(n));
        }
        assert!((15.0..50.0).contains(&water), "water {water}%");
    }

    /// Average number of distinct land biomes on an island of this size (sampled every 3rd cell).
    fn avg_land_biomes(size: i32, generation: u32) -> f64 {
        let mut total = 0;
        for seed in 0..6u32 {
            let t = Terrain::new_island(seed, size, generation);
            let mut seen = [false; BIOME_COUNT];
            let h = size / 2;
            for y in (-h..h).step_by(3) {
                for x in (-h..h).step_by(3) {
                    let (b, _) = t.cell(x, y);
                    if b > B_OCEAN {
                        seen[b as usize] = true;
                    }
                }
            }
            total += seen.iter().filter(|&&s| s).count();
        }
        total as f64 / 6.0
    }

    #[test]
    fn bigger_islands_hold_more_biomes_from_generation_two() {
        let (small, medium, large) = (avg_land_biomes(96, 2), avg_land_biomes(192, 2), avg_land_biomes(320, 2));
        println!("land biomes on average: small {small:.1}, medium {medium:.1}, large {large:.1}");
        assert!(small < medium && medium < large, "{small} {medium} {large}");
        assert!(large >= small + 2.0, "small {small}, large {large}");
    }

    #[test]
    fn generation_one_islands_still_look_the_same_at_every_size() {
        // The original look is kept for old saves: features scaled with the island.
        let (small, large) = (avg_land_biomes(96, 1), avg_land_biomes(320, 1));
        println!("generation 1: small {small:.1}, large {large:.1}");
        assert!((small - large).abs() < 2.0, "{small} vs {large}");
    }

    #[test]
    fn moons_have_craters_and_no_water() {
        let t = Terrain::new(5).with_space(true);
        let mut counts = [0u32; BIOME_TOTAL];
        for y in (-400..400).step_by(3) {
            for x in (-400..400).step_by(3) {
                counts[t.cell(x, y).0 as usize] += 1;
            }
        }
        println!("moon biomes {counts:?}");
        assert_eq!(counts[B_OCEAN as usize] + counts[B_DEEP_OCEAN as usize], 0, "a moon has no void");
        for b in [B_REGOLITH, B_CRATER_FLOOR, B_CRATER_RIM] {
            assert!(counts[b as usize] > 200, "biome {b}: {}", counts[b as usize]);
        }
        assert_eq!(t.cell(77, -31), t.cell(77, -31));
    }

    #[test]
    fn meteors_are_rock_in_the_void_without_inner_holes() {
        let t = Terrain::new_island(11, 96, 2).with_space(true);
        for y in -34..34 {
            for x in -34..34 {
                if x * x + y * y <= 32 * 32 {
                    assert!(t.cell(x, y).0 > B_OCEAN, "hole inside the rock at ({x},{y})");
                }
            }
        }
        assert!(t.cell(60, 0).0 <= B_OCEAN, "void outside");
    }
}
