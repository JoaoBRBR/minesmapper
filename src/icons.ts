// All pictures come from the SVG files in art/. Map glyphs are rasterised to small canvases (cached per size
// step, so each stamp on the map is a cheap 1:1 copy); interface icons replace emoji and symbols in text.

const uiUrls = import.meta.glob(['../art/ui/*.svg', '../art/map/*.svg'], { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const mapOnly = import.meta.glob('../art/map/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const nameOf = (path: string) => path.replace(/^.*\//, '').replace(/\.svg$/, '');
const uiArt = new Map(Object.entries(uiUrls).map(([p, u]) => [nameOf(p), u]));

const mapImages = new Map<string, HTMLImageElement>();
const sized = new Map<string, HTMLCanvasElement>();

/** Resolves when every map glyph is decoded and ready to draw. */
export const artReady = Promise.all(
  Object.entries(mapOnly).map(async ([path, url]) => {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      mapImages.set(nameOf(path), img);
    } catch {
      /* the glyph is simply not drawn */
    }
  }),
);

export type Glyph = 'flag' | 'mine' | 'oracle-glass' | 'ice-crystal' | 'treasure-x';

function glyphAt(name: Glyph, px: number): CanvasImageSource | undefined {
  const img = mapImages.get(name);
  if (!img) return undefined;
  // round the wanted size up to a power of two (16..256) so only a few copies are ever made
  const step = Math.min(256, Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, px)))));
  const key = `${name}@${step}`;
  let c = sized.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = step;
    c.getContext('2d')!.drawImage(img, 0, 0, step, step);
    sized.set(key, c);
  }
  return c;
}

/** Draws a map glyph into the square with top-left (x, y) and side `size` (screen pixels). */
export function drawGlyph(ctx: CanvasRenderingContext2D, name: Glyph, x: number, y: number, size: number) {
  const g = glyphAt(name, size * (window.devicePixelRatio || 1));
  if (g) ctx.drawImage(g, x, y, size, size);
}

// ---- interface icons in text ----

/** Text symbol -> icon file (optionally rotated, in quarter turns clockwise from "right"). */
const TOKENS: Record<string, [string, number?]> = {
  '🚩': ['flag'], '💣': ['mine'], '✨': ['oracle-glass'], '❄': ['ice-crystal'], '⛏': ['pickaxe'],
  '🏝': ['island'], '♾': ['endless'], '📏': ['distance'], '🎯': ['target'], '🧭': ['compass'],
  '📊': ['progress'], '⌖': ['center'], '☰': ['menu'], '🌍': ['globe-3d'], '👁': ['eye'],
  '💥': ['boom'], '🔒': ['lock'], '🏆': ['trophy'], '📅': ['calendar'], '🗺': ['adventure-map'],
  '⚙': ['settings'], '⬇': ['install'], '🎲': ['dice'], '🗑': ['trash'], '🔥': ['flame'],
  '♪': ['music'], '♫': ['music-off'], '🗂': ['worlds'], '🔊': ['volume'], '🔇': ['volume-off'], '📳': ['vibrate'], '📴': ['vibrate-off'], '🐙': ['github'], '☀': ['sun'], '☾': ['moon'], '✓': ['check'], '✕': ['cross'], '↻': ['restart'], '▶': ['play-next'],
  '♥': ['heart-full'], '♡': ['heart-empty'], '★': ['star-full'], '☆': ['star-empty'],
  '→': ['arrow-right'], '←': ['arrow-back'], '↓': ['arrow-right', 1], '↑': ['arrow-right', 3],
};
const PATTERN = new RegExp(`(${Object.keys(TOKENS).join('|')})\\uFE0F?`, 'u');
const PATTERN_G = new RegExp(PATTERN.source, 'gu');

function makeIcon(token: string): HTMLImageElement | null {
  const [name, turns] = TOKENS[token];
  const url = uiArt.get(name);
  if (!url) return null;
  const img = document.createElement('img');
  img.className = turns ? `ic r${turns}` : 'ic';
  img.src = url;
  img.alt = '';
  img.draggable = false;
  return img;
}

function iconizeText(node: Text) {
  const text = node.data;
  if (!PATTERN.test(text)) return;
  const frag = document.createDocumentFragment();
  let last = 0;
  let made = 0;
  for (const m of text.matchAll(PATTERN_G)) {
    const icon = makeIcon(m[1]);
    if (m.index! > last) frag.append(text.slice(last, m.index));
    frag.append(icon ?? m[0]);
    if (icon) made++;
    last = m.index! + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  if (made) node.replaceWith(frag); // never swap a node for an identical one, or the observer would loop
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);

function iconize(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement && !SKIP.has(root.parentElement.tagName)) iconizeText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || SKIP.has((root as Element).tagName)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!SKIP.has(n.parentElement!.tagName)) found.push(n as Text);
  }
  for (const t of found) iconizeText(t);
}

/** Replaces symbols in the page now and in everything that is added or re-worded later. */
export function installIcons() {
  iconize(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') iconize(r.target);
      else r.addedNodes.forEach((n) => iconize(n));
    }
  }).observe(document.body, { childList: true, characterData: true, subtree: true });
}

/** URL of an icon or map picture by file name (without .svg), for places that build their own markup. */
export const artUrl = (name: string) => uiArt.get(name) ?? '';
