// A creature crosses the menu background in time with the menu song: an eagle at the eagle
// cries of the normal menu song, a UFO in the space song. Its position comes straight from
// the song clock, so it always stays in step (and hides if the music pauses). Each cue rolls
// its own dice once per play-through.

import { songClock } from './music';
import { MENU_TRACK, SECRET_TRACK } from './tracks';

const urls = import.meta.glob('../art/menu/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const urlsOf = (prefix: string) =>
  Object.keys(urls)
    .filter((k) => k.split('/').pop()!.startsWith(prefix))
    .sort()
    .map((k) => urls[k]);

interface Critter {
  track: string;
  cls: string;
  files: string;
  /** Seconds into the song where it should be on screen. */
  cues: number[];
  chance: number; // later: make it rare
  lead: number; // enters the screen this long before the cue
  tail: number; // and leaves this long after it
  flap: number[]; // frame order (one entry for no animation)
  /** Eagles turn to face where they fly; the UFO stays level and just crosses sideways. */
  turns: boolean;
}

const CRITTERS: Critter[] = [
  { track: MENU_TRACK, cls: 'eagle', files: 'eagle-', cues: [18, 32, 64, 97], chance: 0.1, lead: 5, tail: 4.5, flap: [0, 1, 2, 1], turns: true },
  { track: SECRET_TRACK, cls: 'ufo', files: 'ufo', cues: [10], chance: 0.1, lead: 5, tail: 5, flap: [0], turns: false },
];

type Flight = { dx: number; dy: number; off: number; angle: number };

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
interface Live {
  c: Critter;
  box: HTMLDivElement;
  frames: HTMLImageElement[];
  rolls: Map<number, Flight | null>;
}
const live: Live[] = [];
let lastT = 0;
let lastTrack = '';
let raf = 0;

function build(c: Critter): Live | null {
  const srcs = urlsOf(c.files);
  if (!srcs.length) return null;
  const box = document.createElement('div');
  box.className = `menu-critter ${c.cls}`;
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  const frames = srcs.map((src) => {
    const img = new Image();
    img.src = src;
    img.alt = '';
    img.draggable = false;
    box.append(img);
    return img;
  });
  document.body.append(box);
  return { c, box, frames, rolls: new Map() };
}

function roll(c: Critter): Flight | null {
  if (Math.random() >= c.chance) return null;
  const angle = c.turns ? Math.random() * Math.PI * 2 : (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.5;
  return { dx: Math.cos(angle), dy: Math.sin(angle), off: (Math.random() - 0.5) * 0.5, angle: c.turns ? angle : 0 };
}

/** Which cue (if any) the creature is flying for at song time t. */
function active(c: Critter, t: number): number {
  for (let i = 0; i < c.cues.length; i++) if (t >= c.cues[i] - c.lead && t <= c.cues[i] + c.tail) return i;
  return -1;
}

function hideAll() {
  for (const l of live) l.box.hidden = true;
  cancelAnimationFrame(raf);
  raf = 0;
}

function now() {
  if (bg.hidden) return null;
  return songClock();
}

function frame() {
  raf = 0;
  const clock = now();
  const l = clock && live.find((x) => x.c.track === clock.track);
  if (!clock || !l) return hideAll();
  const { c, box, frames } = l;
  const t = clock.t;
  const i = active(c, t);
  const f = i < 0 ? null : l.rolls.get(i);
  for (const o of live) if (o !== l) o.box.hidden = true;
  if (!f) {
    box.hidden = true;
    return;
  }

  const w = window.innerWidth;
  const h = window.innerHeight;
  const size = Math.max(70, Math.min(150, w * 0.12));
  const p = (t - (c.cues[i] - c.lead)) / (c.lead + c.tail); // 0..1 across the flight
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
  const shown = c.flap[Math.floor(t * 6) % c.flap.length] % frames.length;
  frames.forEach((img, k) => (img.style.visibility = k === shown ? 'visible' : 'hidden'));
  raf = requestAnimationFrame(frame);
}

function tick() {
  const clock = now();
  const l = clock && live.find((x) => x.c.track === clock.track);
  if (!clock || !l) return hideAll();
  if (clock.track !== lastTrack || clock.t < lastT - 1) for (const o of live) o.rolls.clear(); // new song / started over
  lastTrack = clock.track;
  lastT = clock.t;
  const i = active(l.c, clock.t);
  if (i < 0) return;
  if (!l.rolls.has(i)) l.rolls.set(i, roll(l.c));
  if (l.rolls.get(i) && !raf) raf = requestAnimationFrame(frame);
}

export function initEagle() {
  for (const c of CRITTERS) {
    const l = build(c);
    if (l) live.push(l);
  }
  if (live.length) setInterval(tick, 250);
}
