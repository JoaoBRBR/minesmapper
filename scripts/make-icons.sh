#!/usr/bin/env bash
# Regenerates the PNG app icons in public/ from the SVG sources (needs headless Chromium).
# Sources are the hand-made SVGs in art/app/; they are copied into public/ first.
#   art/app/icon.svg           -> icon-192.png, icon-512.png   (rounded, transparent corners)
#   art/app/icon-maskable.svg  -> icon-maskable-512.png, apple-touch-icon.png (full bleed)
#   art/app/favicon.svg        -> favicon.svg
set -euo pipefail
cd "$(dirname "$0")/../public"
cp ../art/app/icon.svg ../art/app/icon-maskable.svg ../art/app/favicon.svg .
CHROME="${CHROME:-chromium}"
tmp="$(mktemp -d)"
render() { # <svg> <size> <out>
  cat > "$tmp/page.html" <<HTML
<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block}</style>
<img src="file://$PWD/$1" width="$2" height="$2">
HTML
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$2,$2" --screenshot="$PWD/$3" "file://$tmp/page.html" >/dev/null 2>&1
}
render icon.svg 192 icon-192.png
render icon.svg 512 icon-512.png
render icon-maskable.svg 512 icon-maskable-512.png
render icon-maskable.svg 180 apple-touch-icon.png
rm -rf "$tmp"
ls -l icon-*.png apple-touch-icon.png
