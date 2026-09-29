# Architecture

A static web app: plain ES modules, no build step, no runtime network access. Open
`index.html` from any static server (`npm start`) or GitHub Pages. Phone-first: the
camera scan is meant to be done with a phone held over the cube.

```
index.html, styles.css
src/
  cube.js       Cube model: facelet strings, moves, validation, scrambles   (pure, tested)
  solver.js     Beginner layer-by-layer solver, white cross on the bottom     (pure, tested)
  lessons.js    Teaching content for each stage + speed tips                  (pure data)
  scanner.js    Camera capture + color classification                         (DOM + pure core, tested)
  netEditor.js  2D cube net: shows a state, tap a sticker to fix its color    (DOM)
  viewer3d.js   Three.js cube: animated moves, arrows, piece highlighting     (DOM/WebGL)
  practice.js   Speed timer, inspection, stats (ao5/ao12), solve history      (pure core, tested)
  app.js        Wires it all together: Scan → Coach → Practice
vendor/three.module.min.js   three.js r186, bundled + minified (MIT, see three.LICENSE)
test/*.test.js               node --test, no dependencies
```

## Conventions everyone relies on

- **State** is a 54-char facelet string in Kociemba order `U R F D L B` (see the header of
  `src/cube.js` for how each face is read). Letters name the face whose center has that
  color. Import helpers from `src/cube.js`; never re-implement move logic.
- **Holding the cube:** white center on the bottom (D), yellow on top (U), green in front
  (F), so orange is R, red is L, blue is B (`COLOR_OF` in cube.js). The solver works from
  whatever centers it is given, so a cube with a different color scheme still solves as
  long as white is on D.
- **Moves** use standard notation: `U R F D L B` (clockwise looking at that face), `'` =
  counter-clockwise, `2` = half turn; `y`, `y'`, `y2` = rotate the whole cube like U.
  The coach may use `y` rotations (humans do); it never uses x/z or slice moves.
- **Colors on screen** (hex) come from `STICKER_HEX` in `src/viewer3d.js`, keyed by color
  name: white, yellow, green, blue, red, orange.

## Module contracts

### solver.js
```js
export const STAGES; // [{ id, title }] in order:
//   cross, whiteCorners, middle, yellowCross, yellowEdges, yellowCornersPosition, yellowCornersOrient
export function solveBeginner(facelets, { colorOf = COLOR_OF } = {}) → {
  ok: boolean, error?: string,            // error when validate() fails
  stages: [{
    id, title,
    steps: [{
      moves: string[],                    // may be [] when the piece is already solved
      explain: string,                    // plain-English why, naming colors ("the white-green edge")
      highlight: number[],                // sticker indices this step is about (for viewer3d)
      after: string,                      // facelets after this step
    }],
  }],
  moves: string[],                        // every move, in order
}
```

### lessons.js
```js
export const LESSONS = { [stageId]: {
  goal: string, recognize: string, algorithms: [{ name, moves, when }], tips: string[], speedTips: string[],
} };
```

### scanner.js
```js
export const SCAN_ORDER; // [{ face: 'F'|'R'|'B'|'L'|'U'|'D', title, instruction }]
export class CameraScanner {
  constructor({ video, overlay })          // <video> and a <canvas> overlay (grid guide)
  async start()                            // rear camera if available; throws a friendly Error
  stop()
  sample()  → [{ r, g, b }] × 9            // row-major, as the face is seen from the front
}
export function classifyFaces(samples)    // samples: { U: [9 rgb], R: [...], ... }
  → { facelets: string, confidence: number[54] }   // letters by nearest center, balanced 9 each
```

### netEditor.js
```js
export class NetEditor {
  constructor(container, { colorOf = COLOR_OF, editable = true })
  setState(facelets); getState() → facelets
  onChange(fn)                             // fn(facelets) after each tap
}
```

### viewer3d.js
```js
export const STICKER_HEX; // { white, yellow, green, blue, red, orange }
export class CubeViewer {
  constructor(container, { colorOf = COLOR_OF })
  setState(facelets)                       // snap, no animation
  async play(moves, { speed = 1 } = {})    // animate in order; resolves when done
  stop()                                   // finish the current turn, drop the rest
  setHint(move | null)                     // arrow on the layer that turns next
  setHighlight(indices | null)             // dim every other sticker
  dispose()
}
```

### practice.js
```js
export class Timer          // idle → inspecting → ready → running → stopped; pure, takes now()
export function stats(solves) → { best, worst, mean, ao5, ao12, count }  // WCA trimmed averages, DNF aware
export class History        // persisted solves; takes a Storage-like object (localStorage in the app)
```
