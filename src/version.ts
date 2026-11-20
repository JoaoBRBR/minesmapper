// The game version, shown bottom right next to the GitHub button.
// Format 0.N.n: N = number of feature topics, n = changes made within the latest topic.
// The version comes from package.json, where it is set by hand.

declare const __APP_VERSION__: string;

export const APP_VERSION = __APP_VERSION__;

export function initVersion() {
  const el = document.querySelector<HTMLSpanElement>('#app-version');
  if (el) el.textContent = `v${APP_VERSION}`;
}
