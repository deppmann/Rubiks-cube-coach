import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLVED, COLOR_OF, FACES, applyMoves, isSolved, randomScramble, centers, validate,
  CORNER_SLOTS, EDGE_SLOTS, STICKERS,
} from '../src/cube.js';
import { solveBeginner, STAGES } from '../src/solver.js';

// Deterministic PRNG for reproducible scrambles.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALLOWED = /^([URFDLB]|y)(2|')?$/;
const IDS = ['cross', 'whiteCorners', 'middle', 'yellowCross', 'yellowEdges', 'yellowCornersPosition', 'yellowCornersOrient'];
const TITLES = ['White cross', 'White corners', 'Middle layer', 'Yellow cross', 'Match yellow edges', 'Place yellow corners', 'Twist yellow corners'];

// Independent stage checks, written against the cube.js slot tables (not the solver's helpers).
const centerIdx = (i) => FACES.indexOf(STICKERS[i].face) * 9 + 4;
const slotSolved = (s, sl) => sl.stickers.every((i) => s[i] === s[centerIdx(i)]);
const edgesIn = (y) => EDGE_SLOTS.filter((sl) => sl.pos[1] === y);
const cornersIn = (y) => CORNER_SLOTS.filter((sl) => sl.pos[1] === y);
const allSolved = (s, slots) => slots.every((sl) => slotSolved(s, sl));
const cornerPlaced = (s, sl) => sl.stickers.map((i) => s[i]).sort().join('') === sl.stickers.map(centerIdx).map((i) => s[i]).sort().join('');

const INVARIANTS = {
  cross: (s) => allSolved(s, edgesIn(-1)),
  whiteCorners: (s) => allSolved(s, edgesIn(-1)) && allSolved(s, cornersIn(-1)),
  middle: (s) => allSolved(s, edgesIn(-1)) && allSolved(s, cornersIn(-1)) && allSolved(s, edgesIn(0)),
  yellowCross: (s) => INVARIANTS.middle(s)
    && edgesIn(1).every((sl) => s[sl.stickers.find((i) => STICKERS[i].face === 'U')] === s[centerIdx(sl.stickers[0])]),
  yellowEdges: (s) => INVARIANTS.middle(s) && allSolved(s, edgesIn(1)),
  yellowCornersPosition: (s) => INVARIANTS.yellowEdges(s) && cornersIn(1).every((sl) => cornerPlaced(s, sl)),
  yellowCornersOrient: (s) => isSolved(s),
};

const stats = { count: 0, total: 0, max: 0 };

// Full contract check of one solve; returns the result.
function checkSolve(start, opts) {
  const res = solveBeginner(start, opts);
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.stages.map((st) => st.id), IDS);
  assert.deepEqual(res.stages.map((st) => st.title), TITLES);

  let state = start;
  const all = [];
  for (const stage of res.stages) {
    assert.ok(stage.steps.length > 0, `${stage.id} has no steps`);
    for (const step of stage.steps) {
      assert.ok(Array.isArray(step.moves));
      for (const m of step.moves) assert.match(m, ALLOWED);
      assert.equal(typeof step.explain, 'string');
      assert.ok(step.explain.length > 10, 'explanation present');
      assert.ok(Array.isArray(step.highlight));
      for (const i of step.highlight) assert.ok(Number.isInteger(i) && i >= 0 && i < 54);
      state = applyMoves(state, step.moves);
      assert.equal(step.after, state, `${stage.id}: step.after matches its moves`);
      if (step.moves.length === 0) assert.match(step.explain, /already/i, 'empty steps only say a piece is done');
      all.push(...step.moves);
    }
    assert.ok(INVARIANTS[stage.id](state), `${stage.id} invariant failed`);
  }
  assert.deepEqual(res.moves, all, 'moves is the concatenation of the steps');
  assert.ok(isSolved(applyMoves(start, res.moves)), 'moves solve the cube');
  return res;
}

test('STAGES lists the seven stages in order', () => {
  assert.deepEqual(STAGES.map((s) => s.id), IDS);
  assert.deepEqual(STAGES.map((s) => s.title), TITLES);
});

test('solved cube: ok with zero moves', () => {
  const res = checkSolve(SOLVED);
  assert.deepEqual(res.moves, []);
});

test('invalid cubes are rejected with the first validation error', () => {
  const twisted = applyMoves(SOLVED, 'R U R\' U\'').split('');
  [twisted[8], twisted[9]] = [twisted[9], twisted[8]]; // swap two stickers: impossible cube
  for (const bad of ['too short', SOLVED.replace('UUUUUUUUU', 'UUUUUUUUR'), twisted.join('')]) {
    const res = solveBeginner(bad);
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
    assert.deepEqual(res.stages, []);
    assert.deepEqual(res.moves, []);
    assert.equal(res.error, validate(bad).errors[0]);
  }
});

test('2000 seeded random scrambles solve, stage by stage', () => {
  const rand = mulberry32(20240607);
  for (let n = 0; n < 2000; n++) {
    const scramble = randomScramble(20 + (n % 8), rand);
    const res = checkSolve(applyMoves(SOLVED, scramble));
    stats.count++;
    stats.total += res.moves.length;
    stats.max = Math.max(stats.max, res.moves.length);
  }
});

test('short scrambles (mostly-solved cubes) solve too', () => {
  const rand = mulberry32(7);
  for (let n = 0; n < 600; n++) checkSolve(applyMoves(SOLVED, randomScramble(1 + (n % 7), rand)));
});

test('every single move and small pairs solve', () => {
  const singles = ['U', "U'", 'U2', 'D', "D'", 'D2', 'R', "R'", 'R2', 'L', "L'", 'L2', 'F', "F'", 'F2', 'B', "B'", 'B2'];
  for (const a of singles) {
    checkSolve(applyMoves(SOLVED, a));
    for (const b of singles) checkSolve(applyMoves(SOLVED, [a, b]));
  }
});

test('a cube held in another orientation still solves', () => {
  const rand = mulberry32(99);
  for (const hold of ['y', "y'", 'y2', 'x2', 'x', "z'"]) {
    const held = applyMoves(SOLVED, hold);
    assert.notEqual(centers(held).F + centers(held).U, 'FU'.slice(0, 2)); // really re-oriented
    for (let n = 0; n < 60; n++) {
      const res = checkSolve(applyMoves(held, randomScramble(22, rand)));
      stats.count++;
      stats.total += res.moves.length;
      stats.max = Math.max(stats.max, res.moves.length);
    }
    // The already-solved cube in that orientation needs nothing.
    assert.deepEqual(checkSolve(held).moves, []);
  }
});

test('explanations use colorOf, keyed by center letter', () => {
  const names = { U: 'Y!', D: 'W!', F: 'G!', B: 'B!', R: 'O!', L: 'R!' };
  const res = solveBeginner(applyMoves(SOLVED, randomScramble(20, mulberry32(3))), { colorOf: names });
  assert.equal(res.ok, true);
  const text = res.stages.flatMap((s) => s.steps.map((st) => st.explain)).join(' ');
  assert.match(text, /W!-G! edge|W!-O! edge|W!-B! edge|W!-R! edge/);
  assert.doesNotMatch(text, /\bwhite\b|\bgreen\b/);
  const def = solveBeginner(applyMoves(SOLVED, "R U R' U'")).stages[0].steps.map((st) => st.explain).join(' ');
  assert.match(def, /white/);
  assert.equal(COLOR_OF.D, 'white');
});

test('highlight points at the piece where it ends up', () => {
  const start = applyMoves(SOLVED, randomScramble(20, mulberry32(11)));
  const res = solveBeginner(start);
  const first = res.stages[0].steps.find((s) => s.moves.length);
  // The cross step ends with a white edge in the bottom layer: two stickers, one is white (D letter).
  assert.equal(first.highlight.length, 2);
  assert.ok(first.highlight.some((i) => first.after[i] === 'D'));
  const corner = res.stages[1].steps.filter((s) => s.moves.length).pop();
  assert.equal(corner.highlight.length, 3);
});

test('move-count report', () => {
  const avg = stats.total / stats.count;
  console.log(`solver moves over ${stats.count} scrambles: average ${avg.toFixed(1)}, max ${stats.max}`);
  assert.ok(avg < 250 && stats.max < 400, 'beginner solutions stay a sane length');
});

// Every step with the state it started from.
function stepsWithBefore(start) {
  const res = solveBeginner(start);
  assert.equal(res.ok, true, res.error);
  let before = start;
  const out = [];
  for (const stage of res.stages) {
    for (const step of stage.steps) { out.push({ id: stage.id, step, before }); before = step.after; }
  }
  return out;
}
const COLOR_LETTER = Object.fromEntries(Object.entries(COLOR_OF).map(([k, v]) => [v, k]));
const slotOfColors = (s, cols) => [...EDGE_SLOTS, ...CORNER_SLOTS].find((sl) => sl.stickers.length === cols.length
  && sl.stickers.map((i) => s[i]).sort().join('') === [...cols].sort().join(''));
const yTurnsOf = (moves) => moves.filter((m) => m[0] === 'y');

test('a white corner twisted in its own slot is not called "not in its spot"', () => {
  const rand = mulberry32(404);
  let twisted = 0;
  for (let n = 0; n < 300; n++) {
    for (const { id, step, before } of stepsWithBefore(applyMoves(SOLVED, randomScramble(20, rand)))) {
      if (id !== 'whiteCorners' || !/pop it out/.test(step.explain)) continue;
      const cols = step.explain.match(/The (\w+)-(\w+)-(\w+) corner/).slice(1).map((c) => COLOR_LETTER[c]);
      const sl = slotOfColors(before, cols);
      const home = cols.slice(1).every((c) => sl.stickers.some((i) => before[centerIdx(i)] === c));
      if (home) twisted++;
      assert.equal(/twisted/.test(step.explain), home, step.explain);
      assert.equal(/not in its spot/.test(step.explain), !home, step.explain);
    }
  }
  assert.ok(twisted > 0, 'the case was exercised');
});

test('yellow edges use the lesson holds: neighbours at back and right, opposites at back and front', () => {
  const rand = mulberry32(505);
  const seen = { neighbours: 0, opposite: 0 };
  for (let n = 0; n < 400; n++) {
    for (const { id, step, before } of stepsWithBefore(applyMoves(SOLVED, randomScramble(20, rand)))) {
      if (id !== 'yellowEdges' || !step.moves.includes('R')) continue;
      const held = applyMoves(before, yTurnsOf(step.moves));
      const at = edgesIn(1).filter((sl) => held[sl.stickers[1]] === held[centerIdx(sl.stickers[1])])
        .map((sl) => STICKERS[sl.stickers[1]].face).sort().join('');
      if (at === 'BR') {
        seen.neighbours++;
        assert.match(step.explain, /at the back and right|at the right and back/);
        assert.match(step.explain, /cycles the other edges/);
        // One Sune plus a U turn finishes the edges, as the lesson promises.
        assert.ok(['', 'U', "U'", 'U2'].some((u) => allSolved(applyMoves(step.after, u), edgesIn(1))));
      } else {
        assert.equal(at, 'BF', step.explain);
        seen.opposite++;
        assert.match(step.explain, /two neighbouring ones match/);
      }
    }
  }
  assert.ok(seen.neighbours > 0 && seen.opposite > 0);
});

test('lesson algorithms cover what the cross stage actually does', async () => {
  const { LESSONS } = await import('../src/lessons.js');
  const algs = LESSONS.cross.algorithms.map((a) => a.moves);
  assert.ok(algs.includes('F2'));
  assert.ok(algs.includes("R' F R F'"));
  assert.doesNotMatch(LESSONS.cross.algorithms[0].when, /facing up or/);
  const rand = mulberry32(606);
  for (let n = 0; n < 100; n++) {
    for (const { id, step } of stepsWithBefore(applyMoves(SOLVED, randomScramble(20, rand)))) {
      if (id === 'cross' && /flips it/.test(step.explain)) {
        // Same shape as R' F R F', seen from another side: A' B A B'.
        const [a, b, c, d] = step.moves;
        assert.equal(step.moves.length, 4);
        assert.ok(a === `${c}'` && d === `${b}'`, step.moves.join(' '));
      }
    }
  }
});
