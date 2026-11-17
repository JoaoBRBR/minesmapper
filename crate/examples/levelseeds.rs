//! Finds seeds for the adventure levels.   cargo run --release --example levelseeds
use minefield::World;

fn land_share(w: &World, x0: i32, y0: i32, x1: i32, y1: i32) -> f32 {
    let (mut land, mut n) = (0, 0);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let v = w.view(x, y, 1, 1);
            n += 1;
            if v[1] > 1 { land += 1; }
        }
    }
    land as f32 / n as f32
}

fn main() {
    println!("-- tiny (48), want ~18 mines");
    for seed in 1..400u32 {
        let w = World::new_island(seed, 48, 0.0165, 0.033, 2);
        let m = w.mines_total();
        if (20..=34).contains(&m) && w.land_total() > 900 {
            println!("seed {seed}: land {} mines {m} lakes {}", w.land_total(), w.lake_total());
        }
    }
    println!("-- mid (72), density 0.06/0.12");
    for seed in 1..60u32 {
        let w = World::new_island(seed, 72, 0.06, 0.12, 2);
        println!("seed {seed}: land {} mines {} lakes {}", w.land_total(), w.mines_total(), w.lake_total());
    }
    println!("-- endless: land around chunk (2,-2) cells 32..47 x -32..-17, and along x=40, y -60..-20");
    for seed in 1..200u32 {
        let w = World::new(seed, 0.12, 0.2, 300.0);
        let a = land_share(&w, 32, -32, 47, -17);
        let b = land_share(&w, 28, -80, 52, -17);
        if a > 0.95 && b > 0.9 {
            println!("seed {seed}: start {a:.2} path {b:.2}");
        }
    }
}
