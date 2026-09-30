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
  detect.js     Finds the 3x3 face anywhere in a frame, samples cells + center ring (pure, tested)
  colors.js     White-balanced balanced clustering of 54 stickers into 6 colors (pure, tested)
  assemble.js   Faces in any order/rotation → valid facelets (searches 4^6)       (pure, tested)
  autoscan.js   Stability tracker + 6-slot face tray for auto-capture             (pure, tested)
  autocam.js    Camera + detect loop + overlay drawing for the Scan tab / Coach check (DOM)
  checkpoint.js Palette + "did you do the moves right?" diagnosis from one face   (pure, tested)
  netEditor.js  2D cube net: shows a state, tap a sticker to fix its color    (DOM)
  viewer3d.js   Three.js cube: animated moves, arrows, piece highlighting     (DOM/WebGL)
  hands.js      Stylized 3D hands: home grip + per-move hand/finger motion    (pure table + three.js)
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
export function gripFor(move) → string   // one beginner sentence: which hand/finger turns this move
export const NOTATION;                    // [{ move, description, grip }]
export const LESSONS = { [stageId]: {
  goal: string, recognize: string, algorithms: [{ name, moves, when }], tips: string[], speedTips: string[],
} };
```

### detect.js / colors.js / assemble.js / autoscan.js (auto-capture scan)
```js
detectFace(imageData, { prev }) → { found, cells: [9 rgb], centerRing: rgb, score, … }  // anywhere, ±25° tilt
classifyStickers(faces[6][9 rgb], { centerRings }) → { names[6][9], confidence[6][9], centers[6], centerAlternatives }
assembleCube(names, { preferredRotations, centerAlternatives }) → { ok, facelets, rotations[6], distinct, errors }
new FaceTracker()  // "held steady for ~0.5 s" → capture;  new FaceTray()  // 6 slots keyed by center color
buildCube(captures, { preferredRotations }) → classify + assemble, with doubtful stickers flagged
```
Faces may be shown in any order and any 90° turn; identity comes from the center color and
orientation from the only rotation combination that forms a valid cube. Center colors come from
a ring around the cap, because speed cubes print a logo on the white center.
`scripts/check-video.mjs` replays the whole pipeline over a folder of video frames (local only;
never commit user photos or video).

### checkpoint.js (camera feedback while coaching)
```js
paletteFromScan(captures, names, confidence?) → { version, source:'scan', lab, spread, count } | null   // saved in localStorage 'rcc.palette'
classifyWithPalette(rgb9, palette | null, { centerRing }) → { names[9], confidence[9], source, anchored }
expectedFront(facelets, colorOf = COLOR_OF) → 9 color names           // the F face, read upright; also expectedTop / expectedFace
diagnose(before, stepMoves, observedNames, { colorOf, observedTop, confidence, topConfidence }) → {
  verdict: 'ok' | 'partial' | 'mistake' | 'unknown', matched, message, fixMoves, actual, ambiguous, needsTop, blind, ... }
```
The face pointing at the camera must equal the F face of the step's expected state (cube held white bottom,
green front, as the 3D view shows). `diagnose` compares it, allowing one misread sticker, against: the finished
step (ok), every prefix of the moves and the untouched start (partial), and every single slip (a move turned the
wrong way, skipped, done twice, a half turn made a quarter, an extra U at the end) (mistake, with `fixMoves` that
take the ACTUAL cube back onto the plan). Ties go ok > partial > mistake; slips that look alike from the front but
need different fixes come back `ambiguous` and ask for the top face (`observedTop`, read as SCAN_ORDER's U).
The Coach's camera panel (app.js) runs `AutoCamera` on a second video, classifies each steady face and shows the verdict.

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
  setHighlight(indices | null)             // dim every other sticker (keeps hue), rim + lift on the rest
  setHands(on)                             // coaching hands on/off (default on); play()/setHint() drive them
  dispose()
}
```

### practice.js
```js
export class Timer          // idle → inspecting → ready → running → stopped; pure, takes now()
export function stats(solves) → { best, worst, mean, ao5, ao12, count }  // WCA trimmed averages, DNF aware
export class History        // persisted solves; takes a Storage-like object (localStorage in the app)
```
