# Rubik's Cube Coach

Point your phone camera at your cube, and the coach walks you through solving it —
white face first, one layer at a time — with an animated 3D cube showing every turn.
Once the mechanics stick, switch to Practice for a speedcubing timer with inspection,
ao5/ao12 and solve history.

## Run it

```sh
npm start        # serves on http://localhost:8080
npm test
```

The camera needs HTTPS or `localhost`. On a phone, use the deployed site (GitHub Pages)
or a tunnel to your laptop.

## How it works

1. **Scan** — hold the cube white-side-down, green facing you, and show each face to the
   camera. Tap any sticker to fix a misread color.
2. **Coach** — seven stages of the beginner method: white cross, white corners, middle
   layer, yellow cross, yellow edges, position yellow corners, twist yellow corners.
   Every step shows the moves, animates them, and says why.
3. **Practice** — scramble, 15-second inspection, timer, stats.

See `docs/ARCHITECTURE.md` for the code layout.
