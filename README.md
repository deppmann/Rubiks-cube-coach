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

The camera needs HTTPS or `localhost`. On a phone, use the deployed site:
**https://deppmann.github.io/Rubiks-cube-coach/** — every push to `main` runs the tests and
redeploys it (`.github/workflows/pages.yml`; one-time setup: Settings → Pages → Source:
GitHub Actions).

## How it works

1. **Scan** — turn the cube slowly in front of the camera. The app finds the cube anywhere in
   the picture and captures each side once you hold it steady; any order, any angle. It works
   out which side is which from the colors, then shows a net where you can tap any sticker to
   fix a misread color.
2. **Coach** — seven stages of the beginner method: white cross, white corners, middle
   layer, yellow cross, yellow edges, position yellow corners, twist yellow corners.
   Every step shows the moves, animates them, and says why.
3. **Practice** — scramble, 15-second inspection, timer, stats (best, ao5, ao12), solve
   history with +2/DNF, and a roadmap from beginner method to CFOP.

No camera? Enter the colors by hand on the 2D net, or tap **Try a random scramble** to get
moves to apply to a solved cube. **Learn the moves** (top bar) explains the notation with a
small 3D demo of each turn.

Coach keys: <kbd>→</kbd> or <kbd>Space</kbd> next step, <kbd>←</kbd> back, <kbd>P</kbd>
play/pause. Practice: hold <kbd>Space</kbd> (or touch and hold the timer) until it turns
green, release to start, any key or tap to stop.

Your last cube, your place in the coach and your solves are kept in the browser's
`localStorage`; nothing is sent anywhere.

## Tests and CI

`npm test` runs the Node test suites in `test/` (cube model, solver, scanner color
classification, viewer math, practice timer and stats). GitHub Actions runs the same
command on every push and pull request (`.github/workflows/ci.yml`, Node 22).

See `docs/ARCHITECTURE.md` for the code layout.
