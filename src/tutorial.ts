// A short animated walkthrough the first time Adventure level 1 is opened. It can be skipped at any
// step, and it is only ever shown once per device.

import { artUrl } from './icons';

const KEY = 'minefield.tutorial.done';

function done() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

function finish() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* it may show again next time */
  }
}

interface Step {
  title: string;
  text: string;
  stage: () => string;
}

const cells = (n: number, extra: (i: number) => string = () => '') =>
  Array.from({ length: n }, (_, i) => `<i class="tc ${extra(i)}"></i>`).join('');

const STEPS: Step[] = [
  {
    title: 'Welcome, cartographer',
    text: 'Tap a square to open it. Squares that touch no mine open on their own, and spread out.',
    stage: () =>
      `<div class="tip-grid tut tut-open">${cells(9, (i) => (i === 4 ? 'tut-c' : [0, 1, 2, 3, 5, 6, 7, 8].includes(i) ? 'tut-n' : ''))}
        <img class="tut-tool tut-tap" src="${artUrl('pickaxe')}" alt="" /></div>`,
  },
  {
    title: 'Read the numbers',
    text: 'A number tells how many mines touch that square, counting all 8 neighbours.',
    stage: () =>
      `<div class="tip-grid tut tut-num">${cells(9, (i) => (i === 4 ? 'tut-open-now' : ''))}
        <b class="tut-digit">2</b>
        <img class="tut-mine m1" src="${artUrl('mine')}" alt="" />
        <img class="tut-mine m2" src="${artUrl('mine')}" alt="" /></div>`,
  },
  {
    title: 'Mark the mines',
    text: 'When you know where a mine is, flag it: press and hold, or use the switch at the bottom right.',
    stage: () =>
      `<div class="tip-grid tut tut-flag">${cells(9)}
        <i class="tut-ring"></i>
        <img class="tut-flagimg" src="${artUrl('flag')}" alt="" /></div>`,
  },
  {
    title: 'Mind your hearts',
    text: 'Stepping on a mine costs a heart. Lose them all and the level is over, so think before you tap.',
    stage: () =>
      `<div class="tut-hearts">
        <img src="${artUrl('heart-full')}" alt="" /><img src="${artUrl('heart-full')}" alt="" />
        <span class="tut-lose"><img class="full" src="${artUrl('heart-full')}" alt="" /><img class="empty" src="${artUrl('heart-empty')}" alt="" /></span>
      </div>`,
  },
  {
    title: 'Clear every safe square to win',
    text: 'Open every square that has no mine. Stars depend on how few mistakes you make.',
    stage: () =>
      `<div class="tut-stars">${[0, 1, 2]
        .map((i) => `<span><img class="empty" src="${artUrl('star-empty')}" alt="" /><img class="full s${i}" src="${artUrl('star-full')}" alt="" /></span>`)
        .join('')}</div>`,
  },
];

/** Shows the walkthrough once. Returns without doing anything if it was seen or skipped before. */
export function maybeShowTutorial() {
  if (done()) return;
  const box = document.querySelector<HTMLElement>('#tutorial')!;
  const title = document.querySelector<HTMLElement>('#tut-title')!;
  const stage = document.querySelector<HTMLElement>('#tut-stage')!;
  const text = document.querySelector<HTMLElement>('#tut-text')!;
  const dots = document.querySelector<HTMLElement>('#tut-dots')!;
  const next = document.querySelector<HTMLButtonElement>('#tut-next')!;
  const skip = document.querySelector<HTMLButtonElement>('#tut-skip')!;
  let i = 0;
  const close = () => {
    finish();
    box.hidden = true;
  };
  const show = () => {
    const s = STEPS[i];
    title.textContent = s.title;
    text.textContent = s.text;
    stage.innerHTML = s.stage();
    dots.innerHTML = STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('');
    next.textContent = i === STEPS.length - 1 ? "Let's go" : 'Next';
  };
  next.onclick = () => {
    if (i >= STEPS.length - 1) return close();
    i++;
    show();
  };
  skip.onclick = close;
  show();
  box.hidden = false;
}
