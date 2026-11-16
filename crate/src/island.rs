//! Island mode: a bounded square of `size` x `size` cells centred on the origin.
//! Land is wherever the (radially biased) elevation is above sea level; only the
//! landmass connected to the centre is playable, so there are no unreachable
//! islets. Inner lakes and bays are simply unplayable water.

use crate::terrain::{Terrain, SEA};

pub struct Island {
    pub size: i32,
    half: i32,
    playable: Vec<bool>,
    pub land_count: u32,
}

impl Island {
    pub fn build(terrain: &Terrain, size: i32) -> Island {
        let size = (size.max(16) / 2) * 2;
        let half = size / 2;
        let n = size as usize;
        let mut land = vec![false; n * n];
        let mut start: Option<(i32, i32, i64)> = None;
        for iy in 0..n {
            for ix in 0..n {
                let (x, y) = (ix as i32 - half, iy as i32 - half);
                if terrain.elevation(x, y) >= SEA {
                    land[iy * n + ix] = true;
                    let d = (x as i64).pow(2) + (y as i64).pow(2);
                    if start.map_or(true, |(_, _, best)| d < best) {
                        start = Some((x, y, d));
                    }
                }
            }
        }

        // Keep only the landmass (8-connected) containing the land cell nearest the centre.
        let mut playable = vec![false; n * n];
        let mut land_count = 0;
        if let Some((sx, sy, _)) = start {
            let idx = |x: i32, y: i32| (y + half) as usize * n + (x + half) as usize;
            let mut stack = vec![(sx, sy)];
            playable[idx(sx, sy)] = true;
            while let Some((x, y)) = stack.pop() {
                land_count += 1;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let (nx, ny) = (x + dx, y + dy);
                        if nx < -half || ny < -half || nx >= half || ny >= half {
                            continue;
                        }
                        let i = idx(nx, ny);
                        if land[i] && !playable[i] {
                            playable[i] = true;
                            stack.push((nx, ny));
                        }
                    }
                }
            }
        }
        Island { size, half, playable, land_count }
    }

    pub fn contains(&self, x: i32, y: i32) -> bool {
        if x < -self.half || y < -self.half || x >= self.half || y >= self.half {
            return false;
        }
        self.playable[(y + self.half) as usize * self.size as usize + (x + self.half) as usize]
    }

    /// Half the side length: cells run from `-half` to `half - 1`.
    pub fn half(&self) -> i32 {
        self.half
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn islands_are_sane_for_many_seeds() {
        for seed in 0..40 {
            let size = 160;
            let island = Island::build(&Terrain::new_island(seed, size), size);
            let frac = island.land_count as f32 / (size * size) as f32;
            assert!((0.12..0.6).contains(&frac), "seed {seed}: land fraction {frac}");
            // the border is always water
            for i in 0..size {
                let h = size / 2;
                assert!(!island.contains(-h, i - h) && !island.contains(h - 1, i - h));
                assert!(!island.contains(i - h, -h) && !island.contains(i - h, h - 1));
            }
        }
    }

    #[test]
    fn playable_land_is_one_connected_mass() {
        let size = 128;
        let island = Island::build(&Terrain::new_island(5, size), size);
        let h = island.half();
        let cells: Vec<(i32, i32)> = (-h..h)
            .flat_map(|y| (-h..h).map(move |x| (x, y)))
            .filter(|&(x, y)| island.contains(x, y))
            .collect();
        assert_eq!(cells.len() as u32, island.land_count);
        let mut seen = std::collections::HashSet::from([cells[0]]);
        let mut stack = vec![cells[0]];
        while let Some((x, y)) = stack.pop() {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let p = (x + dx, y + dy);
                    if island.contains(p.0, p.1) && seen.insert(p) {
                        stack.push(p);
                    }
                }
            }
        }
        assert_eq!(seen.len(), cells.len());
    }
}
