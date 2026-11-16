//! Minesweeper constraint solver.
//!
//! Given the revealed numbers on a board it works out which hidden cells are
//! *provably* safe or *provably* mines, using only what a player could see (no
//! global mine count, which does not exist in the infinite world).
//!
//! 1. Single-constraint rules (all remaining neighbours safe / all mines).
//! 2. Subset rule between two constraints.
//! 3. Exhaustive enumeration of each independent group of constraints
//!    (with a node budget; groups that exceed it are reported as unresolved).
//!
//! If a position has no provably safe cell, the player is facing a forced
//! guess ("coin flip"). Measuring how often that happens drives how rare the
//! power-up is (see `examples/calibrate.rs`).
#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cell {
    /// Not part of the game (water).
    Void,
    /// Playable and not revealed. Player flags are deliberately ignored.
    Hidden,
    /// Revealed, showing this many adjacent mines.
    Num(u8),
    /// A hidden cell that is certainly a mine (e.g. confirmed by a power-up).
    KnownMine,
}

pub trait Board {
    fn cell(&self, x: i32, y: i32) -> Cell;
}

#[derive(Default, Debug)]
pub struct Analysis {
    pub safe: Vec<(i32, i32)>,
    pub mines: Vec<(i32, i32)>,
    /// Hidden frontier cell least likely to be a mine, with its estimated probability.
    pub best_guess: Option<((i32, i32), f64)>,
    /// Groups of constraints too large to enumerate within the budget.
    pub unresolved: u32,
}

/// Search nodes allowed per independent group before giving up on it.
const NODE_BUDGET: u64 = 400_000;

struct Constraint {
    cells: Vec<usize>,
    mines: i32,
}

/// Analyses the position around the given revealed cells (cells that are not
/// revealed numbers are ignored, so callers may pass every revealed cell).
pub fn analyze<B: Board>(board: &B, revealed: &[(i32, i32)]) -> Analysis {
    // --- Build constraints -----------------------------------------------------------
    let mut index: HashMap<(i32, i32), usize> = HashMap::new();
    let mut coords: Vec<(i32, i32)> = Vec::new();
    let mut cons: Vec<Constraint> = Vec::new();
    for &(x, y) in revealed {
        let Cell::Num(n) = board.cell(x, y) else { continue };
        let mut cells = Vec::new();
        let mut mines = n as i32;
        for dy in -1..=1 {
            for dx in -1..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let p = (x + dx, y + dy);
                match board.cell(p.0, p.1) {
                    Cell::Hidden => {
                        let next = coords.len();
                        let i = *index.entry(p).or_insert_with(|| {
                            coords.push(p);
                            next
                        });
                        cells.push(i);
                    }
                    Cell::KnownMine => mines -= 1,
                    _ => {}
                }
            }
        }
        if !cells.is_empty() {
            cons.push(Constraint { cells, mines });
        }
    }

    let n = coords.len();
    // 0 = unknown, 1 = safe, -1 = mine
    let mut state = vec![0i8; n];
    let mut by_cell: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (ci, c) in cons.iter().enumerate() {
        for &v in &c.cells {
            by_cell[v].push(ci);
        }
    }

    // Unknown cells of a constraint and the mines still to place among them.
    let residual = |c: &Constraint, state: &[i8]| -> (Vec<usize>, i32) {
        let mut m = c.mines;
        let mut unk = Vec::new();
        for &v in &c.cells {
            match state[v] {
                0 => unk.push(v),
                -1 => m -= 1,
                _ => {}
            }
        }
        (unk, m)
    };

    // --- Propagation to a fixpoint ----------------------------------------------------
    loop {
        let mut changed = false;
        for c in &cons {
            let (unk, m) = residual(c, &state);
            if unk.is_empty() {
                continue;
            }
            if m == 0 {
                unk.iter().for_each(|&v| state[v] = 1);
                changed = true;
            } else if m as usize == unk.len() {
                unk.iter().for_each(|&v| state[v] = -1);
                changed = true;
            }
        }
        if changed {
            continue;
        }
        // Subset rule: if A's unknowns are inside B's, B \ A holds m_B - m_A mines.
        for ca in &cons {
            let (ua, ma) = residual(ca, &state);
            if ua.is_empty() {
                continue;
            }
            let set_a: HashSet<usize> = ua.iter().copied().collect();
            let mut seen = HashSet::new();
            for &ci in &by_cell[ua[0]] {
                if !seen.insert(ci) {
                    continue;
                }
                let (ub, mb) = residual(&cons[ci], &state);
                if ub.len() <= ua.len() || !set_a.iter().all(|v| ub.contains(v)) {
                    continue;
                }
                let diff: Vec<usize> = ub.iter().copied().filter(|v| !set_a.contains(v)).collect();
                let dm = mb - ma;
                if dm == 0 {
                    diff.iter().for_each(|&v| state[v] = 1);
                    changed = true;
                } else if dm as usize == diff.len() {
                    diff.iter().for_each(|&v| state[v] = -1);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // --- Enumerate what is left, one independent group at a time -----------------------
    let mut out = Analysis::default();
    let mut prob: Vec<Option<f64>> = vec![None; n];
    let live: Vec<usize> = (0..cons.len()).filter(|&ci| !residual(&cons[ci], &state).0.is_empty()).collect();
    let mut seen_con = vec![false; cons.len()];
    for &start in &live {
        if seen_con[start] {
            continue;
        }
        // Collect the connected group of constraints/variables.
        let mut group_cons = Vec::new();
        let mut group_vars: Vec<usize> = Vec::new();
        let mut var_seen: HashSet<usize> = HashSet::new();
        let mut queue = VecDeque::from([start]);
        seen_con[start] = true;
        while let Some(ci) = queue.pop_front() {
            group_cons.push(ci);
            for &v in &cons[ci].cells {
                if state[v] != 0 || !var_seen.insert(v) {
                    continue;
                }
                group_vars.push(v);
                for &cj in &by_cell[v] {
                    if !seen_con[cj] && live.binary_search(&cj).is_ok() {
                        seen_con[cj] = true;
                        queue.push_back(cj);
                    }
                }
            }
        }
        match enumerate(&cons, &group_cons, &group_vars, &state) {
            Some(counts) => {
                for (k, &v) in group_vars.iter().enumerate() {
                    let (mine, total) = counts[k];
                    if mine == 0.0 {
                        state[v] = 1;
                    } else if mine == total {
                        state[v] = -1;
                    } else {
                        prob[v] = Some(mine / total);
                    }
                }
            }
            None => {
                out.unresolved += 1;
                for &v in &group_vars {
                    let ps: Vec<f64> = by_cell[v]
                        .iter()
                        .filter_map(|&ci| {
                            let (u, m) = residual(&cons[ci], &state);
                            (!u.is_empty()).then(|| m as f64 / u.len() as f64)
                        })
                        .collect();
                    prob[v] = Some(ps.iter().sum::<f64>() / ps.len().max(1) as f64);
                }
            }
        }
    }

    for (v, &s) in state.iter().enumerate() {
        match s {
            1 => out.safe.push(coords[v]),
            -1 => out.mines.push(coords[v]),
            _ => {}
        }
    }
    out.safe.sort_unstable();
    out.mines.sort_unstable();
    out.best_guess = (0..n)
        .filter(|&v| state[v] == 0)
        .filter_map(|v| prob[v].map(|p| (coords[v], p)))
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(a.0.cmp(&b.0)));
    out
}

/// Per variable `(solutions where it is a mine, total solutions)` for a group, or
/// `None` if the node budget ran out.
fn enumerate(
    cons: &[Constraint],
    group_cons: &[usize],
    vars: &[usize],
    state: &[i8],
) -> Option<Vec<(f64, f64)>> {
    let local: HashMap<usize, usize> = vars.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    // Local constraints: variable list + mines still needed.
    let mut lc: Vec<(Vec<usize>, i32)> = Vec::new();
    for &ci in group_cons {
        let mut m = cons[ci].mines;
        let mut vs = Vec::new();
        for &v in &cons[ci].cells {
            match state[v] {
                0 => vs.push(local[&v]),
                -1 => m -= 1,
                _ => {}
            }
        }
        lc.push((vs, m));
    }
    let mut var_cons: Vec<Vec<usize>> = vec![Vec::new(); vars.len()];
    for (ci, (vs, _)) in lc.iter().enumerate() {
        for &v in vs {
            var_cons[v].push(ci);
        }
    }
    // Branch in breadth-first order so constraints close (and prune) early.
    let mut order = Vec::with_capacity(vars.len());
    let mut placed = vec![false; vars.len()];
    for s in 0..vars.len() {
        if placed[s] {
            continue;
        }
        let mut q = VecDeque::from([s]);
        placed[s] = true;
        while let Some(v) = q.pop_front() {
            order.push(v);
            for &ci in &var_cons[v] {
                for &u in &lc[ci].0 {
                    if !placed[u] {
                        placed[u] = true;
                        q.push_back(u);
                    }
                }
            }
        }
    }

    struct Search<'a> {
        lc: &'a [(Vec<usize>, i32)],
        var_cons: &'a [Vec<usize>],
        order: &'a [usize],
        assigned: Vec<i32>,
        unassigned: Vec<i32>,
        value: Vec<u8>,
        mine_count: Vec<f64>,
        solutions: f64,
        nodes: u64,
    }
    impl Search<'_> {
        fn rec(&mut self, pos: usize) -> bool {
            self.nodes += 1;
            if self.nodes > NODE_BUDGET {
                return false;
            }
            if pos == self.order.len() {
                self.solutions += 1.0;
                for (v, &x) in self.value.iter().enumerate() {
                    self.mine_count[v] += x as f64;
                }
                return true;
            }
            let v = self.order[pos];
            for val in [0u8, 1u8] {
                self.value[v] = val;
                let mut ok = true;
                for &ci in &self.var_cons[v] {
                    self.assigned[ci] += val as i32;
                    self.unassigned[ci] -= 1;
                }
                for &ci in &self.var_cons[v] {
                    let m = self.lc[ci].1;
                    if self.assigned[ci] > m || self.assigned[ci] + self.unassigned[ci] < m {
                        ok = false;
                        break;
                    }
                }
                let cont = !ok || self.rec(pos + 1);
                for &ci in &self.var_cons[v] {
                    self.assigned[ci] -= val as i32;
                    self.unassigned[ci] += 1;
                }
                if !cont {
                    return false;
                }
            }
            true
        }
    }

    let mut s = Search {
        lc: &lc,
        var_cons: &var_cons,
        order: &order,
        assigned: vec![0; lc.len()],
        unassigned: lc.iter().map(|(vs, _)| vs.len() as i32).collect(),
        value: vec![0; vars.len()],
        mine_count: vec![0.0; vars.len()],
        solutions: 0.0,
        nodes: 0,
    };
    if !s.rec(0) || s.solutions == 0.0 {
        return None;
    }
    Some(s.mine_count.iter().map(|&m| (m, s.solutions)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ASCII board: `#` hidden, `.` void, `X` known mine, digits revealed numbers.
    struct Grid(HashMap<(i32, i32), Cell>);
    impl Grid {
        fn parse(rows: &[&str]) -> (Grid, Vec<(i32, i32)>) {
            let mut m = HashMap::new();
            let mut revealed = Vec::new();
            for (y, row) in rows.iter().enumerate() {
                for (x, ch) in row.chars().enumerate() {
                    let p = (x as i32, y as i32);
                    let c = match ch {
                        '#' => Cell::Hidden,
                        'X' => Cell::KnownMine,
                        d if d.is_ascii_digit() => {
                            revealed.push(p);
                            Cell::Num(d.to_digit(10).unwrap() as u8)
                        }
                        _ => Cell::Void,
                    };
                    m.insert(p, c);
                }
            }
            (Grid(m), revealed)
        }
    }
    impl Board for Grid {
        fn cell(&self, x: i32, y: i32) -> Cell {
            *self.0.get(&(x, y)).unwrap_or(&Cell::Void)
        }
    }

    #[test]
    fn single_hidden_neighbour_is_a_mine() {
        let (g, r) = Grid::parse(&["...", ".1#", "..."]);
        let a = analyze(&g, &r);
        assert_eq!(a.mines, vec![(2, 1)]);
        assert!(a.safe.is_empty());
    }

    #[test]
    fn classic_one_two_one() {
        let (g, r) = Grid::parse(&["###", "121"]);
        let a = analyze(&g, &r);
        assert_eq!(a.safe, vec![(1, 0)]);
        assert_eq!(a.mines, vec![(0, 0), (2, 0)]);
    }

    #[test]
    fn subset_rule_finds_the_extra_cell() {
        // Two numbers over the same pair of cells: nothing can be told apart.
        let (g, r) = Grid::parse(&["##.", "11.", "..."]);
        let a = analyze(&g, &r);
        assert!(a.safe.is_empty() && a.mines.is_empty());
        // A = {a,b} has 1 mine, B = {a,b,c} has 1 mine -> c is safe.
        let (g, r) = Grid::parse(&["###", "11."]);
        let a = analyze(&g, &r);
        // (0,1)=1 over {(0,0),(1,0)}, (1,1)=1 over {(0,0),(1,0),(2,0)} -> (2,0) safe.
        assert_eq!(a.safe, vec![(2, 0)]);
    }

    #[test]
    fn a_true_coin_flip_has_no_deductions() {
        let (g, r) = Grid::parse(&["..#.", ".1#.", "...."]);
        let a = analyze(&g, &r);
        assert!(a.safe.is_empty());
        assert!(a.mines.is_empty());
        let (cell, p) = a.best_guess.unwrap();
        assert!((p - 0.5).abs() < 1e-9, "{cell:?} {p}");
    }

    #[test]
    fn known_mines_are_subtracted() {
        // The 2 has one known mine, so exactly one of its two hidden cells is a mine.
        let (g, r) = Grid::parse(&["X##", ".2."]);
        let a = analyze(&g, &r);
        assert!(a.safe.is_empty() && a.mines.is_empty());
    }

    #[test]
    fn overlapping_numbers_have_a_unique_solution() {
        let (g, r) = Grid::parse(&["####", "1221"]);
        let a = analyze(&g, &r);
        // Unique solution: mines at (1,0) and (2,0).
        assert_eq!(a.mines, vec![(1, 0), (2, 0)]);
        assert_eq!(a.safe, vec![(0, 0), (3, 0)]);
    }
}
