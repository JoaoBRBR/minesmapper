#!/usr/bin/env python3
"""Makes the PNG app icons in public/ from art/app/icon.png (a square, 1000 px or bigger).

  icon.png -> icon-192.png, icon-512.png        (the normal app icon)
  icon.png -> icon-maskable-512.png             (same picture; Android crops it to a circle or
                                                 squircle, and the mine sits well inside the safe zone)
  icon.png -> apple-touch-icon.png (180 px)     (iPhone home screen; no transparency)
  icon.png -> favicon.png (32 px) and favicon-64.png (browser tab)

Needs Pillow:  pip install pillow
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Image.open(root / "art/app/icon.png").convert("RGBA")
out = root / "public"

def save(size: int, name: str, opaque: bool = False):
    im = src.resize((size, size), Image.LANCZOS)
    if opaque:
        bg = Image.new("RGB", (size, size), (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A"))
        im = bg
    im.save(out / name, optimize=True)
    print(name, size)

save(192, "icon-192.png")
save(512, "icon-512.png")
save(512, "icon-maskable-512.png")
save(180, "apple-touch-icon.png", opaque=True)
save(32, "favicon.png")
save(64, "favicon-64.png")
