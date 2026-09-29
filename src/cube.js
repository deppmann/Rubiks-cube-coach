// Core 3x3 cube model. Pure functions, no DOM — runs in the browser and in Node tests.
//
// State is a 54-character facelet string in Kociemba order: U R F D L B, nine stickers
// per face, row-major as you look straight at that face:
//   U: looked at from above, F edge at the bottom     R: from the right, U on top, F on the left
//   F: from the front, U on top                       D: from below, F edge at the top
//   L: from the left, U on top, B on the left         B: from the back, U on top, R on the left
// Each character names the face whose *center* has that sticker's color, so the solved
// cube (in standard orientation) is SOLVED below. Colors live elsewhere (see COLOR_OF).
//
// Coordinates: x → R, y → U, z → F, each in {-1, 0, 1}. Every permutation is derived
// from this geometry rather than hand-typed tables.

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
export const SOLVED = FACES.map((f) => f.repeat(9)).join('');

// Coaching orientation: white on the bottom (D), green in front (F).
export const COLOR_OF = { U: 'yellow', D: 'white', F: 'green', B: 'blue', R: 'orange', L: 'red' };

export const NORMALS = {
  U: [0, 1, 0], D: [0, -1, 0], R: [1, 0, 0], L: [-1, 0, 0], F: [0, 0, 1], B: [0, 0, -1],
};

// Position of sticker (row, col) on a face, following the viewing rules above.
function stickerPos(face, r, c) {
  switch (face) {
    case 'U': return [c - 1, 1, r - 1];
    case 'D': return [c - 1, -1, 1 - r];
    case 'F': return [c - 1, 1 - r, 1];
    case 'B': return [1 - c, 1 - r, -1];
    case 'R': return [1, 1 - r, 1 - c];
    case 'L': return [-1, 1 - r, c - 1];
  }
  throw new Error(`bad face ${face}`);
}

// STICKERS[i] = { index, face, row, col, pos, normal }
export const STICKERS = [];
for (const face of FACES) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      STICKERS.push({ index: STICKERS.length, face, row: r, col: c, pos: stickerPos(face, r, c), normal: NORMALS[face] });
    }
  }
}

const key = (p, n) => `${p.join(',')}|${n.join(',')}`;
const INDEX_BY_KEY = new Map(STICKERS.map((s) => [key(s.pos, s.normal), s.index]));

export function stickerIndex(pos, normal) {
  const i = INDEX_BY_KEY.get(key(pos, normal));
  if (i === undefined) throw new Error(`no sticker at ${pos} facing ${normal}`);
  return i;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Rotate v by -90° about unit axis a (i.e. clockwise when looking at the tip of a).
// Rodrigues with θ = -90°: v' = -(a × v) + a (a · v).
function rotateCW(v, a) {
  const c = cross(a, v);
  const d = dot(a, v);
  return [-c[0] + a[0] * d, -c[1] + a[1] * d, -c[2] + a[2] * d].map((x) => x + 0); // +0 clears -0
}

// Base moves: axis is the direction you look *from* for "clockwise"; layer tests a
// piece position. Slices follow the WCA convention (M like L, E like D, S like F);
// rotations x/y/z follow R/U/F.
export const MOVE_DEFS = {
  U: { axis: NORMALS.U, layer: (p) => p[1] === 1 },
  D: { axis: NORMALS.D, layer: (p) => p[1] === -1 },
  R: { axis: NORMALS.R, layer: (p) => p[0] === 1 },
  L: { axis: NORMALS.L, layer: (p) => p[0] === -1 },
  F: { axis: NORMALS.F, layer: (p) => p[2] === 1 },
  B: { axis: NORMALS.B, layer: (p) => p[2] === -1 },
  M: { axis: NORMALS.L, layer: (p) => p[0] === 0 },
  E: { axis: NORMALS.D, layer: (p) => p[1] === 0 },
  S: { axis: NORMALS.F, layer: (p) => p[2] === 0 },
  x: { axis: NORMALS.R, layer: () => true },
  y: { axis: NORMALS.U, layer: () => true },
  z: { axis: NORMALS.F, layer: () => true },
  // Wide (two-layer) turns, lowercase face letters.
  u: { axis: NORMALS.U, layer: (p) => p[1] >= 0 },
  d: { axis: NORMALS.D, layer: (p) => p[1] <= 0 },
  r: { axis: NORMALS.R, layer: (p) => p[0] >= 0 },
  l: { axis: NORMALS.L, layer: (p) => p[0] <= 0 },
  f: { axis: NORMALS.F, layer: (p) => p[2] >= 0 },
  b: { axis: NORMALS.B, layer: (p) => p[2] <= 0 },
};

// PERM[base][j] = i means: after one clockwise quarter turn, sticker j holds what sticker i held.
const PERM = {};
for (const [name, def] of Object.entries(MOVE_DEFS)) {
  const perm = new Array(54);
  for (const s of STICKERS) {
    if (def.layer(s.pos)) {
      perm[stickerIndex(rotateCW(s.pos, def.axis), rotateCW(s.normal, def.axis))] = s.index;
    } else {
      perm[s.index] = s.index;
    }
  }
  PERM[name] = perm;
}

const MOVE_RE = /^([URFDLBMESxyzurfdlb])(2|'|2'|)$/;

// Parse "R U R' U2 x" (also accepts ’ and extra whitespace) into canonical tokens.
export function parseMoves(seq) {
  if (Array.isArray(seq)) return seq.flatMap(parseMoves);
  return seq.replace(/[’`]/g, "'").trim().split(/\s+/).filter(Boolean).map((t) => {
    const m = MOVE_RE.exec(t);
    if (!m) throw new Error(`bad move "${t}"`);
    return m[1] + (m[2] === "2'" ? '2' : m[2]);
  });
}

// Describe a single move for animation: base letter, clockwise quarter turns (1, 2 or -1).
export function moveInfo(move) {
  const m = MOVE_RE.exec(move);
  if (!m) throw new Error(`bad move "${move}"`);
  const turns = m[2] === "'" ? -1 : m[2].startsWith('2') ? 2 : 1;
  return { base: m[1], turns, axis: MOVE_DEFS[m[1]].axis, layer: MOVE_DEFS[m[1]].layer };
}

export function applyMove(facelets, move) {
  const { base, turns } = moveInfo(move);
  const perm = PERM[base];
  let s = facelets;
  for (let k = 0; k < ((turns + 4) % 4); k++) {
    let next = '';
    for (let j = 0; j < 54; j++) next += s[perm[j]];
    s = next;
  }
  return s;
}

export function applyMoves(facelets, seq) {
  return parseMoves(seq).reduce(applyMove, facelets);
}

export function invertMove(move) {
  if (move.endsWith('2')) return move;
  return move.endsWith("'") ? move.slice(0, -1) : move + "'";
}

export function invertMoves(seq) {
  return parseMoves(seq).reverse().map(invertMove);
}

// Merge adjacent turns of the same base (R R → R2, R R' → nothing).
export function simplifyMoves(seq) {
  const out = [];
  for (const mv of parseMoves(seq)) {
    const { base, turns } = moveInfo(mv);
    const prev = out.length ? moveInfo(out[out.length - 1]) : null;
    if (prev && prev.base === base) {
      out.pop();
      const t = (((prev.turns + turns) % 4) + 4) % 4;
      if (t === 1) out.push(base);
      else if (t === 2) out.push(base + '2');
      else if (t === 3) out.push(base + "'");
    } else {
      out.push(mv);
    }
  }
  return out;
}

export function isSolved(facelets) {
  for (let f = 0; f < 6; f++) {
    const face = facelets.slice(f * 9, f * 9 + 9);
    if (face !== face[4].repeat(9)) return false;
  }
  return true;
}

// Stickers of the cubie at position p, e.g. cubieAt(s, [1, 1, 1]) → the UFR corner.
export function cubieAt(facelets, p) {
  return STICKERS.filter((s) => s.pos[0] === p[0] && s.pos[1] === p[1] && s.pos[2] === p[2])
    .map((s) => ({ index: s.index, face: s.face, color: facelets[s.index] }));
}

// Centers can move under slice moves and rotations; this maps each face slot to the
// letter currently at its center (identity for a cube in standard orientation).
export function centers(facelets) {
  return Object.fromEntries(FACES.map((f, i) => [f, facelets[i * 9 + 4]]));
}

// ---- Validation -----------------------------------------------------------------

const POSITIONS = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) POSITIONS.push([x, y, z]);
const nonzero = (p) => p.filter((v) => v !== 0).length;

// Corner slots with stickers in a consistent cyclic order starting from the U/D sticker.
export const CORNER_SLOTS = POSITIONS.filter((p) => nonzero(p) === 3).map((p) => {
  const ud = [0, p[1], 0];
  const others = [[p[0], 0, 0], [0, 0, p[2]]];
  // Order the remaining two so (ud × a) · b > 0: one handedness for every corner.
  const [a, b] = dot(cross(ud, others[0]), others[1]) > 0 ? others : [others[1], others[0]];
  return { pos: p, stickers: [ud, a, b].map((n) => stickerIndex(p, n)) };
});

// Edge slots; stickers[0] is the reference sticker (U/D if present, else F/B).
export const EDGE_SLOTS = POSITIONS.filter((p) => nonzero(p) === 2).map((p) => {
  const ns = [[p[0], 0, 0], [0, p[1], 0], [0, 0, p[2]]].filter((n) => nonzero(n) === 1);
  const rank = (n) => (n[1] !== 0 ? 0 : n[2] !== 0 ? 1 : 2);
  ns.sort((a, b) => rank(a) - rank(b));
  return { pos: p, stickers: ns.map((n) => stickerIndex(p, n)) };
});

function permParity(perm) {
  const seen = new Array(perm.length).fill(false);
  let parity = 0;
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = perm[j]) { seen[j] = true; len++; }
    parity ^= (len - 1) & 1;
  }
  return parity;
}

// Check a facelet string is a reachable cube. Returns { ok, errors: [string] }.
// Letters are face names (U R F D L B) as given by the center of that color.
export function validate(facelets) {
  const errors = [];
  if (typeof facelets !== 'string' || facelets.length !== 54) {
    return { ok: false, errors: ['Need exactly 54 stickers.'] };
  }
  for (const f of FACES) {
    const n = [...facelets].filter((c) => c === f).length;
    if (n !== 9) errors.push(`Color of the ${f} center appears ${n} times (should be 9).`);
  }
  const ctr = centers(facelets);
  if (new Set(Object.values(ctr)).size !== 6) errors.push('Two centers have the same color.');
  if (errors.length) return { ok: false, errors };

  // Reference pieces from the solved state *under these centers* (handles a rotated cube).
  const solvedHere = FACES.map((f) => ctr[f].repeat(9)).join('');
  const oppUD = new Set([ctr.U, ctr.D]);
  const oppFB = new Set([ctr.F, ctr.B]);

  const cornerIds = CORNER_SLOTS.map((s) => s.stickers.map((i) => solvedHere[i]));
  const cornerPerm = [];
  let twist = 0;
  CORNER_SLOTS.forEach((slot, k) => {
    const cols = slot.stickers.map((i) => facelets[i]);
    const t = cols.findIndex((c) => oppUD.has(c));
    const id = cornerIds.findIndex((ref) => t >= 0 && ref[0] === cols[t] && ref[1] === cols[(t + 1) % 3] && ref[2] === cols[(t + 2) % 3]);
    if (id < 0) errors.push(`Corner at ${slot.pos} has colors ${cols.join('')} — no such corner.`);
    cornerPerm[k] = id;
    twist += Math.max(t, 0);
  });

  const edgeIds = EDGE_SLOTS.map((s) => s.stickers.map((i) => solvedHere[i]));
  const edgePerm = [];
  let flip = 0;
  EDGE_SLOTS.forEach((slot, k) => {
    const cols = slot.stickers.map((i) => facelets[i]);
    const id = edgeIds.findIndex((ref) => (ref[0] === cols[0] && ref[1] === cols[1]) || (ref[0] === cols[1] && ref[1] === cols[0]));
    if (id < 0) { errors.push(`Edge at ${slot.pos} has colors ${cols.join('')} — no such edge.`); edgePerm[k] = -1; return; }
    edgePerm[k] = id;
    const refColor = [...edgeIds[id]].sort((a, b) => rankColor(a) - rankColor(b))[0];
    flip += cols[0] === refColor ? 0 : 1;
  });
  function rankColor(c) { return oppUD.has(c) ? 0 : oppFB.has(c) ? 1 : 2; }

  if (errors.length) return { ok: false, errors };
  if (new Set(cornerPerm).size !== 8) errors.push('The same corner appears twice.');
  if (new Set(edgePerm).size !== 12) errors.push('The same edge appears twice.');
  if (errors.length) return { ok: false, errors };
  if (twist % 3 !== 0) errors.push('One corner is twisted in place (a mis-scan, or the cube was taken apart).');
  if (flip % 2 !== 0) errors.push('One edge is flipped in place (a mis-scan, or the cube was taken apart).');
  if (permParity(cornerPerm) !== permParity(edgePerm)) errors.push('Two pieces are swapped (a mis-scan, or the cube was taken apart).');
  return { ok: errors.length === 0, errors };
}

// Random-move scramble with no immediately repeated or cancelling axis moves.
// Pass `rand` (returns [0,1)) for deterministic tests.
export function randomScramble(length = 20, rand = Math.random) {
  const axisOf = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };
  const faces = ['U', 'D', 'R', 'L', 'F', 'B'];
  const out = [];
  while (out.length < length) {
    const f = faces[Math.floor(rand() * 6)];
    const last = out[out.length - 1]?.[0];
    const prev = out[out.length - 2]?.[0];
    if (f === last) continue;
    if (last && prev && axisOf[f] === axisOf[last] && axisOf[f] === axisOf[prev]) continue;
    out.push(f + ['', "'", '2'][Math.floor(rand() * 3)]);
  }
  return out;
}
