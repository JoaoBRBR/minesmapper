// Debug mode: a hidden switch for testing. Press Ctrl+Alt+Shift+D to turn it on or off.
// It unlocks every level and the Space realm, allows the 3D view on every island, and shows a
// live panel (fps, frame times, camera, world) on the screen. It is not in any menu or setting.
const KEY = 'minefield.debug';

let on = false;
try {
  on = sessionStorage.getItem(KEY) === '1';
} catch {
  /* private mode: stays off after a reload */
}
const listeners: Array<(on: boolean) => void> = [];

export const isDebug = () => on;

/** Test switch (Ctrl+Alt+Shift+V): hides the vintage look (paper grain, frontier stain, aged page edge). */
let vintageOff = false;
export const isVintageOff = () => vintageOff;
export const onDebugChange = (fn: (on: boolean) => void) => listeners.push(fn);

// --- frame statistics ----------------------------------------------------------------
let lastNow = 0;
let frames = 0;
let winStart = 0;
let worst = 0;
let sum = 0;
let fps = 0;
let avg = 0;
let max = 0;
let renders = 0;
let renderMs = 0;
let renderMsLast = 0;
let rendersPerSec = 0;
let longFrames = 0;
let extra: () => string[] = () => [];
let panel: HTMLPreElement | null = null;

/** The game adds its own lines (camera, world, ...). */
export const setDebugInfo = (fn: () => string[]) => (extra = fn);

/** Call once per animation frame. */
export function debugFrame(now: number) {
  if (!on) {
    lastNow = 0;
    return;
  }
  if (lastNow) {
    const dt = now - lastNow;
    frames++;
    sum += dt;
    if (dt > worst) worst = dt;
    if (dt > 50) longFrames++;
  }
  lastNow = now;
  if (!winStart) winStart = now;
  if (now - winStart >= 500) {
    const secs = (now - winStart) / 1000;
    fps = frames / secs;
    avg = frames ? sum / frames : 0;
    max = worst;
    rendersPerSec = renders / secs;
    renderMsLast = renders ? renderMs / renders : 0;
    frames = sum = worst = renders = renderMs = 0;
    winStart = now;
    paint();
  }
}

/** Time one redraw of the map. */
export function debugRender<T>(fn: () => T): T {
  if (!on) return fn();
  const t0 = performance.now();
  const r = fn();
  renderMs += performance.now() - t0;
  renders++;
  return r;
}

function paint() {
  if (!panel) return;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const lines = [
    `DEBUG  ${fps.toFixed(0)} fps · ${avg.toFixed(1)} ms (worst ${max.toFixed(0)})`,
    `redraw ${renderMsLast.toFixed(1)} ms · ${rendersPerSec.toFixed(0)}/s · long frames ${longFrames}`,
    ...(mem ? [`JS heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`] : []),
    `${innerWidth}×${innerHeight} @${devicePixelRatio}x${vintageOff ? ' · VINTAGE OFF' : ''}`,
    ...extra(),
  ];
  panel.textContent = lines.join('\n');
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('pre');
  panel.id = 'debug-panel';
  document.body.appendChild(panel);
  return panel;
}

export function setDebug(next: boolean) {
  on = next;
  try {
    sessionStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* ignore */
  }
  document.body.classList.toggle('debug', next);
  if (!next && vintageOff) {
    vintageOff = false;
    document.body.classList.remove('novintage');
  }
  if (next) {
    ensurePanel().hidden = false;
    winStart = 0;
    longFrames = 0;
    paint();
  } else if (panel) panel.hidden = true;
  for (const fn of listeners) fn(next);
}

export function initDebug(notify: (msg: string) => void) {
  if (on) setDebug(true);
  window.addEventListener('keydown', (e) => {
    if (on && e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      vintageOff = !vintageOff;
      document.body.classList.toggle('novintage', vintageOff);
      notify(vintageOff ? '🛠 Vintage look OFF (grain, stain, page edge)' : '🛠 Vintage look on');
      return;
    }
    if (!(e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyD')) return;
    e.preventDefault();
    setDebug(!on);
    notify(on ? '🛠 Debug mode ON — all levels, Space and 3D unlocked' : '🛠 Debug mode off');
  });
}
