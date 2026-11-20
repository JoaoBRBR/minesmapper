#!/usr/bin/env python3
"""Makes the PNG app icons in public/ from art/app/icon.png (a square, 1000 px or bigger).

  icon.png -> icon-192.png, icon-512.png        (the normal app icon)
  icon.png -> icon-maskable-512.png             (same picture; Android crops it to a circle or
                                                 squircle, and the mine sits well inside the safe zone)
  icon.png -> apple-touch-icon.png (180 px)     (iPhone home screen; no transparency)
  icon.png -> favicon.png (32 px) and favicon-64.png (browser tab)

The picture has a transparent background, so the normal icons and the browser tab icon stay transparent.
The maskable icon and the iPhone icon need a solid background (Android and iPhone fill any gap), so they get
the parchment colour below.

Needs Pillow:  pip install pillow
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Image.open(root / "art/app/icon.png").convert("RGBA")
out = root / "public"

PAPER = (241, 228, 195)  # background behind the picture for the icons that must be solid

def save(size: int, name: str, solid: bool = False):
    im = src.resize((size, size), Image.LANCZOS)
    if solid:
        bg = Image.new("RGB", (size, size), PAPER)
        bg.paste(im, mask=im.getchannel("A"))
        im = bg
    im.save(out / name, optimize=True)
    print(name, size)

save(192, "icon-192.png")
save(512, "icon-512.png")
save(512, "icon-maskable-512.png", solid=True)
save(180, "apple-touch-icon.png", solid=True)
save(32, "favicon.png")
save(64, "favicon-64.png")
