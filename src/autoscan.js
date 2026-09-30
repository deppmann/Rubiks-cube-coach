// Auto-capture logic for the camera scan. Pure and DOM-free (times are passed in), so the whole
// flow can be replayed over recorded frames in Node.
//
//   FaceTracker  watches detectFace() results frame by frame and says when one face has been
//                held steady long enough to capture (once per hold).
//   FaceTray     the six captured faces. A face is identified by the color of its center, so
//                faces can arrive in any order; showing a face again replaces it only if the
//                new capture is steadier.
//   buildCube    six captures → sticker colors → one valid cube (any order, any 90° turn).

import { FACES, COLOR_OF } from './cube.js';
import { rgbToLab, classifyStickers, COLOR_NAMES } from './colors.js';
import { assembleCube, rotateFace } from './assemble.js';

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const medianRgb = (list) => ({ r: median(list.map((c) => c.r)), g: median(list.map((c) => c.g)), b: median(list.map((c) => c.b)) });
const rgbDist = (p, q) => Math.hypot(p.r - q.r, p.g - q.g, p.b - q.b);
const deltaE = (p, q) => {
  const a = rgbToLab(p), b = rgbToLab(q);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

// ---- FaceTracker -----------------------------------------------------------------------

export const DEFAULTS = {
  holdMs: 500,      // how long one face must stay put and steady
  minFrames: 4,     // ...and be seen in at least this many frames
  gapMs: 300,       // a face may drop out of detection this long without restarting the hold
  posTol: 0.15,     // frame-to-frame center movement, fraction of the grid size
  driftTol: 0.40,   // movement since the hold began, fraction of the grid size
  sizeTol: 0.20,    // frame-to-frame size change, fraction
  angleTol: 15,     // degrees
  cellTol: 50,      // largest RGB jump of any sticker between frames (a turn or motion blur mixes colors)
  maxJitter: 18,    // mean sticker change between frames over the hold; above this the capture waits
  minScore: 0.40,   // detections weaker than this never count as steady
};

export class FaceTracker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.run = null;         // { frames: [{det, t}], start, captured }
    this.lastSeen = -Infinity;
  }

  // Feed one detection (or null) taken at time `now` (ms). → { phase, progress, capture }
  //   phase: 'searching' (nothing usable), 'holding' (steady, filling up), 'captured' (this frame
  //   fired a capture; `capture` is set), 'held' (already captured, still holding the same face).
  update(det, now) {
    const o = this.o;
    if (!det || !det.found || det.score < o.minScore) {
      if (now - this.lastSeen > o.gapMs) this.run = null;
      return { phase: 'searching', progress: 0, capture: null };
    }
    this.lastSeen = now;
    const run = this.run;
    const last = run?.frames[run.frames.length - 1].det;
    if (!run || !this._steady(last, det, run.frames[0].det)) {
      this.run = { frames: [{ det, t: now }], start: now, captured: false };
      return { phase: 'holding', progress: 0, capture: null, why: run ? this.why : 'new' };
    }
    run.frames.push({ det, t: now });
    const progress = Math.min(1, (now - run.start) / o.holdMs);
    if (run.captured) return { phase: 'held', progress: 1, capture: null };
    if (progress >= 1 && run.frames.length >= o.minFrames) {
      const capture = this._capture(run, now);
      if (capture.jitter <= o.maxJitter) { // otherwise keep holding: it may settle
        run.captured = true;
        return { phase: 'captured', progress: 1, capture };
      }
    }
    return { phase: 'holding', progress, capture: null };
  }

  // Is detection b the same face as a, held (nearly) still? this.why says what failed.
  _steady(a, b, first) {
    const o = this.o, s = b.size;
    const cx = (d) => d.x + d.size / 2, cy = (d) => d.y + d.size / 2;
    this.why = '';
    if (Math.hypot(cx(a) - cx(b), cy(a) - cy(b)) > o.posTol * s) { this.why = 'moved'; return false; }
    if (Math.hypot(cx(first) - cx(b), cy(first) - cy(b)) > o.driftTol * s) { this.why = 'drifted'; return false; }
    if (Math.abs(a.size - b.size) > o.sizeTol * s) { this.why = 'resized'; return false; }
    if (Math.abs(a.angle - b.angle) > o.angleTol) { this.why = 'turned'; return false; }
    for (let i = 0; i < 9; i++) if (i !== 4 && rgbDist(a.cells[i], b.cells[i]) > o.cellTol) { this.why = `sticker ${i} changed`; return false; }
    if (rgbDist(a.centerRing, b.centerRing) > o.cellTol) { this.why = 'center changed'; return false; }
    return true;
  }

  // One capture from the frames of the hold: per-sticker medians over time (noise and a
  // flicker of glare drop out), a quality figure, and the last detection for the thumbnail.
  _capture(run, now) {
    const frames = run.frames.slice(-12);
    const dets = frames.map((f) => f.det);
    const cells = Array.from({ length: 9 }, (_, i) => medianRgb(dets.map((d) => d.cells[i])));
    const centerRing = medianRgb(dets.map((d) => d.centerRing));
    // Jitter: how much stickers move between consecutive frames (motion blur, hand shake).
    let jitter = 0, n = 0;
    for (let k = 1; k < dets.length; k++) for (let i = 0; i < 9; i++) if (i !== 4) { jitter += rgbDist(dets[k].cells[i], dets[k - 1].cells[i]); n++; }
    jitter = n ? jitter / n : 0;
    const meanScore = dets.reduce((s, d) => s + d.score, 0) / dets.length;
    const quality = Math.min(1, meanScore) / (1 + jitter / 12);
    return { det: dets[dets.length - 1], cells, centerRing, quality, jitter, t: now, frames: dets.length };
  }
}

// ---- Naming a center by its color ------------------------------------------------------

// Hue angles (degrees, CIE a*b*) of the five chromatic stickers under ordinary light.
const HUE_REF = { red: 30, orange: 55, yellow: 95, green: 145, blue: 275 };
const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Cost of calling a ring color `name`; low is a good match. White is the low-chroma one.
function nameCost(lab, name) {
  const chroma = Math.hypot(lab[1], lab[2]);
  const hue = (Math.atan2(lab[2], lab[1]) / Math.PI * 180 + 360) % 360;
  if (name === 'white') return chroma < 30 ? chroma * 0.3 : 9 + (chroma - 30) * 2;
  return hueDiff(hue, HUE_REF[name]) + (chroma < 30 ? (30 - chroma) * 3 : 0);
}

// ---- FaceTray --------------------------------------------------------------------------

export const SAME_FACE_DE = 16; // ring colors closer than this are the same center

export class FaceTray {
  constructor() { this.slots = []; } // [{ name, capture }] in capture order

  get count() { return this.slots.length; }
  get missing() { return COLOR_NAMES.filter((n) => !this.slots.some((s) => s.name === n)); }
  captures() { return this.slots.map((s) => s.capture); }

  // Offer a capture. → { kind: 'added' | 'replaced' | 'kept', index, name }. `force` (the manual
  // button) replaces a face already held even when the new capture is no steadier.
  offer(capture, { force = false } = {}) {
    const ring = capture.centerRing;
    let index = -1, best = Infinity;
    this.slots.forEach((s, i) => {
      const d = deltaE(ring, s.capture.centerRing);
      if (d < best) { best = d; index = i; }
    });
    if (index >= 0 && best < SAME_FACE_DE) return this._replace(index, capture, force);

    const lab = rgbToLab(ring);
    const free = COLOR_NAMES.filter((n) => !this.slots.some((s) => s.name === n));
    if (!free.length) return this._replace(index, capture, force); // seven "different" centers: keep the closest slot
    const name = free.reduce((a, b) => (nameCost(lab, a) <= nameCost(lab, b) ? a : b));
    this.slots.push({ name, capture });
    return { kind: 'added', index: this.slots.length - 1, name };
  }

  _replace(index, capture, force) {
    const slot = this.slots[index];
    if (force || capture.quality > slot.capture.quality + 0.02) {
      slot.capture = capture;
      return { kind: 'replaced', index, name: slot.name };
    }
    return { kind: 'kept', index, name: slot.name };
  }

  // Forget one face so it can be shown again (the "Retake" tap).
  remove(index) { this.slots.splice(index, 1); }
  clear() { this.slots = []; }
}

// ---- From six captures to one cube -----------------------------------------------------

export const DOUBT = 0.25; // stickers whose color call is less sure than this get flagged

// captures: 6 × { cells: 9 rgb, centerRing } in any order. → {
//   ok, facelets, errors[], flags[] (facelet indices worth a second look), rotations, names,
//   centers, distinct (>1 means the scan is ambiguous), candidates }
export function buildCube(captures, { preferredRotations } = {}) {
  const faces = captures.map((c) => c.cells);
  const cls = classifyStickers(faces, { centerRings: captures.map((c) => c.centerRing) });
  const asm = assembleCube(cls.names, { preferredRotations, centerAlternatives: cls.centerAlternatives });
  const flags = [];
  const centers = asm.centers?.length === 6 ? asm.centers : cls.centers;
  captures.forEach((_, f) => {
    const letter = FACES.find((l) => COLOR_OF[l] === centers[f]);
    if (!letter) return;
    const upright = rotateFace(Array.from({ length: 9 }, (_, i) => i), asm.rotations[f]);
    for (let i = 0; i < 9; i++) {
      if (i === 4 || cls.confidence[f][i] >= DOUBT) continue;
      flags.push(FACES.indexOf(letter) * 9 + upright.indexOf(i));
    }
  });
  return {
    ok: asm.ok, facelets: asm.facelets, errors: asm.errors ?? [], flags, rotations: asm.rotations,
    names: cls.names, confidence: cls.confidence, centers, distinct: asm.distinct ?? 0, candidates: asm.candidates ?? 0,
  };
}
