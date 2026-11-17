//! Lake-rich island seeds and level 1 mine counts.   cargo run --release --example levelseeds3
use minefield::World;

fn main() {
    let cur = World::new_island(178, 96, 0.07, 0.13, 2);
    println!("current level 5: seed 178 land {} mines {} lakes {}", cur.land_total(), cur.mines_total(), cur.lake_total());
    let mut best: Vec<(u32, u32, u32, u32)> = Vec::new();
    for seed in 1..3000u32 {
        let w = World::new_island(seed, 96, 0.07, 0.13, 2);
        if w.land_total() > 3000 { best.push((w.lake_total(), seed, w.land_total(), w.mines_total())); }
    }
    best.sort_by(|a, b| b.cmp(a));
    for (lakes, seed, land, mines) in best.iter().take(12) { println!("seed {seed}: lakes {lakes} land {land} mines {mines}"); }
    for d in [(0.0165f32, 0.033f32), (0.02, 0.04), (0.024, 0.048), (0.028, 0.055)] {
        let w = World::new_island(13, 48, d.0, d.1, 2);
        println!("level 1 density {:?}: land {} mines {}", d, w.land_total(), w.mines_total());
    }
}
