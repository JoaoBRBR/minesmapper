# Mines' Mapper

A cartographer-themed infinite and island minesweeper. The game core is Rust compiled to WebAssembly, with a
TypeScript and Vite interface, and it installs as a PWA.

Play it: https://joaobrbr.github.io/minesmapper/

## Develop

```
npm install
npm run wasm     # build the Rust core
npm run dev      # http://localhost:5173/
npm run icons    # regenerate the PNG app icons from art/app/*.svg
npm run deploy   # build and publish to GitHub Pages (docs/)
```

All pictures are SVG files in `art/` (see `art/README.md`). Music files are in `music/`.

## Music credits

### Apache Flute by Walen

Music track: Apache Flute by Walen  
Source: https://freetouse.com/music  
Vlog Music for Videos (Free Download)  
Used as: `menu` (`music/menu.m4a`)

### Sounds of Nature by Aylex

Music track: Sounds of Nature by Aylex  
Source: https://freetouse.com/music  
Free To Use Music for Video  
Used as: `nature` (`music/nature.m4a`)

### Bread by Lukrembo

Music track: Bread by Lukrembo  
Source: https://freetouse.com/music  
Free Music Without Copyright (Safe)  
Used as: `bread` (`music/bread.m4a`)

### Soaked by Pufino

Music track: Soaked by Pufino  
Source: https://freetouse.com/music  
No Copyright Background Music  
Used as: `soaked` (`music/soaked.m4a`)

### Lurker by Hazelwood

Music track: Lurker by Hazelwood  
Source: https://freetouse.com/music  
No Copyright Music for Videos (Free)  
Used as: `space` (`music/space.m4a`)

Full details are also in `music/CREDITS.md` and in the game under Settings, Music credits.
