//! Seeds for levels 5-9.   cargo run --release --example levelseeds2
use minefield::World;

fn water_share(w: &World, x0: i32, y0: i32, x1: i32, y1: i32) -> f32 {
    let (mut water, mut n) = (0, 0);
    for y in y0..=y1 { for x in x0..=x1 { n += 1; if w.view(x, y, 1, 1)[1] <= 1 { water += 1; } } }
    water as f32 / n as f32
}

fn main() {
    println!("-- lakes: size 96, density .07/.13, lakes >= 25, land > 3500");
    for seed in 1..200u32 {
        let w = World::new_island(seed, 96, 0.07, 0.13, 2);
        if w.lake_total() >= 25 && w.land_total() > 3500 { println!("seed {seed}: land {} mines {} lakes {}", w.land_total(), w.mines_total(), w.lake_total()); }
    }
    println!("-- oracle chunk (-3,1): cells -48..-33 x 16..31, >=2 oracles, land");
    for seed in 1..400u32 {
        let w = World::new(seed, 0.13, 0.17, 300.0);
        let mut stars = vec![];
        for y in 16..32 { for x in -48..-32 { if w.is_powerup(x, y) { stars.push((x, y)); } } }
        if stars.len() >= 2 && water_share(&w, -48, 16, -33, 31) < 0.05 { println!("seed {seed}: oracles {stars:?}"); }
    }
    println!("-- coast: start [0..15]x[0..15], target (88, 8); some water between");
    for seed in 1..400u32 {
        let w = World::new(seed, 0.13, 0.18, 300.0);
        let s = water_share(&w, 0, 0, 15, 15);
        let t = water_share(&w, 85, 5, 91, 11);
        let mid = water_share(&w, 16, 0, 84, 16);
        if s < 0.02 && t < 0.02 && (0.15..0.45).contains(&mid) { println!("seed {seed}: mid water {mid:.2}"); }
    }
    println!("-- 128, density .07/.14");
    for seed in 1..80u32 {
        let w = World::new_island(seed, 128, 0.07, 0.14, 2);
        if w.land_total() > 7000 { println!("seed {seed}: land {} mines {} lakes {}", w.land_total(), w.mines_total(), w.lake_total()); }
    }
    println!("-- medium 192, density .06/.12");
    for seed in 1..60u32 {
        let w = World::new_island(seed, 192, 0.06, 0.12, 2);
        if w.land_total() > 13500 { println!("seed {seed}: land {} mines {} lakes {}", w.land_total(), w.mines_total(), w.lake_total()); }
    }
}
