// Desktop only: the mouse pointer is a feather. Phones and tablets have no mouse, so they keep
// their own behaviour. The picture is an art/ui SVG (its tip is the top-left corner).

const cursorUrls = import.meta.glob('../art/ui/cursor-feather.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function initCursor() {
  const url = Object.values(cursorUrls)[0];
  if (!url || !matchMedia('(pointer: fine)').matches) return;
  const style = document.createElement('style');
  style.textContent = `@media (pointer: fine) {
  html, body, button, a, input, select, textarea, label, [role='button'] {
    cursor: url("${url}") 3 3, auto !important;
  }
}`;
  document.head.append(style);
}
