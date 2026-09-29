// Assemble six scanned faces into one 54-facelet cube. Pure, no DOM.
//
// The faces arrive in any order and each one may be turned by a multiple of 90°, because the
// user rotates the cube freely. Each face is identified by its center color (COLOR_OF says
// which face letter that color is), then the 4^6 turn combinations are searched for the ones
// that form a reachable cube (validate() in cube.js).
//
// Rotation convention (used everywhere in this module): rotations[i] = k means "turn the
// captured image of input face i clockwise k quarter-turns (k in 0..3) to get it upright in
// the Kociemba reading order of cube.js". A clockwise quarter-turn moves (r, c) to (c, 2 - r).

import { FACES, COLOR_OF, validate, CORNER_SLOTS, EDGE_SLOTS } from './cube.js';

const FACE_OF_COLOR = Object.fromEntries(Object.entries(COLOR_OF).map(([face, color]) => [color, face]));
const OPPOSITE = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

// SRC[j] = index in the captured 3×3 of the sticker that lands on index j after one
// clockwise quarter-turn: new(r, c) = old(2 - c, r).
const SRC = Array.from({ length: 9 }, (_, j) => { const r = Math.floor(j / 3), c = j % 3; return (2 - c) * 3 + r; });

// Rotate a row-major 3×3 (any element type) clockwise by `turns` quarter-turns.
export function rotateFace(cells, turns = 1) {
  let out = cells.slice(0, 9);
  for (let t = (((turns % 4) + 4) % 4); t > 0; t--) out = SRC.map((s) => out[s]);
  return out;
}

// Rotation lookup: ROT[k][j] = index in the captured face for position j after k turns.
const ROT = [0, 1, 2, 3].map((k) => rotateFace(Array.from({ length: 9 }, (_, i) => i), k));

// Structural tables for a cheap pre-check (no full validate() on 4096 candidates). Letters are
// coded 0-5 in FACES order, 6 = unknown.
const CODE = Object.fromEntries(FACES.map((f, i) => [f, i]));
const EDGE_IDX = EDGE_SLOTS.map((s) => s.stickers);
const CORNER_IDX = CORNER_SLOTS.map((s) => s.stickers);
const EDGE_OK = new Uint8Array(49); // [x * 7 + y]: two different, non-opposite faces
for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) EDGE_OK[x * 7 + y] = x !== y && OPPOSITE[FACES[x]] !== FACES[y] ? 1 : 0;
const CORNER_OK = new Uint8Array(343); // every reading of a real corner: solved triples, cyclically shifted
CORNER_IDX.forEach((idx) => {
  const t = idx.map((i) => Math.floor(i / 9));
  for (let s = 0; s < 3; s++) CORNER_OK[t[s] * 49 + t[(s + 1) % 3] * 7 + t[(s + 2) % 3]] = 1;
});

const ordinal = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];

// Count edge and corner slots (of 12 + 8) that can't exist on any cube.
function violations(f) {
  let bad = 0;
  for (const [a, b] of EDGE_IDX) if (!EDGE_OK[f[a] * 7 + f[b]]) bad++;
  for (const [a, b, c] of CORNER_IDX) if (!CORNER_OK[f[a] * 49 + f[b] * 7 + f[c]]) bad++;
  return bad;
}

function centerErrors(centerNames) {
  const errors = [];
  const count = {};
  centerNames.forEach((n, i) => {
    if (!FACE_OF_COLOR[n]) errors.push(`Face ${i + 1} has an unreadable center color.`);
    else count[n] = (count[n] ?? 0) + 1;
  });
  for (const [color, n] of Object.entries(count)) {
    if (n > 1) errors.push(`${ordinal[n] ?? n} faces have a ${color} center.`);
  }
  for (const face of FACES) {
    const color = COLOR_OF[face];
    if (!count[color]) errors.push(`No ${color} face scanned yet.`);
  }
  return errors;
}

// Core search for one fixed choice of centers. names[i][4] must be six distinct known colors.
function search(names, preferred) {
  const slotOf = names.map((n) => FACES.indexOf(FACE_OF_COLOR[n[4]]));
  const letters = names.map((n) => n.map((c) => CODE[FACE_OF_COLOR[c]] ?? 6));
  const f = new Uint8Array(54);
  const text = () => Array.from(f, (v) => FACES[v] ?? '?').join('');
  const rot = [0, 0, 0, 0, 0, 0];
  const seen = new Map(); // facelets → validate() result, so symmetric cubes validate once
  let best = null, valid = 0, minBad = Infinity;
  const nearMisses = []; // zero/min-violation combos when nothing validates

  const consider = () => {
    const bad = violations(f);
    if (bad === 0) {
      const str = text();
      let v = seen.get(str);
      if (!v) { v = validate(str); seen.set(str, v); }
      if (v.ok) {
        valid++;
        const cost = rot.reduce((n, k, i) => n + (k !== preferred[i] ? 1 : 0), 0);
        if (!best || cost < best.cost) best = { facelets: str, rotations: rot.slice(), cost };
        return;
      }
    }
    if (valid > 0) return;
    if (bad < minBad) { minBad = bad; nearMisses.length = 0; }
    if (bad === minBad && nearMisses.length < 48) {
      nearMisses.push({ facelets: text(), rotations: rot.slice(), cost: rot.reduce((n, k, i) => n + (k !== preferred[i] ? 1 : 0), 0) });
    }
  };

  for (let combo = 0; combo < 4096; combo++) {
    for (let i = 0; i < 6; i++) {
      const k = (combo >> (2 * i)) & 3;
      if (k === rot[i] && combo > 0) continue; // only redraw the faces whose turn changed
      rot[i] = k;
      const base = slotOf[i] * 9, r = ROT[k], src = letters[i];
      for (let j = 0; j < 9; j++) f[base + j] = src[r[j]];
    }
    consider();
  }
  const distinct = [...seen.values()].filter((v) => v.ok).length;
  if (best) return { ok: true, facelets: best.facelets, rotations: best.rotations, candidates: valid, distinct, cost: best.cost, errors: [] };

  // Nothing is a real cube: return the closest attempt for the net editor to fix.
  let pick = null;
  for (const m of nearMisses.sort((a, b) => a.cost - b.cost)) {
    const v = validate(m.facelets);
    if (!pick || v.errors.length < pick.errors.length) pick = { ...m, errors: v.errors };
  }
  pick ??= { facelets: text(), rotations: [0, 0, 0, 0, 0, 0], errors: ['These faces do not fit together.'], cost: 0 };
  return {
    ok: false, facelets: pick.facelets, rotations: pick.rotations, candidates: 0, distinct: 0, cost: pick.cost,
    errors: ["The six faces don't fit together as a real cube: check for a mis-read sticker.", ...pick.errors],
  };
}

const wellFormed = (names) => Array.isArray(names) && names.length === 6
  && names.every((n) => Array.isArray(n) && n.length === 9);

// names: string[6][9] color names (faces in any order, each maybe turned by 90° steps).
// Options: preferredRotations (number[6], default zeros) breaks ties between equally valid
// cubes, e.g. the previous answer so nothing flips while the user keeps scanning;
// centerAlternatives (string[6][], from classifyStickers) are other plausible center colors
// to try, best first, when the first reading of the centers does not give a real cube.
// → { ok, facelets, rotations, candidates, distinct, centers, usedAlternative, errors }
//   candidates = rotation combos giving a real cube; distinct = different cubes among them
//   (more than 1 means the scan is ambiguous, e.g. a nearly solved cube).
export function assembleCube(names, { preferredRotations, centerAlternatives } = {}) {
  const preferred = Array.isArray(preferredRotations) && preferredRotations.length === 6
    ? preferredRotations.map((k) => (((Math.round(k) || 0) % 4) + 4) % 4) : [0, 0, 0, 0, 0, 0];
  if (!wellFormed(names)) {
    return {
      ok: false, facelets: FACES.map((f) => f.repeat(9)).join(''), rotations: [0, 0, 0, 0, 0, 0], candidates: 0, distinct: 0,
      centers: [], usedAlternative: -1, errors: ['Need six faces of nine stickers each.'],
    };
  }
  const centersOf = (ns) => ns.map((n) => n[4]);
  const errs = centerErrors(centersOf(names));
  if (errs.length) {
    // Best effort: faces with a usable, unique center go to their slots; leftovers fill the gaps.
    const slot = new Array(6).fill(-1), used = new Set();
    names.forEach((n, i) => {
      const s = FACES.indexOf(FACE_OF_COLOR[n[4]]);
      if (s >= 0 && !used.has(s)) { slot[i] = s; used.add(s); }
    });
    const free = [0, 1, 2, 3, 4, 5].filter((s) => !used.has(s));
    slot.forEach((s, i) => { if (s < 0) slot[i] = free.shift(); });
    const f = new Array(54);
    names.forEach((n, i) => n.forEach((c, j) => { f[slot[i] * 9 + j] = FACE_OF_COLOR[c] ?? FACES[slot[i]]; }));
    return {
      ok: false, facelets: f.join(''), rotations: [0, 0, 0, 0, 0, 0], candidates: 0, distinct: 0,
      centers: centersOf(names), usedAlternative: -1, errors: errs,
    };
  }

  const primary = search(names, preferred);
  if (primary.ok) return { ...strip(primary), centers: centersOf(names), usedAlternative: -1 };

  const tried = new Set([centersOf(names).join()]);
  const alts = centerAlternatives ?? [];
  for (let a = 0; a < alts.length; a++) {
    const alt = alts[a];
    if (!Array.isArray(alt) || alt.length !== 6 || tried.has(alt.join()) || centerErrors(alt).length) continue;
    tried.add(alt.join());
    const r = search(names.map((n, i) => n.map((c, j) => (j === 4 ? alt[i] : c))), preferred);
    if (r.ok) return { ...strip(r), centers: alt.slice(), usedAlternative: a };
  }
  return { ...strip(primary), centers: centersOf(names), usedAlternative: -1 };
}

function strip({ ok, facelets, rotations, candidates, distinct, errors }) {
  return { ok, facelets, rotations, candidates, distinct, errors };
}
