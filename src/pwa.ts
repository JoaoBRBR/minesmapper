// Progressive-web-app glue: service worker registration, update notice, install prompt.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Registers the service worker (production builds only, so dev reloads stay honest). */
export function registerServiceWorker(onUpdateReady: () => void) {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const register = () =>
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            // "installed" with an existing controller means this is an update, not the first install.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady();
          });
        });
        // Look for a new version whenever the app comes back to the foreground.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => {});
        });
      })
      .catch((err) => console.warn('Service worker registration failed', err));
  // The app boots after async work, so the page may already have finished loading.
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

/**
 * Wires an "Install app" button that only appears when the browser offers installation
 * (Chrome/Edge/Android), plus a how-to line for iPhone/iPad where the browser has no prompt.
 */
export function setupInstall(button: HTMLButtonElement, iosHint: HTMLElement) {
  let deferred: BeforeInstallPromptEvent | null = null;
  button.hidden = true;
  iosHint.hidden = !(isIos() && !isStandalone());

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    button.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    const prompt = deferred;
    deferred = null;
    button.hidden = true;
    await prompt.prompt();
    await prompt.userChoice.catch(() => {});
  });
}
