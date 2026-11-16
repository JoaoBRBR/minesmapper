#!/usr/bin/env bash
# Regenerates the PNG app icons in public/ from the SVG sources (needs headless Chromium).
#   public/icon.svg           -> icon-192.png, icon-512.png   (rounded, transparent corners)
#   public/icon-maskable.svg  -> icon-maskable-512.png, apple-touch-icon.png (full bleed)
set -euo pipefail
cd "$(dirname "$0")/../public"
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
