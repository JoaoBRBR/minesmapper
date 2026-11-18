// Two languages: English (the text the game is written in) and Portuguese. Texts are translated
// where they reach the page (see icons.ts), by looking them up in src/lang/pt.ts, so the code can
// keep writing plain English. Changing the language reloads the page.

import { PATTERNS, PT } from './lang/pt';

export type Lang = 'en' | 'pt';
const KEY = 'minefield.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'pt') return saved;
  } catch {
    /* fall through to the browser language */
  }
  return (navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith('pt')) ? 'pt' : 'en';
}

/** The language of this page load. */
export const lang: Lang = detect();

export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the choice just will not stick */
  }
  location.reload();
}

const cache = new Map<string, string>();

function core(s: string): string | null {
  const hit = PT[s];
  if (hit !== undefined) return hit;
  for (const [re, fn] of PATTERNS) {
    const m = s.match(re);
    if (m) return fn(m, tr);
  }
  return null;
}

/** The text in the page's language (unknown texts come back unchanged). */
export function tr(s: string): string {
  if (lang === 'en' || !s) return s;
  const cached = cache.get(s);
  if (cached !== undefined) return cached;
  const lead = /^\s*/.exec(s)![0];
  const trail = /\s*$/.exec(s)![0];
  const body = s.slice(lead.length, s.length - trail.length);
  let out = core(body) ?? core(body.replace(/\s+/g, ' '));
  if (out === null) {
    // "a · b · c": translate the pieces
    const parts = body.replace(/\s+/g, ' ').split(' · ');
    if (parts.length > 1) {
      const done = parts.map((p) => core(p) ?? p);
      if (done.some((p, i) => p !== parts[i])) out = done.join(' · ');
    }
  }
  const result = out === null ? s : lead + out + trail;
  if (cache.size < 2000) cache.set(s, result);
  return result;
}

/** Sets the document language and title. */
export function initI18n() {
  document.documentElement.lang = lang;
  document.title = tr(document.title);
}
