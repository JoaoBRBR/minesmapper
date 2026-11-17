// 3D relief view of a finished island (three.js, loaded lazily).
//
// The island is a heightfield: smooth biome colours blended between cells, real elevation, a
// translucent block of sea around it with the sea floor showing through, and a dark skirt so it
// reads like a diorama on the map table. Drag to rotate, scroll or pinch to zoom.

import {
  BoxGeometry,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BIOME_COLORS } from './render';

export interface IslandData {
  size: number;
  /** `[biome, elevation]` per cell, row-major from the north-west corner (World.island_snapshot). */
  cells: Uint8Array;
}

export interface Viewer {
  dispose(): void;
  setAutoRotate(on: boolean): void;
}

const SEA = 107 / 255; // matches crate/src/terrain.rs (0.42)
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function openIsland(stage: HTMLElement, data: IslandData): Viewer {
  const { size: n, cells } = data;
  const heightScale = n * 0.22; // how tall the highest peaks stand
  const depthScale = n * 0.3; // how deep the sea floor sinks
  const seaDepth = SEA * depthScale; // the sea block reaches the deepest floor
  const floorY = -seaDepth - n * 0.03;

  // --- terrain ---------------------------------------------------------------------------------
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const half = (n - 1) / 2;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const biome = cells[i * 2];
      const e = cells[i * 2 + 1] / 255;
      const land = e >= SEA;
      const y = land ? ((e - SEA) / (1 - SEA)) * heightScale : (e - SEA) * depthScale;
      positions.set([ix - half, y, iz - half], i * 3);

      let r: number;
      let g: number;
      let b: number;
      if (land) {
        const c = BIOME_COLORS[biome] ?? BIOME_COLORS[6];
        // a touch brighter with altitude
        const f = 0.92 + 0.16 * ((e - SEA) / (1 - SEA));
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
