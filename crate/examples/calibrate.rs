//! Measures how often a perfect solver is forced to guess ("coin flip") at a given
//! mine density, to calibrate how rare the reveal-one-cell power-up should be.
//!
//!     cargo run --release --example calibrate
//!
//! A simulated player always reveals every provably safe cell. When none exists it
//! uses an oracle on the least-risky frontier cell (as a power-up would): a safe
//! cell is revealed, a mine becomes known. We count how many oracle uses were
//! needed per cleared cell.

use minefield::solver::{self, analyze, Board, Cell};
use minefield::World;
use std::collections::HashSet;

struct Sim<'a> {
    w: &'a World,
    known: &'a HashSet<(i32, i32)>,
}
impl Board for Sim<'_> {
    fn cell(&self, x: i32, y: i32) -> Cell {
        if self.known.contains(&(x, y)) {
            Cell::KnownMine
        } else {
            solver::Board::cell(self.w, x, y)
        }
    }
}

struct Run {
    cells: u32,
    stuck: u32,
    unresolved: u32,
}

fn simulate(seed: u32, density: f32, target: u32) -> Run {
    let mut w = World::new(seed, density, density, 0.0);
    w.reveal(0, 0);
    let mut known = HashSet::new();
    let (mut stuck, mut unresolved) = (0, 0);
    for _ in 0..200_000 {
        if w.score() >= target || w.is_game_over() {
            break;
        }
        let a = analyze(&Sim { w: &w, known: &known }, &w.revealed_cells());
        unresolved += a.unresolved;
        if !a.safe.is_empty() {
            for (x, y) in a.safe {
                w.reveal(x, y);
            }
            continue;
        }
        let Some(((x, y), _)) = a.best_guess else { break };
        stuck += 1;
        if w.is_mine(x, y) {
            known.insert((x, y));
        } else {
            w.reveal(x, y);
        }
    }
    Run { cells: w.score(), stuck, unresolved }
}

fn main() {
    // Usage: calibrate [first_density] [last_density] [seeds] [target_cells]
    let arg = |i: usize, default: f64| std::env::args().nth(i).and_then(|a| a.parse().ok()).unwrap_or(default);
    let first = arg(1, 0.08) as f32;
    let last = arg(2, 0.36) as f32;
    let seeds = arg(3, 40.0) as u32;
    let target = arg(4, 3000.0) as u32;
    println!("density  cells/run  stuck/1000cells  1-in-N cells  unresolved-groups");
    let mut d = first;
    while d <= last + 0.001 {
        let (mut cells, mut stuck, mut unres) = (0u64, 0u64, 0u64);
        for s in 0..seeds {
            let r = simulate(s, d, target);
            cells += r.cells as u64;
            stuck += r.stuck as u64;
            unres += r.unresolved as u64;
        }
        let per_1000 = stuck as f64 * 1000.0 / cells.max(1) as f64;
        println!(
            "{:>6.2}  {:>9}  {:>15.2}  {:>12.0}  {:>17}",
            d,
            cells / seeds as u64,
            per_1000,
            cells as f64 / stuck.max(1) as f64,
            unres
        );
        d += 0.02;
    }
}
