// A short how-to the first time each power-up is armed: a looping mini animation and one sentence.
import { artUrl } from './icons';

export type PowerKind = 'oracle' | 'ice';

const KEY = (k: PowerKind) => `minefield.tip.${k}`;

function seen(k: PowerKind) {
  try {
    return localStorage.getItem(KEY(k)) === '1';
  } catch {
    return true;
  }
}

function remember(k: PowerKind) {
  try {
    localStorage.setItem(KEY(k), '1');
  } catch {
    /* fine: the tip may show again */
  }
}

const TEXT: Record<PowerKind, { title: string; text: string }> = {
  oracle: {
    title: 'The oracle',
    text: 'Tap a hidden square next to explored ground and the glass reveals the truth: a safe square opens, a mine gets a flag. Use it where you would have to guess.',
  },
  ice: {
    title: 'The ice clearer',
    text: 'Tap a lake and the whole stretch of water turns see-through, so you can spot the mines underneath.',
  },
};

function stage(kind: PowerKind): string {
  const glass = artUrl('oracle-glass');
  const flag = artUrl('flag');
  const crystal = artUrl('ice-crystal');
  const mine = artUrl('mine');
  if (kind === 'oracle') {
    const cells = Array.from({ length: 6 }, (_, i) => `<i class="tc${i === 4 ? ' target' : ''}"></i>`).join('');
    return `<div class="tip-grid">${cells}
      <img class="tip-flag" src="${flag}" alt="" />
      <img class="tip-tool" src="${glass}" alt="" /></div>`;
  }
  const cells = Array.from({ length: 6 }, (_, i) => `<i class="tc water${i === 4 ? ' target' : ''}"></i>`).join('');
  return `<div class="tip-grid ice">${cells}
    <img class="tip-mine" src="${mine}" alt="" />
    <img class="tip-tool" src="${crystal}" alt="" /></div>`;
}

/** Shows the tip once per power-up and device. */
export function maybeShowTip(kind: PowerKind) {
  if (seen(kind)) return;
  remember(kind);
  const box = document.querySelector<HTMLElement>('#pu-tip')!;
  document.querySelector('#pu-tip-title')!.textContent = TEXT[kind].title;
  document.querySelector('#pu-tip-text')!.textContent = TEXT[kind].text;
  document.querySelector('#pu-tip-stage')!.innerHTML = stage(kind);
  box.hidden = false;
  const ok = document.querySelector<HTMLButtonElement>('#pu-tip-ok')!;
  ok.onclick = () => (box.hidden = true);
}
