// 3D relief view of a finished island (three.js, loaded lazily).
//
// The island is a heightfield: smooth biome colours blended between cells, real elevation, a
// translucent block of sea around it with the sea floor showing through, and a dark skirt so it
// reads like a diorama on the map table. Drag to rotate, scroll or pinch to zoom.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BIOME_COLORS } from './render';

export interface IslandData {
  size: number;
  /** `[biome, elevation]` per cell, row-major from the north-west corner (World.island_snapshot). */
  cells: Uint8Array;
  /** A meteor: a floating rock in the stars instead of an island in the sea. */
  space?: boolean;
}

export interface Viewer {
  dispose(): void;
  setAutoRotate(on: boolean): void;
}

const SEA = 107 / 255; // matches crate/src/terrain.rs (0.42)
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Box blur over the cells where `use(i)` is true only (so a coast is not dragged into the sea). */
function blurWhere(src: Float32Array, n: number, use: (i: number) => boolean, r: number, passes = 1) {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    for (const horizontal of [true, false]) {
      const out = new Float32Array(cur.length);
      for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
          let sum = 0;
          let k = 0;
          for (let d = -r; d <= r; d++) {
            const [x, z] = horizontal ? [ix + d, iz] : [ix, iz + d];
            if (x < 0 || z < 0 || x >= n || z >= n || !use(z * n + x)) continue;
            sum += cur[z * n + x];
            k++;
          }
          out[iz * n + ix] = k ? sum / k : cur[iz * n + ix];
        }
      }
      cur = out;
    }
  }
  return cur;
}

/** How tall each biome stands (0..1 of the tallest peak): shores low, forests middling, rock and snow high. */
const BIOME_HEIGHT = [0, 0, 0.04, 0.16, 0.34, 0.16, 0.2, 0.3, 0.32, 0.06, 0.42, 0.46, 0.72, 1];

export function openIsland(stage: HTMLElement, data: IslandData): Viewer {
  if (data.space) return openMeteor(stage, data);
  const { size: n, cells } = data;
  const heightScale = 8 + n * 0.07; // how tall the highest peaks stand (calm on big islands too)
  const depthScale = n * 0.3; // how deep the sea floor sinks
  const seaDepth = SEA * depthScale; // the sea block reaches the deepest floor
  const floorY = -seaDepth - n * 0.03;

  // --- terrain ---------------------------------------------------------------------------------
  const isLand = (i: number) => cells[i * 2 + 1] / 255 >= SEA;
  // height follows the biome (shore low, hills and rock high), softened, with a little of the real elevation
  const base = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const e = (cells[i * 2 + 1] / 255 - SEA) / (1 - SEA);
    base[i] = isLand(i) ? 0.75 * (BIOME_HEIGHT[cells[i * 2]] ?? 0.3) + 0.25 * Math.max(0, e) : 0;
  }
  const level = blurWhere(base, n, isLand, 2, 2);
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const half = (n - 1) / 2;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const biome = cells[i * 2];
      const e = cells[i * 2 + 1] / 255;
      const land = e >= SEA;
      const y = land ? Math.max(0.15, level[i]) * heightScale : (e - SEA) * depthScale;
      positions.set([ix - half, y, iz - half], i * 3);

      let r: number;
      let g: number;
      let b: number;
      if (land) {
        const c = BIOME_COLORS[biome] ?? BIOME_COLORS[6];
        // a touch brighter with altitude
        const f = 0.92 + 0.16 * Math.min(1, level[i]);
        [r, g, b] = [Math.min(1, (c[0] / 255) * f), Math.min(1, (c[1] / 255) * f), Math.min(1, (c[2] / 255) * f)];
      } else {
        // sea floor: sand in the shallows, deep navy far from shore
        const t = Math.min(1, Math.max(0, (e - 0.12) / (SEA - 0.12)));
        [r, g, b] = [mix(0.08, 0.78, t * t), mix(0.18, 0.7, t * t), mix(0.3, 0.5, t * t)];
      }
      colors.set([r, g, b], i * 3);
    }
  }
  const indices: number[] = [];
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix;
      indices.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  const terrain = new BufferGeometry();
  terrain.setAttribute('position', new Float32BufferAttribute(positions, 3));
  terrain.setAttribute('color', new Float32BufferAttribute(colors, 3));
  terrain.setIndex(indices);
  terrain.computeVertexNormals();

  // --- skirt: closes the sides of the block ----------------------------------------------------
  const skirtPos: number[] = [];
  const skirtCol: number[] = [];
  const skirtIdx: number[] = [];
  const edge: number[][] = [
    Array.from({ length: n }, (_, k) => k), // north
    Array.from({ length: n }, (_, k) => (n - 1) * n + k), // south
    Array.from({ length: n }, (_, k) => k * n), // west
    Array.from({ length: n }, (_, k) => k * n + n - 1), // east
  ];
  for (const side of edge) {
    const base = skirtPos.length / 3;
    for (const v of side) {
      const [x, y, z] = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
      skirtPos.push(x, y, z, x, floorY, z);
      skirtCol.push(colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2], 0.16, 0.12, 0.08);
    }
    for (let k = 0; k < side.length - 1; k++) {
      const a = base + k * 2;
      skirtIdx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPos, 3));
  skirt.setAttribute('color', new Float32BufferAttribute(skirtCol, 3));
  skirt.setIndex(skirtIdx);
  skirt.computeVertexNormals();

  // --- scene -----------------------------------------------------------------------------------
  const scene = new Scene();
  const landMaterial = new MeshLambertMaterial({ vertexColors: true });
  const skirtMaterial = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  scene.add(new Mesh(terrain, landMaterial));
  scene.add(new Mesh(skirt, skirtMaterial));

  const seaGeometry = new BoxGeometry(n - 1, seaDepth, n - 1);
  const seaMaterial = new MeshPhysicalMaterial({
    color: 0x3c8fc4,
    transparent: true,
    opacity: 0.58,
    roughness: 0.12,
    metalness: 0,
    depthWrite: false,
  });
  const sea = new Mesh(seaGeometry, seaMaterial);
  sea.position.y = -seaDepth / 2;
  sea.renderOrder = 1;
  scene.add(sea);

  scene.add(new HemisphereLight(0xfff4dc, 0x7a6a4a, 1.0));
  const sun = new DirectionalLight(0xfff0cf, 1.7);
  sun.position.set(-n * 0.8, n * 1.1, -n * 0.5); // from the north-west, like the map's hillshade
  scene.add(sun);

  // --- renderer, camera, controls --------------------------------------------------------------
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  stage.appendChild(renderer.domElement);
  renderer.domElement.className = 'viewer-canvas';

  const camera = new PerspectiveCamera(38, 1, 1, n * 12);
  camera.position.set(n * 0.95, n * 0.8, n * 1.05);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, heightScale * 0.12, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.7;
  controls.minDistance = n * 0.45;
  controls.maxDistance = n * 3.2;
  controls.maxPolarAngle = Math.PI * 0.485; // stay above the table
  controls.update();

  const resize = () => {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    setAutoRotate(on) {
      controls.autoRotate = on;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      for (const g of [terrain, skirt, seaGeometry]) g.dispose();
      for (const m of [landMaterial, skirtMaterial, seaMaterial]) m.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * A meteor: the crater surface on top, a rounded rocky underside below, dark walls where the two
 * meet, floating in a field of stars. Not an exact model, just something that looks like the map.
 */
function openMeteor(stage: HTMLElement, data: IslandData): Viewer {
  const { size: n, cells } = data;
  const half = (n - 1) / 2;
  const land = (i: number) => cells[i * 2 + 1] / 255 >= SEA && cells[i * 2] > 1;
  const count = n * n;
  // how far each rock cell is from the edge (4-neighbour steps), so the shape follows the outline
  const edge = new Float32Array(count).fill(1e9);
  const queue: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!land(i)) {
      edge[i] = 0;
      queue.push(i);
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    const [ix, iz] = [i % n, Math.floor(i / n)];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const [nx, nz] = [ix + dx, iz + dz];
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const j = nz * n + nx;
      if (edge[j] > edge[i] + 1) {
        edge[j] = edge[i] + 1;
        queue.push(j);
      }
    }
  }
  // crater relief = elevation minus its own smooth average (a box blur over the rock)
  const elev = new Float32Array(count);
  for (let i = 0; i < count; i++) elev[i] = cells[i * 2 + 1] / 255;
  const blur = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(count);
    const r = 5;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        let sum = 0;
        let k = 0;
        for (let d = -r; d <= r; d++) {
          const [x, z] = horizontal ? [ix + d, iz] : [ix, iz + d];
          if (x < 0 || z < 0 || x >= n || z >= n || !land(z * n + x)) continue;
          sum += src[z * n + x];
          k++;
        }
        out[iz * n + ix] = k ? sum / k : src[iz * n + ix];
      }
    }
    return out;
  };
  const smooth = blur(blur(elev, true), false);
  const edgeSmooth = blur(blur(blur(blur(edge, true), false), true), false); // rounds off the stair-steps of the distance
  // craters in 3D: raised rims, bowl floors, from the biome of each cell (then softened)
  const CRATER_H: Record<number, number> = { 16: 1, 15: -1.1, 17: 0.3 };
  const craterRaw = new Float32Array(count);
  for (let i = 0; i < count; i++) craterRaw[i] = land(i) ? (CRATER_H[cells[i * 2]] ?? 0) : 0;
  const craterRel = blurWhere(craterRaw, n, land, 1, 2);
  const top = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const reach = Math.max(4, half * 0.5);
  let eMin = 1e9;
  for (let i = 0; i < count; i++) if (land(i)) eMin = Math.min(eMin, edgeSmooth[i]);
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, Math.max(0, edgeSmooth[i] - eMin) / reach); // 0 on the outermost rock, so top and underside meet
    const lump = t * t * (3 - 2 * t); // eases off the rim: no steep stair-stepped cliff
    const relief = land(i) ? craterRel[i] * n * 0.05 + (elev[i] - smooth[i]) * n * 0.15 : 0;
    top[i] = land(i) ? n * 0.1 * lump + relief : 0;
    const c = BIOME_COLORS[cells[i * 2]] ?? BIOME_COLORS[14];
    const f = 0.92 + Math.max(-0.2, Math.min(0.3, relief / (n * 0.1)));
    colors.set([Math.min(1, (c[0] / 255) * f), Math.min(1, (c[1] / 255) * f), Math.min(1, (c[2] / 255) * f)], i * 3);
  }
  const full = (qx: number, qz: number) =>
    qx >= 0 && qz >= 0 && qx < n - 1 && qz < n - 1 && land(qz * n + qx) && land(qz * n + qx + 1) && land((qz + 1) * n + qx) && land((qz + 1) * n + qx + 1);

  // The outline of the rock is a staircase of cells. Slide the outermost vertices onto the smooth
  // contour of a blurred mask, so the silhouette is round instead of toothed.
  let mask = new Float32Array(count);
  for (let i = 0; i < count; i++) mask[i] = land(i) ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const horizontal of [true, false]) {
      const out = new Float32Array(count);
      for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
          let sum = 0;
          for (let d = -3; d <= 3; d++) {
            const [x, z] = horizontal ? [ix + d, iz] : [ix, iz + d];
            sum += x < 0 || z < 0 || x >= n || z >= n ? 0 : mask[z * n + x];
          }
          out[iz * n + ix] = sum / 7;
        }
      }
      mask = out;
    }
  }
  const offX = new Float32Array(count);
  const offZ = new Float32Array(count);
  const at = (x: number, z: number) => mask[Math.min(n - 1, Math.max(0, z)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let i = 0; i < count; i++) {
    if (!land(i) || edge[i] > 3) continue;
    const [ix, iz] = [i % n, Math.floor(i / n)];
    const gx = (at(ix + 1, iz) - at(ix - 1, iz)) / 2;
    const gz = (at(ix, iz + 1) - at(ix, iz - 1)) / 2;
    const g2 = gx * gx + gz * gz;
    if (g2 < 1e-5) continue;
    const k = ((mask[i] - 0.5) / g2) * (edge[i] <= 1 ? 1 : 0.5);
    const step = Math.hypot(gx, gz) * Math.abs(k);
    const lim = step > 2 ? 2 / step : 1;
    offX[i] = -gx * k * lim;
    offZ[i] = -gz * k * lim;
  }
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const vertex = (i: number, y: number, shade: number) => {
    const iz = Math.floor(i / n);
    const ix = i % n;
    pos.push(ix - half + offX[i], y, iz - half + offZ[i]);
    col.push(colors[i * 3] * shade, colors[i * 3 + 1] * shade, colors[i * 3 + 2] * shade);
    return pos.length / 3 - 1;
  };
  const topIdx = new Map<number, number>();
  const T = (i: number) => topIdx.get(i) ?? (topIdx.set(i, vertex(i, top[i], 1)), topIdx.get(i)!);
  // The underside is a separate smooth dome (not the grid, whose staircase outline made teeth):
  // its edge follows the smoothed outline of the rock, and it bulges down like an egg.
  const sample = (wx: number, wz: number) => {
    const fx = Math.min(n - 1.001, Math.max(0, wx + half));
    const fz = Math.min(n - 1.001, Math.max(0, wz + half));
    const [x0, z0] = [Math.floor(fx), Math.floor(fz)];
    const [tx, tz] = [fx - x0, fz - z0];
    const m = (x: number, z: number) => mask[z * n + x];
    return (m(x0, z0) * (1 - tx) + m(x0 + 1, z0) * tx) * (1 - tz) + (m(x0, z0 + 1) * (1 - tx) + m(x0 + 1, z0 + 1) * tx) * tz;
  };
  const K = 120;
  let R = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    const a = (k / K) * Math.PI * 2;
    let r = half * 1.3;
    while (r > 0 && sample(Math.cos(a) * r, Math.sin(a) * r) < 0.5) r -= 0.25;
    R[k] = r;
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      let sum = 0;
      for (let d = -3; d <= 3; d++) sum += R[(k + d + K) % K];
      next[k] = sum / 7;
    }
    R = next;
  }
  // 0 at the edge, 1 at the middle: round, but not vertical at the rim (a vertical rim made a tall band)
  const profile = (f: number) => Math.pow(Math.max(0, 1 - Math.pow(f, 2.2)), 0.8);
  const RIM = 0.4; // the dome ends just outside the top surface, so the curtain between them is short
  const rings = 36;
  const depth = n * 0.42;
  const domeAt = (f: number, k: number) => {
    const a = (k / K) * Math.PI * 2;
    const r = f * (R[k % K] + RIM);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const lumps = 1 + 0.1 * Math.sin(x * 0.33 + 1) * Math.sin(z * 0.29) + 0.06 * f * Math.sin(a * 3 + 0.7);
    const y = -depth * profile(f) * lumps;
    // tint from the nearest bit of rock, darker the deeper it goes
    const ci = Math.min(n - 1, Math.max(0, Math.round(x + half)));
    const cj = Math.min(n - 1, Math.max(0, Math.round(z + half)));
    let best = cj * n + ci;
    if (!land(best)) {
      let d2 = 1e9;
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++) {
          const [px, pz] = [ci + dx, cj + dz];
          if (px < 0 || pz < 0 || px >= n || pz >= n || !land(pz * n + px)) continue;
          if (dx * dx + dz * dz < d2) {
            d2 = dx * dx + dz * dz;
            best = pz * n + px;
          }
        }
    }
    const shade = 0.82 - 0.32 * (1 - Math.pow(1 - f, 2));
    const c = BIOME_COLORS[cells[best * 2]] ?? BIOME_COLORS[14];
    const base = BIOME_COLORS[14];
    const mix = Math.min(1, 0.45 + (1 - f) * 0.5); // towards one plain rock colour, so the pole is not streaky
    pos.push(x, y, z);
    col.push(
      ((c[0] * (1 - mix) + base[0] * mix) / 255) * shade,
      ((c[1] * (1 - mix) + base[1] * mix) / 255) * shade,
      ((c[2] * (1 - mix) + base[2] * mix) / 255) * shade,
    );
    return pos.length / 3 - 1;
  };
  // height of the dome right under any point (used to sew the top's rim onto it)
  const domeRadius = (a: number) => {
    const k = ((a / (Math.PI * 2)) * K + K) % K;
    const k0 = Math.floor(k) % K;
    return mixN(R[k0], R[(k0 + 1) % K], k - Math.floor(k)) + RIM;
  };
  const mixN = (a: number, b: number, t: number) => a + (b - a) * t;
  const domeY = (x: number, z: number) => {
    const f = Math.min(1, Math.hypot(x, z) / domeRadius(Math.atan2(z, x)));
    return -depth * profile(f);
  };
  const tip = domeAt(0, 0);
  for (let qz = 0; qz < n - 1; qz++) {
    for (let qx = 0; qx < n - 1; qx++) {
      if (!full(qx, qz)) continue;
      const a = qz * n + qx;
      const [b, c, d] = [a + 1, a + n, a + n + 1];
      idx.push(T(a), T(c), T(b), T(b), T(c), T(d)); // top, facing up
    }
  }

  const ring: number[][] = [];
  for (let j = 1; j <= rings; j++) {
    const r: number[] = [];
    for (let k = 0; k < K; k++) r.push(domeAt(j / rings, k));
    ring.push(r);
  }
  for (let k = 0; k < K; k++) idx.push(tip, ring[0][k], ring[0][(k + 1) % K]);
  for (let j = 0; j < rings - 1; j++) {
    for (let k = 0; k < K; k++) {
      const [a0, a1, b0, b1] = [ring[j][k], ring[j][(k + 1) % K], ring[j + 1][k], ring[j + 1][(k + 1) % K]];
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  // a thin curtain from every edge of the top surface down onto the dome, so there is no gap
  const baseIdx = new Map<number, number>();
  const D = (i: number) => {
    let v = baseIdx.get(i);
    if (v === undefined) {
      const x = (i % n) - half + offX[i];
      const z = Math.floor(i / n) - half + offZ[i];
      pos.push(x, domeY(x, z) - 0.35, z);
      col.push(colors[i * 3] * 0.7, colors[i * 3 + 1] * 0.7, colors[i * 3 + 2] * 0.7);
      v = pos.length / 3 - 1;
      baseIdx.set(i, v);
    }
    return v;
  };
  const wall = (p: number, q: number) => idx.push(T(p), D(p), T(q), T(q), D(p), D(q));
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n - 1; ix++) {
      if (full(ix, iz - 1) !== full(ix, iz)) wall(iz * n + ix, iz * n + ix + 1);
    }
  }
  for (let iz = 0; iz < n - 1; iz++) {
    for (let ix = 0; ix < n; ix++) {
      if (full(ix - 1, iz) !== full(ix, iz)) wall(iz * n + ix, (iz + 1) * n + ix);
    }
  }
  const rock = new BufferGeometry();
  rock.setAttribute('position', new Float32BufferAttribute(pos, 3));
  rock.setAttribute('color', new Float32BufferAttribute(col, 3));
  rock.setIndex(idx);
  rock.computeVertexNormals();

  const scene = new Scene();
  scene.background = new Color(0x05071a);
  const material = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  scene.add(new Mesh(rock, material));

  // stars on a big sphere around everything
  const starPos: number[] = [];
  for (let k = 0; k < 900; k++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = n * 9;
    const s = Math.sqrt(1 - u * u);
    starPos.push(r * s * Math.cos(a), r * u, r * s * Math.sin(a));
  }
  const stars = new BufferGeometry();
  stars.setAttribute('position', new Float32BufferAttribute(starPos, 3));
  const starMaterial = new PointsMaterial({ color: 0xffffff, size: n * 0.06, sizeAttenuation: true });
  scene.add(new Points(stars, starMaterial));

  scene.add(new HemisphereLight(0xb8c8ff, 0x55556a, 0.9));
  const sun = new DirectionalLight(0xfff4dc, 2.1);
  sun.position.set(-n * 0.9, n * 0.9, -n * 0.4);
  scene.add(sun);
  const fill = new DirectionalLight(0x8fa0d8, 0.9); // soft light from below, so the underside is readable
  fill.position.set(n * 0.6, -n * 0.9, n * 0.5);
  scene.add(fill);

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  stage.appendChild(renderer.domElement);
  renderer.domElement.className = 'viewer-canvas';
  const camera = new PerspectiveCamera(38, 1, 1, n * 30);
  camera.position.set(n * 1.0, n * 0.7, n * 1.1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -n * 0.05, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.8;
  controls.minDistance = n * 0.5;
  controls.maxDistance = n * 3.2;
  controls.update();
  const resize = () => {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  return {
    setAutoRotate(on) {
      controls.autoRotate = on;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      rock.dispose();
      stars.dispose();
      material.dispose();
      starMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
