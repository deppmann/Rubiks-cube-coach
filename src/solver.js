// Beginner layer-by-layer solver, written for coaching rather than speed. White (the D
// center) is solved first on the bottom, yellow (U) last. Every step is what a learner does
// next: an optional whole-cube turn (y), then face turns, with a plain-English reason.
//
// Nothing here knows any sticker permutation: pieces are found by their colors, moves are
// simulated with cube.js, and every "turn until it fits" choice is made by trying the turn
// on the real state. Everything is relative to the centers currently in the input.

import {
  COLOR_OF, FACES, STICKERS, EDGE_SLOTS, CORNER_SLOTS,
  applyMoves, centers, invertMoves, isSolved, simplifyMoves, validate,
} from './cube.js';

export const STAGES = [
  { id: 'cross', title: 'White cross' },
  { id: 'whiteCorners', title: 'White corners' },
  { id: 'middle', title: 'Middle layer' },
  { id: 'yellowCross', title: 'Yellow cross' },
  { id: 'yellowEdges', title: 'Match yellow edges' },
  { id: 'yellowCornersPosition', title: 'Place yellow corners' },
  { id: 'yellowCornersOrient', title: 'Twist yellow corners' },
];

// ---- Geometry helpers ---------------------------------------------------------------

const SIDES = ['F', 'R', 'B', 'L'];
const RIGHT_OF = { F: 'R', R: 'B', B: 'L', L: 'F' }; // what you see on the right when facing that side
const LEFT_OF = { F: 'L', L: 'B', B: 'R', R: 'F' };
const OPPOSITE = { F: 'B', B: 'F', R: 'L', L: 'R' };
const WORD = { F: 'front', R: 'right', B: 'back', L: 'left', U: 'top', D: 'bottom' };

const CENTER_OF = STICKERS.map((s) => FACES.indexOf(s.face) * 9 + 4);
const faceOf = (i) => STICKERS[i].face;
const topEdges = EDGE_SLOTS.filter((sl) => sl.pos[1] === 1);
const topCorners = CORNER_SLOTS.filter((sl) => sl.pos[1] === 1);
const layerEdges = (y) => EDGE_SLOTS.filter((sl) => sl.pos[1] === y);
const cornerAt = (p) => CORNER_SLOTS.find((sl) => sl.pos.join() === p.join());

// A piece is solved when every sticker matches the center of the face it sits on.
const isPieceSolved = (s, slot) => slot.stickers.every((i) => s[i] === s[CENTER_OF[i]]);
const layerOf = (slot) => slot.pos[1];
const stickerOn = (slot, face) => slot.stickers.find((i) => faceOf(i) === face);
const sideFacesOf = (slot) => slot.stickers.map(faceOf).filter((f) => f !== 'U' && f !== 'D');

// The slot currently holding the piece made of these colors (2 = edge, 3 = corner).
function slotOf(s, colors) {
  const want = [...colors].sort().join('');
  const list = colors.length === 2 ? EDGE_SLOTS : CORNER_SLOTS;
  return list.find((sl) => sl.stickers.map((i) => s[i]).sort().join('') === want);
}

// Same algorithm seen from another face: F,R,L,B become g and its neighbours.
const relabel = (seq, g) => seq.map((m) => (({ F: g, R: RIGHT_OF[g], L: LEFT_OF[g], B: OPPOSITE[g] })[m[0]] ?? m[0]) + m.slice(1));

const Y_TURNS = [[], ['y'], ["y'"], ['y2']];
const U_TURNS = [[], ['U'], ["U'"], ['U2']];
// First turn in the list after which `ok(state)` holds (undefined if none does).
const tryTurns = (s, turns, ok) => turns.find((t) => ok(applyMoves(s, t)));

const SEXY = ['R', 'U', "R'", "U'"];
const MIDDLE_RIGHT = ['U', 'R', "U'", "R'", "U'", "F'", 'U', 'F'];
const MIDDLE_LEFT = ["U'", "L'", 'U', 'L', 'U', 'F', "U'", "F'"];
const YELLOW_CROSS = ['F', 'R', 'U', "R'", "U'", "F'"];
const SUNE = ['R', 'U', "R'", 'U', 'R', 'U2', "R'"];
const CORNER_CYCLE = ['U', 'R', "U'", "L'", 'U', "R'", "U'", 'L'];
const CORNER_TWIST = ["R'", "D'", 'R', 'D'];

const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const join = (m) => m.join(' ');
const list = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// Iterative deepening over "hold the cube some way (y turns), do the algorithm" until
// done(state) is true. Returns the y turns to use for each application, or null.
// `settle` lets a stage tidy the state (e.g. turn U) between applications.
// `order(state)` may list the y turns in the order to try them (the textbook hold first).
function plan(s, alg, done, settle = (x) => x, order = () => Y_TURNS, maxDepth = 4) {
  const go = (st, d) => {
    for (const k of order(st)) {
      const nx = settle(applyMoves(st, [...k, ...alg]));
      if (done(nx)) return [k];
      if (d > 1) {
        const rest = go(nx, d - 1);
        if (rest) return [k, ...rest];
      }
    }
    return null;
  };
  for (let d = 1; d <= maxDepth; d++) {
    const p = go(s, d);
    if (p) return p;
  }
  return null;
}

// ---- Recorder -----------------------------------------------------------------------

class Run {
  constructor(start, colorOf) {
    this.s = start;
    this.colorOf = colorOf;
    this.moves = [];
    this.stages = [];
    this.cur = null;
  }

  col(letter) { return this.colorOf[letter] ?? letter; }

  begin({ id, title }) {
    this.cur = { id, title, steps: [] };
    this.stages.push(this.cur);
  }

  // Apply `seq`, then record it. `hl(state)` names the stickers the step is about, looked
  // up in the state AFTER the step so the viewer can point at where the piece ended up.
  step(seq, explain, hl) {
    const moves = simplifyMoves(seq);
    this.s = applyMoves(this.s, moves);
    this.moves.push(...moves);
    const highlight = [...new Set(hl(this.s))].sort((a, b) => a - b);
    this.cur.steps.push({ moves, explain, highlight, after: this.s });
  }
}

const pieceHl = (colors) => (s) => slotOf(s, colors).stickers;
const slotsHl = (slots) => () => slots.flatMap((sl) => sl.stickers);

// ---- 1. White cross -----------------------------------------------------------------

function crossStage(r) {
  const c0 = centers(r.s);
  const W = c0.D;
  const sides = SIDES.map((f) => c0[f]);
  const solved = (c) => isPieceSolved(r.s, slotOf(r.s, [W, c]));
  const name = (c) => `${r.col(W)}-${r.col(c)} edge`;

  const already = sides.filter(solved);
  for (const c of already) {
    r.step([], `The ${name(c)} is already in place next to the ${r.col(c)} center.`, pieceHl([W, c]));
  }
  for (const c of sides) {
    if (already.includes(c)) continue;
    for (let guard = 0; !solved(c); guard++) {
      if (guard > 6) throw new Error(`cross: stuck on ${name(c)}`);
      crossMove(r, W, c, name(c));
    }
  }
}

// One move of progress on the white-c edge: get it to the top, flip it, or drop it in.
function crossMove(r, W, c, name) {
  const s = r.s;
  const fc = SIDES.find((f) => centers(s)[f] === c); // face whose center is c
  const sl = slotOf(s, [W, c]);
  const hl = pieceHl([W, c]);
  const white = r.col(W);
  const upIdx = stickerOn(sl, 'U');

  if (layerOf(sl) === -1) {
    // Bottom layer but wrong spot or flipped: a half turn of its side face sends it up
    // and leaves the other cross edges alone.
    const g = sideFacesOf(sl)[0];
    r.step([g + '2'], `The ${name} is on the bottom layer but not in its place. Turn ${g} twice to send it up to the top layer.`, hl);
    return;
  }
  if (layerOf(sl) === 0) {
    // Middle layer: turn a side face to lift it, slide U out of the way, turn back.
    let best;
    for (const g of sideFacesOf(sl)) {
      for (const t of [g, g + "'"]) {
        for (const u of ['U', "U'", 'U2']) {
          const seq = [t, u, ...invertMoves(t)];
          const s2 = applyMoves(s, seq);
          const e2 = slotOf(s2, [W, c]);
          if (layerOf(e2) !== 1) continue;
          const up = s2[stickerOn(e2, 'U')] === W;
          const cost = up ? tryTurns(s2, U_TURNS, (x) => placed(x, W, c, fc)).length : 4; // 4 = flip macro
          if (!best || cost < best.cost) best = { seq, cost };
        }
      }
    }
    r.step(best.seq, `The ${name} is stuck in the middle layer. ${join(best.seq)} lifts it to the top layer without disturbing the cross.`, hl);
    return;
  }
  if (s[upIdx] !== W) {
    // Top layer with white on the side: this 4-move flip puts white on top.
    const g = faceOf(sl.stickers.find((i) => s[i] === W));
    const flip = relabel(["R'", 'F', 'R', "F'"], g);
    r.step(flip, `The ${name} is on the top layer with ${white} facing sideways. ${join(flip)} flips it so ${white} faces up.`, hl);
    return;
  }
  const turns = tryTurns(s, U_TURNS, (x) => placed(x, W, c, fc));
  const lead = turns.length
    ? `Turn U until it sits over the ${r.col(c)} center, then ${fc}2 drops it into the cross.`
    : `It is right above the ${r.col(c)} center, so ${fc}2 drops it into the cross.`;
  r.step([...turns, fc + '2'], `The ${name} is on top with ${white} facing up. ${lead}`, hl);
}

// White edge on top with its c sticker on the side over the c center.
const placed = (s, W, c, fc) => {
  const e = slotOf(s, [W, c]);
  return layerOf(e) === 1 && s[stickerOn(e, 'U')] === W && s[stickerOn(e, fc)] === c;
};

// ---- 2. White corners ---------------------------------------------------------------

function whiteCornersStage(r) {
  const c0 = centers(r.s);
  const W = c0.D;
  // Slots in the order they arrive at front-right when turning the cube with y: FR, RB, BL, LF.
  const slots = [[c0.F, c0.R], [c0.R, c0.B], [c0.B, c0.L], [c0.L, c0.F]];
  const solved = ([a, b]) => isPieceSolved(r.s, slotOf(r.s, [W, a, b]));
  const name = ([a, b]) => `${r.col(W)}-${r.col(a)}-${r.col(b)} corner`;

  const already = slots.filter(solved);
  for (const p of already) {
    r.step([], `The ${name(p)} is already in its spot in the bottom layer.`, pieceHl([W, ...p]));
  }
  for (const p of slots) {
    if (already.includes(p)) continue;
    for (let guard = 0; !solved(p); guard++) {
      if (guard > 6) throw new Error(`whiteCorners: stuck on ${name(p)}`);
      cornerMove(r, W, p, name(p));
    }
  }
}

function cornerMove(r, W, [a, b], name) {
  const s = r.s;
  const colors = [W, a, b];
  const hl = pieceHl(colors);
  const sl = slotOf(s, colors);

  if (layerOf(sl) === -1) {
    // Wrong bottom slot (or twisted in its own): turn it to front-right and pop it up.
    const k = tryTurns(s, Y_TURNS, (x) => slotOf(x, colors).pos.join() === '1,-1,1');
    const how = k.length ? 'Turn the whole cube so that corner is at the front-right, then do' : 'Do';
    const home = sideFacesOf(sl).every((f) => [a, b].includes(s[CENTER_OF[stickerOn(sl, f)]]));
    const where = home ? `in its spot but twisted (${r.col(W)} is not facing down)` : 'in the bottom layer but not in its spot';
    r.step([...k, ...SEXY], `The ${name} is ${where}. ${how} ${join(SEXY)} to pop it out into the top layer.`, hl);
    return;
  }
  // Top layer: hold the cube so its home is front-right, then park it right above.
  const k = tryTurns(s, Y_TURNS, (x) => centers(x).F === a && centers(x).R === b);
  const s1 = applyMoves(s, k);
  const u = tryTurns(s1, U_TURNS, (x) => slotOf(x, colors).pos.join() === '1,1,1');
  const setup = [...k, ...u];
  if (setup.length) {
    const parts = [];
    if (k.length) parts.push(`turn the whole cube so the ${r.col(a)} center is in front and ${r.col(b)} is on the right (that is where this corner belongs, just below)`);
    if (u.length) parts.push(`turn U until the corner sits at the top front-right, right above its spot`);
    r.step(setup, `The ${name} is on the top layer, so ${list(parts)}.`, hl);
  }
  const s2 = applyMoves(s1, u);
  let seq = [];
  let n = 0;
  do {
    seq = [...seq, ...SEXY];
    n++;
  } while (n < 6 && !isPieceSolved(applyMoves(s2, seq), slotOf(applyMoves(s2, seq), colors)));
  r.step(seq, `Repeat ${join(SEXY)} ${times(n)}. Each round twists the corner a bit, and after ${n} it drops in with ${r.col(W)} facing down.`, hl);
}

// ---- 3. Middle layer ----------------------------------------------------------------

function middleStage(r) {
  const c0 = centers(r.s);
  const targets = [[c0.F, c0.R], [c0.R, c0.B], [c0.B, c0.L], [c0.L, c0.F]];
  const solved = (p) => isPieceSolved(r.s, slotOf(r.s, p));
  const name = ([a, b]) => `${r.col(a)}-${r.col(b)} edge`;

  const already = targets.filter(solved);
  for (const p of already) r.step([], `The ${name(p)} is already in its slot in the middle layer.`, pieceHl(p));

  for (let guard = 0; ; guard++) {
    const todo = targets.filter((p) => !solved(p));
    if (!todo.length) break;
    if (guard > 12) throw new Error('middle: stuck');
    const s = r.s;

    // Prefer an edge that is already on the top layer; pick the one needing least setup.
    let best;
    for (const p of todo.filter((q) => layerOf(slotOf(s, q)) === 1)) {
      const sl = slotOf(s, p);
      const x = s[sl.stickers.find((i) => faceOf(i) !== 'U')]; // side color: must meet its center
      const z = s[stickerOn(sl, 'U')];
      const k = tryTurns(s, Y_TURNS, (v) => centers(v).F === x);
      const s1 = applyMoves(s, k);
      const u = tryTurns(s1, U_TURNS, (v) => slotOf(v, p).pos.join() === '0,1,1');
      const cost = k.length + u.length;
      if (!best || cost < best.cost) best = { p, x, z, k, u, cost };
    }
    if (best) {
      const { p, x, z, k, u } = best;
      const s2 = applyMoves(s, [...k, ...u]);
      const right = centers(s2).R === z;
      if (k.length + u.length) {
        const parts = [];
        if (k.length) parts.push(`turn the whole cube so the ${r.col(x)} center faces you`);
        if (u.length) parts.push(`turn U until the edge sits right above the ${r.col(x)} center`);
        r.step([...k, ...u], `The ${name(p)} is on the top layer, so ${list(parts)}.`, pieceHl(p));
      }
      const alg = right ? MIDDLE_RIGHT : MIDDLE_LEFT;
      r.step(alg, `The edge's top color is ${r.col(z)}, which is the center on your ${right ? 'right' : 'left'}, so ${join(alg)} tucks it into the middle layer on that side.`, pieceHl(p));
      continue;
    }
    // Everything left is in the middle layer but wrong/flipped: pop one out with the same
    // algorithm (it swaps in whatever is on the top front edge).
    const p = todo[0];
    const k = tryTurns(s, Y_TURNS, (v) => slotOf(v, p).pos.join() === '1,0,1');
    const turn = k.length ? 'Turn the whole cube so that spot is at the front-right, then do ' : 'Do ';
    r.step([...k, ...MIDDLE_RIGHT], `The ${name(p)} is in the middle layer but in the wrong spot or flipped. ${turn}${join(MIDDLE_RIGHT)} to kick it out to the top layer.`, pieceHl(p));
  }
}

// ---- 4. Yellow cross ----------------------------------------------------------------

const yellowUpEdges = (s, Y) => topEdges.filter((sl) => s[stickerOn(sl, 'U')] === Y);

// Textbook hold: an L sits at the back-left, a line runs left to right.
function yellowCrossStage(r) {
  const Y = centers(r.s).U;
  const y = r.col(Y);
  const count = (s) => yellowUpEdges(s, Y).length;
  const allTop = slotsHl(topEdges);
  const textbookHold = (st) => {
    const ups = yellowUpEdges(st, Y);
    if (ups.length !== 2) return Y_TURNS;
    const line = ups[0].pos[0] === -ups[1].pos[0] && ups[0].pos[2] === -ups[1].pos[2];
    const want = line ? '-1,1,0|1,1,0' : '-1,1,0|0,1,-1';
    const good = Y_TURNS.find((k) => yellowUpEdges(applyMoves(st, k), Y).map((sl) => sl.pos.join()).sort().join('|') === want);
    return good ? [good, ...Y_TURNS.filter((k) => k !== good)] : Y_TURNS;
  };
  if (count(r.s) === 4) {
    r.step([], `The ${y} cross is already on top.`, allTop);
    return;
  }
  for (let guard = 0; count(r.s) < 4; guard++) {
    if (guard > 4) throw new Error('yellowCross: stuck');
    const s = r.s;
    const k = plan(s, YELLOW_CROSS, (x) => count(x) === 4, undefined, textbookHold)[0];
    const held = applyMoves(s, k);
    const up = yellowUpEdges(held, Y);
    const n = up.length;
    let shape;
    if (n === 0) shape = `Only the ${y} center is on top (a dot)`;
    else if (up[0].pos[0] === -up[1].pos[0] && up[0].pos[2] === -up[1].pos[2]) shape = `The ${y} edges make a straight line`;
    else shape = `The ${y} edges make an L`;
    const hold = !k.length ? '' : shape.endsWith('L') ? ' Turn the whole cube so the L sits at the back-left,' : ' Turn the whole cube so the line runs left to right,';
    r.step([...k, ...YELLOW_CROSS], `${shape}.${hold} ${hold ? 'then do' : 'Do'} ${join(YELLOW_CROSS)} to bring more ${y} edges up.`, allTop);
  }
}

// ---- 5. Match yellow edges ----------------------------------------------------------

const edgeMatches = (s, sl) => {
  const i = sl.stickers.find((j) => faceOf(j) !== 'U');
  return s[i] === s[CENTER_OF[i]];
};
const matchCount = (s) => topEdges.filter((sl) => edgeMatches(s, sl)).length;
// The U turn that lines up the most side colors with their centers (fewest turns on ties).
function bestAlign(s) {
  let best = U_TURNS[0];
  let bestN = -1;
  for (const t of U_TURNS) {
    const n = matchCount(applyMoves(s, t));
    if (n > bestN) { best = t; bestN = n; }
  }
  return { turns: best, n: bestN };
}
const settleEdges = (s) => applyMoves(s, bestAlign(s).turns);
// Textbook hold (as in LESSONS.yellowEdges): two neighbours matching go at the back and
// right, two opposite ones at the back and front. Other holds are only a fallback.
function textbookEdgeHold(st) {
  const want = (x) => {
    const faces = topEdges.filter((sl) => edgeMatches(x, sl)).map((sl) => sideFacesOf(sl)[0]).sort().join('');
    return faces === 'BR' || faces === 'BF';
  };
  return [...Y_TURNS.filter((k) => want(applyMoves(st, k))), ...Y_TURNS.filter((k) => !want(applyMoves(st, k)))];
}

function yellowEdgesStage(r) {
  const allTop = slotsHl(topEdges);
  for (let guard = 0; ; guard++) {
    if (guard > 5) throw new Error('yellowEdges: stuck');
    const { turns, n } = bestAlign(r.s);
    if (n === 4) {
      if (turns.length) r.step(turns, 'Turn U until all four side colors sit over their matching centers.', allTop);
      else if (!r.cur.steps.length) r.step([], 'All four yellow edges already match their side centers.', allTop);
      return;
    }
    if (turns.length) r.step(turns, `Turn U until as many side colors as possible match their centers (${n} do now).`, allTop);
    const s = r.s;
    const k = plan(s, SUNE, (x) => matchCount(x) === 4, settleEdges, textbookEdgeHold)[0];
    const held = applyMoves(s, k);
    const matched = topEdges.filter((sl) => edgeMatches(held, sl));
    const colors = matched.map((sl) => r.col(held[sl.stickers.find((j) => faceOf(j) !== 'U')]));
    const spots = matched.map((sl) => WORD[sideFacesOf(sl)[0]]);
    const where = spots.length === 1 ? `at the ${spots[0]}` : `at the ${list(spots)}`;
    const hold = k.length ? 'Turn the whole cube so they are ' : 'They are ';
    const opposite = matched.length === 2 && OPPOSITE[sideFacesOf(matched[0])[0]] === sideFacesOf(matched[1])[0];
    const effect = opposite
      ? 'mixes the edges so that two neighbouring ones match; then do it again from there'
      : 'cycles the other edges';
    r.step([...k, ...SUNE], `The ${list(colors)} edge${matched.length > 1 ? 's' : ''} already match${matched.length > 1 ? '' : 'es'}. ${hold}${where}, then ${join(SUNE)} ${effect}.`, allTop);
  }
}

// ---- 6. Place yellow corners --------------------------------------------------------

// A corner is "placed" when it sits between the centers of its own three colors (twist ignored).
const cornerPlaced = (s, sl) => {
  const want = sl.stickers.map((i) => s[CENTER_OF[i]]).sort().join('');
  return sl.stickers.map((i) => s[i]).sort().join('') === want;
};
const placedCount = (s) => topCorners.filter((sl) => cornerPlaced(s, sl)).length;

function yellowCornersPositionStage(r) {
  const allTop = slotsHl(topCorners);
  if (placedCount(r.s) === 4) {
    r.step([], 'All four yellow corners are already in the right spots.', allTop);
    return;
  }
  for (let guard = 0; placedCount(r.s) < 4; guard++) {
    if (guard > 4) throw new Error('yellowCornersPosition: stuck');
    const s = r.s;
    const k = plan(s, CORNER_CYCLE, (x) => placedCount(x) === 4)[0];
    const held = applyMoves(s, k);
    const good = topCorners.filter((sl) => cornerPlaced(held, sl));
    let why;
    if (good.length === 1) {
      const [g] = good;
      const spot = `${WORD[g.pos[2] === 1 ? 'F' : 'B']}-${WORD[g.pos[0] === 1 ? 'R' : 'L']}`;
      why = `One corner is already in the right spot. Hold the cube so it is at the top ${spot}, then ${join(CORNER_CYCLE)} cycles the other three.`;
    } else {
      why = `No corner is in the right spot yet. Do ${join(CORNER_CYCLE)} once from any angle, then look again for a corner that is right.`;
    }
    r.step([...k, ...CORNER_CYCLE], why, allTop);
  }
}

// ---- 7. Twist yellow corners --------------------------------------------------------

function yellowCornersOrientStage(r) {
  const Y = centers(r.s).U;
  const y = r.col(Y);
  const ufr = cornerAt([1, 1, 1]);
  const twisted = (s, sl) => s[stickerOn(sl, 'U')] !== Y;
  const front = (s) => twisted(s, ufr);

  for (let guard = 0; topCorners.some((sl) => twisted(r.s, sl)); guard++) {
    if (guard > 6) throw new Error('yellowCornersOrient: stuck');
    const s = r.s;
    const u = tryTurns(s, U_TURNS, front);
    const s1 = applyMoves(s, u);
    const colors = ufr.stickers.map((i) => s1[i]);
    const [a, b] = colors.filter((c) => c !== Y);
    const name = `${y}-${r.col(a)}-${r.col(b)} corner`;
    if (u.length) r.step(u, `The ${name} still has ${y} on the side. Turn U to bring it to the top front-right.`, pieceHl(colors));
    const towards = WORD[faceOf(ufr.stickers.find((i) => s1[i] === Y))];
    let seq = [];
    let n = 0;
    do {
      seq = [...seq, ...CORNER_TWIST];
      n++;
    } while (n < 6 && twisted(applyMoves(s1, seq), ufr));
    r.step(seq, `The ${name} has its ${y} sticker facing ${towards}. Repeat ${join(CORNER_TWIST)} ${times(n)} until it faces up (the bottom looks scrambled halfway, but it comes back).`, pieceHl(colors));
  }
  const fin = tryTurns(r.s, U_TURNS, isSolved);
  if (fin.length) {
    r.step(fin, `Every corner has ${y} on top now. Turn U to line up the top layer, and the cube is solved.`, slotsHl(topCorners));
  } else if (!r.cur.steps.length) {
    r.step([], `All the ${y} corners already face up and the cube is solved.`, slotsHl(topCorners));
  }
}

// ---- Entry point --------------------------------------------------------------------

const RUNNERS = {
  cross: crossStage,
  whiteCorners: whiteCornersStage,
  middle: middleStage,
  yellowCross: yellowCrossStage,
  yellowEdges: yellowEdgesStage,
  yellowCornersPosition: yellowCornersPositionStage,
  yellowCornersOrient: yellowCornersOrientStage,
};

export function solveBeginner(facelets, { colorOf = COLOR_OF } = {}) {
  const v = validate(facelets);
  if (!v.ok) return { ok: false, error: v.errors[0], stages: [], moves: [] };
  const r = new Run(facelets, colorOf);
  try {
    for (const stage of STAGES) {
      r.begin(stage);
      RUNNERS[stage.id](r);
    }
    if (!isSolved(r.s)) throw new Error('the solver ended on an unsolved cube');
  } catch (e) {
    return { ok: false, error: `Solver failed: ${e.message}`, stages: [], moves: [] };
  }
  return { ok: true, stages: r.stages, moves: r.moves };
}
