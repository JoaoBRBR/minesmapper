import { settings } from './settings';

/** True where the Vibration API exists (Android browsers; not iPhone Safari). */
export const vibrationSupported = typeof navigator !== 'undefined' && 'vibrate' in navigator;

function buzz(pattern: number | number[]) {
  if (settings.vibration && vibrationSupported) navigator.vibrate(pattern);
}

export const haptics = {
  flag: () => buzz(18),
  open: () => buzz(10),
  boom: () => buzz([70, 40, 140]),
  win: () => buzz([30, 50, 30, 50, 90]),
  clean: () => buzz(12),
  found: () => buzz([20, 40, 20]),
  oracle: () => buzz(35),
  blocked: () => buzz([25, 40, 25]),
  test: () => buzz(40),
};
