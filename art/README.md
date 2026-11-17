# Art for Mine's Mapper

Everything image-related in the game lives here, as **SVG**. The files you find now are simple stand-ins
that copy the current look: redraw each one in your own style, keep the file name, and send the folder back.
Open `index.html` in a browser to see all of them at once.

## Format

- **SVG** for everything. It is tiny (usually under 2 KB), stays sharp at any zoom, and one file serves every screen.
- The only PNGs are the four app-icon sizes the phone needs (192, 512, maskable 512, 180). You do not draw
  those: `npm run icons` makes them from the three SVGs in `app/`.
- Numbers on the map and all other text stay as fonts, so they are not in this folder.

## Rules for drawing

1. Keep the **viewBox** shown in the table (`0 0 64 64`, `0 0 48 48`, `0 0 512 512`) and draw inside it.
2. **Transparent background**, except the app icons, which have their own.
3. No text: turn letters into outlines (paths). No embedded bitmaps (`<image>`), no blur or drop-shadow
   filters (they are slow on the map canvas), and avoid hundreds of tiny nodes.
4. Colours are yours. The map glyphs sit on parchment, a dark paper theme and an icy theme, so pick
   colours with a dark outline that stays readable on all three.
5. Map glyphs (`map/`) are drawn on **one square of the map**, so leave a little margin and keep the picture
   centred. They are shown from about 10 px to 60 px wide: make them bold, not detailed.
6. The mine and the flag are the most seen pictures. Give them the clearest shapes.
7. Interface icons (`ui/`) are shown at 16-32 px next to text. Use thick, simple strokes.

## Files

| File | Size (viewBox) | Where it is used |
|---|---|---|
| `map/flag.svg` | 64×64 | A flag placed on a hidden square (also the flag-mode button and the 🚩 counter). |
| `map/mine.svg` | 64×64 | A mine on the map (after a loss or when a heart is lost). Also used small as the mine counter (💣). The red square under an exploded mine is drawn by the game. |
| `map/oracle-star.svg` | 64×64 | The oracle power-up under a revealed safe square, and the Oracle button. |
| `map/ice-crystal.svg` | 64×64 | The ice-clearer power-up under a revealed safe square, and the Ice clearer button. |
| `map/treasure-x.svg` | 64×64 | The X on the treasure levels. |
| `ui/heart-full.svg` | 48×48 | A heart you still have (HUD). |
| `ui/heart-empty.svg` | 48×48 | A heart you lost (HUD). |
| `ui/star-full.svg` | 48×48 | A level star you earned. |
| `ui/star-empty.svg` | 48×48 | A level star you did not earn. |
| `ui/island.svg` | 48×48 | Island mode label (🏝) in the HUD, cards and the "Island cleared" dialog. |
| `ui/endless.svg` | 48×48 | Endless mode label (♾). |
| `ui/target.svg` | 48×48 | Goal marker in the HUD (🎯). |
| `ui/compass.svg` | 48×48 | Treasure goal in the HUD and the Free expedition button (🧭). |
| `ui/distance.svg` | 48×48 | Distance in endless mode (📏). |
| `ui/pickaxe.svg` | 48×48 | Reveal-mode button (⛏). |
| `ui/progress.svg` | 48×48 | Progress and Stats buttons (📊). |
| `ui/center.svg` | 48×48 | Back-to-centre button (⌖). |
| `ui/menu.svg` | 48×48 | Menu button (☰). |
| `ui/globe-3d.svg` | 48×48 | See the island in 3D (🌍). |
| `ui/restart.svg` | 48×48 | Restart (↻). |
| `ui/eye.svg` | 48×48 | Look around / View (👁). |
| `ui/boom.svg` | 48×48 | Mine hit / game over (💥). |
| `ui/lock.svg` | 48×48 | Locked adventure level (🔒). |
| `ui/trophy.svg` | 48×48 | Finished islands (🏆). |
| `ui/calendar.svg` | 48×48 | Daily island (📅). |
| `ui/adventure-map.svg` | 48×48 | Adventure button (🗺). |
| `ui/settings.svg` | 48×48 | Settings (⚙). |
| `ui/install.svg` | 48×48 | Install app (⬇). |
| `ui/dice.svg` | 48×48 | Random seed (🎲). |
| `ui/trash.svg` | 48×48 | Delete world (🗑). |
| `ui/flame.svg` | 48×48 | Daily streak (🔥). |
| `ui/music.svg` | 48×48 | Music (♪). |
| `ui/check.svg` | 48×48 | Done / cleared (✓). |
| `ui/cross.svg` | 48×48 | Lost / close (✕). |
| `ui/arrow-right.svg` | 48×48 | Direction arrows (→); the game rotates this one for ← ↑ ↓. |
| `ui/arrow-back.svg` | 48×48 | Back buttons (←). |
| `ui/play-next.svg` | 48×48 | Next level / Continue (▶). |
| `app/logo.svg` | 256×256 | The emblem on the main menu (a compass rose that is also a mine). The game name is written next to it as text. |
| `ui/worlds.svg` | 48×48 | My worlds button (🗂). |
| `ui/volume.svg` | 48×48 | Audio is on (🔊), floating button on the main menu. |
| `ui/volume-off.svg` | 48×48 | Audio is off (🔇). |
| `ui/vibrate.svg` | 48×48 | Vibration is on (📳). |
| `ui/vibrate-off.svg` | 48×48 | Vibration is off (📴). |
| `ui/github.svg` | 48×48 | Link to the author page (🐙), floating on the main menu. |
| `app/icon.svg` | 512×512 | Main app image: home-screen / install icon (rounded square; corners stay transparent). |
| `app/icon-maskable.svg` | 512×512 | Same picture, full bleed, no rounded corners. Keep everything important inside the central 80% circle: phones crop it. |
| `app/favicon.svg` | 512×512 | Browser tab icon. Shown at 16-32 px, so keep the picture bold and simple. |

Not in this folder, still drawn by the game: the parchment texture and paper grain, the glowing goal border,
the dashed start square, the sea and land colours, and the red square under an exploded mine.

## When you send it back

Send the whole `art/` folder. I will wire the files into the game (the map glyphs and the interface
icons replace the drawn shapes and emoji), regenerate the PNG app icons, and keep it light.
