// Applies the look-and-feel settings (paper tone, number style) to the canvas and the page.

import { bumpVisuals, setNumberStyle, setPaperTone } from './render';
import { onSettingsChange, settings } from './settings';

/**
 * The paper grain used to be an SVG with a turbulence filter, which phones re-rasterise whenever
 * anything under it repaints (every switch you flip). A small pre-drawn PNG costs nothing.
 */
function makeGrain(rgb: [number, number, number], gain: number, bias: number): string {
  const size = 220;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return 'none';
  const img = g.createImageData(size, size);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < size * size; i++) {
    const n = 0.5 + (rnd() - 0.5) * 0.55;
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = Math.max(0, Math.min(255, (gain * n + bias) * 255));
  }
  g.putImageData(img, 0, 0);
  return `url(${c.toDataURL('image/png')})`;
}
let grainLight = '';
let grainDark = '';

function apply() {
  if (!grainLight) {
    grainLight = makeGrain([102, 71, 33], 0.3, -0.06);
    grainDark = makeGrain([235, 204, 148], 0.22, -0.04);
  }
  document.documentElement.style.setProperty('--grain', settings.darkPaper ? grainDark : grainLight);
  setPaperTone(settings.darkPaper);
  setNumberStyle(settings.numberStyle);
  document.documentElement.dataset.paper = settings.darkPaper ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', settings.darkPaper ? '#2e2620' : '#e3d2a4');
}

export function initTheme() {
  apply();
  onSettingsChange(apply);
  // The handwriting font loads asynchronously; redraw once it is ready.
  for (const font of ['Cinzel', 'Kalam']) {
    void document.fonts?.load(`700 20px ${font}`).then(bumpVisuals, () => {});
  }
}
