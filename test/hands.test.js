import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMoves, SOLVED, randomScramble } from '../src/cube.js';
import { solveBeginner } from '../src/solver.js';
import { motionFor, flickProgress, twoBoneIK } from '../src/hands.js';
import { gripFor, NOTATION } from '../src/lessons.js';

const len = (a) => Math.hypot(...a);
const sub = (a, b) => a.map((v, i) => v - b[i]);

const MOVES = [];
for (const b of 'URFDLB') for (const s of ['', "'", '2']) MOVES.push(b + s);
for (const s of ['', "'", '2']) MOVES.push('y' + s);

test('motion table: the hand/finger for every face move', () => {
  const want = {
    R: ['wrist', 'right'], "R'": ['wrist', 'right'], R2: ['wrist', 'right'],
    L: ['wrist', 'left'], "L'": ['wrist', 'left'], L2: ['wrist', 'left'],
    U: ['flick', 'right', 'index'], "U'": ['flick', 'left', 'index'], U2: ['flick', 'right', 'index'],
    D: ['flick', 'left', 'ring'], "D'": ['flick', 'right', 'ring'], D2: ['flick', 'left', 'ring'],
    F: ['wrist', 'right'], "F'": ['wrist', 'left'], F2: ['wrist', 'right'],
    B: ['wrist', 'right'], "B'": ['wrist', 'right'], B2: ['wrist', 'right'],
    y: ['wrist', 'both'], "y'": ['wrist', 'both'], y2: ['wrist', 'both'],
  };
  for (const [mv, [kind, hand, finger]] of Object.entries(want)) {
    const m = motionFor(mv);
    assert.equal(m.kind, kind, mv);
    assert.equal(m.hand, hand, mv);
    assert.equal(m.finger, finger ?? null, mv);
  }
  assert.equal(motionFor('U2').count, 2);
  assert.equal(motionFor('U').count, 1);
});

test('wrist turns follow the layer: axis and sign match cube.js, doubles turn twice as far', () => {
  assert.deepEqual(motionFor('R').axis, [1, 0, 0]);
  assert.deepEqual(motionFor('L').axis, [-1, 0, 0]);
  assert.deepEqual(motionFor('F').axis, [0, 0, 1]);
  assert.deepEqual(motionFor('B').axis, [0, 0, -1]);
  assert.deepEqual(motionFor('y').axis, [0, 1, 0]);
  assert.ok(Math.abs(motionFor('R').angle + Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(motionFor("R'").angle - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(motionFor('R2').angle + Math.PI) < 1e-9);
  assert.equal(motionFor('B').pose, 'back');
  assert.equal(motionFor('R').pose, 'home');
});

test('other moves are generic or still, and bad tokens throw', () => {
  for (const mv of ['M', 'E', 'S', 'r', 'u2']) assert.equal(motionFor(mv).kind, 'none', mv);
  for (const mv of ['x', "z'", 'x2']) assert.equal(motionFor(mv).hand, 'both', mv);
  assert.throws(() => motionFor('Q'));
});

test('flick progress: monotone sweep for one flick, two sweeps for a double', () => {
  assert.equal(flickProgress(0), 0);
  assert.equal(flickProgress(1), 1);
  let prev = -1;
  for (let i = 0; i <= 20; i++) { const v = flickProgress(i / 20, 1); assert.ok(v >= prev); prev = v; }
  const two = Array.from({ length: 101 }, (_, i) => flickProgress(i / 100, 2));
  assert.equal(two[0], 0);
  assert.equal(two[100], 1);
  assert.ok(Math.max(...two.slice(0, 50)) > 0.99, 'first flick reaches the end');
  assert.ok(two.slice(40, 60).some((v, i, a) => i && v < a[i - 1]), 'snaps back between flicks');
});

test('two-bone IK keeps bone lengths, reaches reachable targets, straightens when too far', () => {
  const base = [1, 2, 3], l1 = 0.8, l2 = 0.6;
  for (const target of [[1.5, 2.5, 3.9], [0.2, 2, 3.2], [1, 3, 3.4]]) {
    const r = twoBoneIK(base, target, l1, l2, [1, 0, 0]);
    assert.ok(r.reached);
    assert.ok(Math.abs(len(sub(r.mid, base)) - l1) < 1e-6);
    assert.ok(Math.abs(len(sub(r.tip, r.mid)) - l2) < 1e-6);
    r.tip.forEach((v, i) => assert.ok(Math.abs(v - target[i]) < 1e-6));
  }
  const far = twoBoneIK(base, [10, 2, 3], l1, l2, [0, 1, 0]);
  assert.ok(!far.reached);
  assert.ok(Math.abs(len(sub(far.tip, base)) - (l1 + l2)) < 1e-4);
  assert.ok(Math.abs(len(sub(far.mid, base)) - l1) < 1e-6);
  // the elbow bends toward the pole
  const up = twoBoneIK([0, 0, 0], [1, 0, 0], 0.8, 0.6, [0, 1, 0]);
  const down = twoBoneIK([0, 0, 0], [1, 0, 0], 0.8, 0.6, [0, -1, 0]);
  assert.ok(up.mid[1] > 0 && down.mid[1] < 0);
});

// ---- gripFor -------------------------------------------------------------------------

test('every face move and y has a grip sentence naming the right hand/finger', () => {
  for (const mv of MOVES) {
    const g = gripFor(mv);
    assert.ok(typeof g === 'string' && g.length > 12, mv);
    assert.ok(g.startsWith(mv + ':'), `${mv}: ${g}`);
    const m = motionFor(mv);
    if (m.hand === 'right') assert.match(g, /right/i, g);
    if (m.hand === 'left') assert.match(g, /left/i, g);
    if (m.hand === 'both') assert.match(g, /both hands/i, g);
    if (m.finger) assert.match(g, new RegExp(m.finger, 'i'), g);
  }
  assert.match(gripFor('R'), /doorknob/);
  assert.match(gripFor('U'), /index/);
});

test('other and odd tokens still get a sensible sentence', () => {
  for (const mv of ['M', "E'", 'S2', 'x', "z'", 'r', 'u2', "R2'", 'Q']) {
    assert.ok(gripFor(mv).length > 12, mv);
  }
  assert.ok(gripFor(undefined).length > 12);
});

test('every NOTATION entry carries a grip', () => {
  for (const n of NOTATION) assert.equal(n.grip, gripFor(n.move));
});

test('every move token the solver can emit has a non-empty grip and a motion', () => {
  let seed = 7;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const seen = new Set();
  for (let n = 0; n < 150; n++) {
    const res = solveBeginner(applyMoves(SOLVED, randomScramble(25, rand)));
    assert.ok(res.ok);
    for (const mv of res.moves) seen.add(mv);
  }
  assert.ok(seen.size >= 15, `saw ${seen.size} distinct tokens`);
  for (const mv of seen) {
    assert.ok(gripFor(mv).length > 12, mv);
    assert.doesNotThrow(() => motionFor(mv), mv);
  }
});
