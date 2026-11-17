// Applies the look-and-feel settings (paper tone, number style) to the canvas and the page.

import { bumpVisuals, setNumberStyle, setPaperTone } from './render';
import { onSettingsChange, settings } from './settings';

function apply() {
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
