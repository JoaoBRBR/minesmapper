import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Files copied verbatim from public/ that the offline cache should hold.
const PUBLIC_FILES = [
  'manifest.webmanifest',
  'favicon.svg',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

/** Emits `sw.js` with the exact list of built files to precache and a content-based version. */
function serviceWorker(): Plugin {
  return {
    name: 'minefield-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((name) => name !== 'sw.js');
      const hash = createHash('sha1');
      for (const name of built.sort()) {
        const item = bundle[name];
        hash.update(name);
        hash.update(item.type === 'chunk' ? item.code : item.source);
      }
      const version = hash.digest('hex').slice(0, 10);
      // the music is streamed when played, not downloaded with the app
      const precache = ['./', ...built.filter((n) => !n.endsWith('.m4a')), ...PUBLIC_FILES];
      const source = readFileSync('pwa/sw.js', 'utf8')
        .replaceAll('__VERSION__', () => version)
        .replaceAll('__PRECACHE__', () => JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so the build works from any path (e.g. GitHub Pages' /<repo>/).
  base: './',
  plugins: [serviceWorker()],
});
