//! Seeds for the space levels (10-12).   cargo run --release --example levelseeds4
use minefield::World;

fn main() {
    for (size, d0, d1, label) in [(64u32, 0.09f32, 0.16f32, "meteor 64"), (112, 0.08, 0.15, "meteor 112")] {
        println!("-- {label}");
        let mut rows = Vec::new();
        for seed in 1..400u32 {
            let mut w = World::new_island(seed, size, d0, d1, 2);
            w.set_space(true);
            rows.push((w.land_total(), seed, w.mines_total()));
        }
        rows.sort();
        let n = rows.len();
        for r in rows.iter().skip(n * 6 / 10).take(8) { println!("seed {} land {} mines {}", r.1, r.0, r.2); }
        println!("max: seed {} land {}", rows[n - 1].1, rows[n - 1].0);
    }
}
