//! Deterministic hashing and value noise. Everything is a pure function of
//! `(seed, x, y)` so worlds never need to be stored.

pub fn fmix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

pub fn hash(seed: u32, x: i32, y: i32) -> u32 {
    fmix(fmix(fmix(seed) ^ x as u32) ^ (y as u32).wrapping_mul(0x9e37_79b1))
}

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// One octave of value noise in `[0, 1]`; `scale` is the lattice size in cells.
pub fn value_noise(seed: u32, x: i32, y: i32, scale: i32) -> f32 {
    let (gx, gy) = (x.div_euclid(scale), y.div_euclid(scale));
    let fx = smooth(x.rem_euclid(scale) as f32 / scale as f32);
    let fy = smooth(y.rem_euclid(scale) as f32 / scale as f32);
    let v = |dx, dy| (hash(seed, gx + dx, gy + dy) >> 8) as f32 / 16_777_215.0;
    let top = v(0, 0) + (v(1, 0) - v(0, 0)) * fx;
    let bot = v(0, 1) + (v(1, 1) - v(0, 1)) * fx;
    top + (bot - top) * fy
}

/// Weighted sum of octaves `(scale, weight)`; weights should sum to 1.
pub fn fbm(seed: u32, x: i32, y: i32, octaves: &[(i32, f32)]) -> f32 {
    let mut sum = 0.0;
    for (i, &(scale, weight)) in octaves.iter().enumerate() {
        let s = seed.wrapping_add((i as u32).wrapping_mul(0x9e37_79b9));
        sum += value_noise(s, x, y, scale) * weight;
    }
    sum
}
