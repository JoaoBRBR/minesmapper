# Art for Mines' Mapper

Everything image-related in the game lives here, as **SVG**. The files you find now are simple stand-ins
that copy the current look: redraw each one in your own style, keep the file name, and send the folder back.
Open `index.html` in a browser to see all of them at once.

## Format

- **SVG** for everything. It is tiny (usually under 2 KB), stays sharp at any zoom, and one file serves every screen.
- The only PNGs are the four app-icon sizes the phone needs (192, 512, maskable 512, 180). You do not draw
  those: `npm run icons` makes them from `app/icon.png`.
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

## The chart pictures (`chart/`)

The little drawings that fill the map when you zoom out on an **island**, like an old pirate chart: one
picture per biome inside the island, waves / a ship / two sea monsters on the open sea, a lake picture,
and a house where you start. They are drawn at one fixed size on screen (about 40-68 px), whatever the zoom,
and only on ground you have not opened yet.

- **One colour only.** The game paints every picture in a single ink colour (dark brown on light paper, a
  soft gray on dark paper, blue-black for water things), so the colours you use are ignored: only the
  *shape* counts. Solid fills are allowed and become solid ink.
- Keep the viewBox `0 0 64 64`, a transparent background, bold lines (about 2.5 wide) and leave a small margin.
- Pictures are shown small and often side by side, so keep them simple. The forest, jungle and taiga
  pictures are already *groups* of trees on purpose.
- You can switch all of them off in Settings → **Map drawings**.

## Files

| File | Size (viewBox) | Where it is used |
|---|---|---|
| `map/flag.svg` | 64×64 | A flag placed on a hidden square (also the flag-mode button and the 🚩 counter). |
| `map/mine.svg` | 64×64 | A mine on the map (after a loss or when a heart is lost). Also used small as the mine counter (💣). The red square under an exploded mine is drawn by the game. |
| `map/oracle-glass.svg` | 64×64 | The oracle power-up (a magnifying glass) lying on a revealed safe square, and the Oracle button. |
| `map/ice-crystal.svg` | 64×64 | The ice-clearer power-up under a revealed safe square, and the Ice clearer button. |
| `map/treasure-x.svg` | 64×64 | The X on the treasure levels. |
| `map/flag-negative.svg` | 64×64 | The purple flag for negative mines (space maps only). |
| `map/mine-negative.svg` | 64×64 | A negative mine, shown when a space game ends (space maps only). |
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
| `ui/music-off.svg` | 48×48 | Music is off (♫), floating button on the main menu. |
| `ui/check.svg` | 48×48 | Done / cleared (✓). |
| `ui/cross.svg` | 48×48 | Lost / close (✕). |
| `ui/arrow-right.svg` | 48×48 | Direction arrows (→); the game rotates this one for ← ↑ ↓. |
| `ui/arrow-back.svg` | 48×48 | Back buttons (←). |
| `ui/play-next.svg` | 48×48 | Next level / Continue (▶). |
| `ui/meteor.svg` | 48×48 | Space islands (meteors), in the free-expedition screen (☄). |
| `ui/skip-prev.svg` | 48×48 | Music: previous track (⏮). |
| `ui/skip-next.svg` | 48×48 | Music: next track (⏭). |
| `ui/repeat.svg` | 48×48 | Music: repeat this track (🔁). |
| `ui/sun.svg` | 48×48 | Light paper (☀), in the Dark paper switch. |
| `ui/moon.svg` | 48×48 | Dark paper (☾), in the Dark paper switch. |
| `app/logo.png` | cut out, transparent | The main-menu logo (scroll and mine). Source of the first picture is `app/logo-original.png`. Replace the PNG to change it. |
| `ui/worlds.svg` | 48×48 | My worlds button (🗂). |
| `ui/volume.svg` | 48×48 | Audio is on (🔊), floating button on the main menu. |
| `ui/volume-off.svg` | 48×48 | Audio is off (🔇). |
| `ui/vibrate.svg` | 48×48 | Vibration is on (📳). |
| `ui/vibrate-off.svg` | 48×48 | Vibration is off (📴). |
| `ui/github.svg` | 48×48 | Link to the author page (🐙), floating on the main menu. |
| `app/icon.png` | 1024×1024, transparent background | Main app image: home-screen / install icon and browser tab icon. Cut tight to the mine (your original is `app/icon-original.png`). Run `npm run icons` after changing it. |

| `chart/mountain-rock.svg` | 64×64 | Rock mountains: drawn once in rocky areas of an island (map view). |
| `chart/mountain-snow.svg` | 64×64 | Snowy / ice mountains: one picture for snow areas. |
| `chart/forest.svg` | 64×64 | Forest: a small group of trees together. |
| `chart/jungle.svg` | 64×64 | Jungle: a thick leafy clump. |
| `chart/taiga.svg` | 64×64 | Taiga: a group of pines. |
| `chart/tundra.svg` | 64×64 | Tundra: a few small pines and tufts. |
| `chart/beach.svg` | 64×64 | Beach: palm trees along the shore (drawn more often, on thin beaches). |
| `chart/desert.svg` | 64×64 | Desert: dunes and a cactus. |
| `chart/badlands.svg` | 64×64 | Badlands: flat-topped rock buttes. |
| `chart/savanna.svg` | 64×64 | Savanna: an acacia tree. |
| `chart/grassland.svg` | 64×64 | Grassland: soft hills and grass tufts. |
| `chart/swamp.svg` | 64×64 | Swamp: reeds in the water. |
| `chart/lake.svg` | 64×64 | A lake inside the island. |
| `chart/wave-1.svg` | 64×64 | Open sea, wave variation 1 (outside the island). |
| `chart/wave-2.svg` | 64×64 | Open sea, wave variation 2. |
| `chart/wave-3.svg` | 64×64 | Open sea, wave variation 3. |
| `chart/monster-serpent.svg` | 64×64 | Sea monster 1: a serpent (rare, on the open sea). |
| `chart/monster-kraken.svg` | 64×64 | Sea monster 2: a kraken (rare, on the open sea). |
| `chart/ship.svg` | 64×64 | A ship sailing the open sea (rare). |
| `chart/home.svg` | 64×64 | Home: marks where the island starts. |
| `ui/compass-ring.svg` | 64×64 | The compass button that takes you back to the start (shown when you are far away): the ring and tick marks. |
| `ui/compass-needle.svg` | 64×64 | The compass needle, drawn pointing UP; the game rotates it so the red point aims at the start. |

Not in this folder, still drawn by the game: the parchment texture and paper grain, the glowing goal border,
the dashed start square, the sea and land colours, and the red square under an exploded mine.

## When you send it back

Send the whole `art/` folder. I will wire the files into the game (the map glyphs and the interface
icons replace the drawn shapes and emoji), regenerate the PNG app icons, and keep it light.

## The menu eagle (`menu/`)

An eagle flies across the main-menu background in time with the eagle cry in the menu song (at 0:18, 0:32,
1:04 and 1:37; each cry has a 10% chance, set in `src/eagle.ts`). Three wing positions are swapped to flap:
`eagle-1` (wings fully out), `eagle-2` (half), `eagle-3` (wings up). Draw it seen from above, flying to the
**right**, 128×64 viewBox; the game rotates and moves it. Keep your own colours (a soft shadow is added).

| File | Size | Used for |
|---|---|---|
| `menu/eagle-1.svg` | 128×64 | Eagle, wings fully out. |
| `menu/eagle-2.svg` | 128×64 | Eagle, wings half. |
| `menu/eagle-3.svg` | 128×64 | Eagle, wings up. |
| `menu/ufo.svg` | 128×64 | UFO that crosses the menu background in the space song (at 0:10, 10% chance). Draw it level, seen from the side; the game slides it across. |

| `ui/cursor-feather.svg` | 32×32 | Mouse pointer on desktop only (phones and tablets keep their own). The tip is the top-left corner. |

| `map/cloud-1.svg`, `cloud-2`, `cloud-3` | 64×64 | Clouds past the island's square edge, in map view. Draw them touching the left and right edges, so neighbouring clouds join up. Three variants are picked by position. |
