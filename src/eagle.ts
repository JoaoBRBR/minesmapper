// An eagle crosses the menu background in time with the eagle cry in the menu song.
// Its position comes straight from the song clock, so it always stays in step (and
// freezes/hides if the music pauses). Each cry rolls its own dice once per play-through.

import { menuSongClock } from './music';

const urls = import.meta.glob('../art/menu/eagle-*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** Seconds into the menu song where the eagle cries. */
const CRIES = [18, 32, 64, 97];
const CHANCE = 0.5; // later: make it rare
const LEAD = 5; // enters the screen this long before the cry
const TAIL = 4.5; // and leaves this long after it
const FLAP = [0, 1, 2, 1];

type Flight = { dx: number; dy: number; off: number; angle: number };

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
let box: HTMLDivElement | null = null;
let frames: HTMLImageElement[] = [];
const rolls = new Map<number, Flight | null>();
let lastT = 0;
let raf = 0;

function build() {
  box = document.createElement('div');
  box.className = 'eagle';
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  frames = Object.keys(urls)
    .sort()
    .map((k) => {
      const img = new Image();
      img.src = urls[k];
      img.alt = '';
      img.draggable = false;
      box!.append(img);
      return img;
    });
  document.body.append(box);
}

function roll(): Flight | null {
  if (Math.random() >= CHANCE) return null;
  const angle = Math.random() * Math.PI * 2;
  return { dx: Math.cos(angle), dy: Math.sin(angle), off: (Math.random() - 0.5) * 0.5, angle };
}

/** Which cry (if any) the eagle is flying for at song time t. */
function active(t: number): number {
  for (let i = 0; i < CRIES.length; i++) if (t >= CRIES[i] - LEAD && t <= CRIES[i] + TAIL) return i;
  return -1;
}

function hide() {
  if (box) box.hidden = true;
  cancelAnimationFrame(raf);
  raf = 0;
}

function frame() {
  raf = 0;
  const t = bg.hidden ? null : menuSongClock();
  if (t === null) return hide();
  const i = active(t);
  const f = i < 0 ? null : rolls.get(i);
  if (!f || !box) return hide();

  const w = window.innerWidth;
  const h = window.innerHeight;
  const size = Math.max(70, Math.min(150, w * 0.12));
  const p = (t - (CRIES[i] - LEAD)) / (LEAD + TAIL); // 0..1 across the flight
  const reach = Math.hypot(w, h) + size * 2;
  const bob = Math.sin(t * 2.2) * 14;
  const px = -f.dy; // perpendicular
  const py = f.dx;
  const along = (p - 0.5) * reach;
  const side = f.off * Math.min(w, h) + bob;
  const x = w / 2 + f.dx * along + px * side;
  const y = h / 2 + f.dy * along + py * side;

  box.hidden = false;
  box.style.width = `${size}px`;
  box.style.transform = `translate(${x - size / 2}px, ${y - size / 4}px) rotate(${f.angle}rad)`;
  const shown = FLAP[Math.floor(t * 6) % FLAP.length] % frames.length;
  frames.forEach((img, k) => (img.style.visibility = k === shown ? 'visible' : 'hidden'));
  raf = requestAnimationFrame(frame);
}

function tick() {
  const t = bg.hidden ? null : menuSongClock();
  if (t === null) return hide();
  if (t < lastT - 1) rolls.clear(); // the song started over
  lastT = t;
  const i = active(t);
  if (i < 0) return;
  if (!rolls.has(i)) rolls.set(i, roll());
  if (rolls.get(i) && !raf) raf = requestAnimationFrame(frame);
}

export function initEagle() {
  if (!Object.keys(urls).length) return;
  build();
  setInterval(tick, 250);
}
