import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLVED, applyMoves, applyMove, invertMoves, isSolved, validate, parseMoves, simplifyMoves,
  randomScramble, CORNER_SLOTS, EDGE_SLOTS,
} from '../src/cube.js';

const face = (s, f) => s.slice('URFDLB'.indexOf(f) * 9, 'URFDLB'.indexOf(f) * 9 + 9);

// Deterministic PRNG for reproducible scrambles.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('R matches the Kociemba reference facelets', () => {
  const s = applyMove(SOLVED, 'R');
  assert.equal(face(s, 'U'), 'UUFUUFUUF');
  assert.equal(face(s, 'F'), 'FFDFFDFFD');
  assert.equal(face(s, 'D'), 'DDBDDBDDB');
  assert.equal(face(s, 'B'), 'UBBUBBUBB');
  assert.equal(face(s, 'R'), 'RRRRRRRRR');
});

test('U turns the front row to the left', () => {
  const s = applyMove(SOLVED, 'U');
  assert.equal(face(s, 'F').slice(0, 3), 'RRR');
  assert.equal(face(s, 'L').slice(0, 3), 'FFF');
});

test('F moves the U bottom row onto R', () => {
  const s = applyMove(SOLVED, 'F');
  assert.equal(face(s, 'U').slice(6), 'LLL');
  assert.equal([0, 3, 6].map((i) => face(s, 'R')[i]).join(''), 'UUU');
});

test('every move has order 4 and x/y/z keep the cube solved-looking', () => {
  for (const m of 'U D R L F B M E S x y z u d r l f b'.split(' ')) {
    assert.equal(applyMoves(SOLVED, [m, m, m, m].join(' ')), SOLVED, m);
    assert.ok(!['M', 'E', 'S', 'u', 'd', 'r', 'l', 'f', 'b'].includes(m) || applyMove(SOLVED, m) !== SOLVED);
  }
  for (const m of ['x', 'y', 'z', "x'", 'y2']) assert.ok(isSolved(applyMove(SOLVED, m)), m);
});

test('slice and rotation identities', () => {
  assert.equal(applyMoves(SOLVED, "r"), applyMoves(SOLVED, "R M'"));
  assert.equal(applyMoves(SOLVED, "x"), applyMoves(SOLVED, "R M' L'"));
  assert.equal(applyMoves(SOLVED, "y"), applyMoves(SOLVED, "U E' D'"));
  assert.equal(applyMoves(SOLVED, "z"), applyMoves(SOLVED, "F S B'"));
  // y then F equals R then y (the front face becomes what was the right face)
  const scr = applyMoves(SOLVED, "R U2 F' L D B2");
  assert.equal(applyMoves(scr, "y F"), applyMoves(scr, "R y"));
});

test('sexy move has order 6; T-perm has order 2', () => {
  assert.equal(applyMoves(SOLVED, "R U R' U' ".repeat(6)), SOLVED);
  const t = "R U R' U' R' F R2 U' R' U' R U R' F'";
  assert.notEqual(applyMoves(SOLVED, t), SOLVED);
  assert.equal(applyMoves(SOLVED, `${t} ${t}`), SOLVED);
});

test('inverse undoes scrambles', () => {
  const rand = mulberry32(1);
  for (let i = 0; i < 50; i++) {
    const scr = randomScramble(25, rand);
    assert.equal(applyMoves(applyMoves(SOLVED, scr), invertMoves(scr)), SOLVED);
  }
});

test('parse / simplify', () => {
  assert.deepEqual(parseMoves("R U’ F2 x2' "), ['R', "U'", 'F2', 'x2']);
  assert.deepEqual(simplifyMoves("R R U U' F2 F"), ['R2', "F'"]);
  assert.throws(() => parseMoves('Q'));
});

test('slot tables cover all pieces', () => {
  assert.equal(CORNER_SLOTS.length, 8);
  assert.equal(EDGE_SLOTS.length, 12);
});

test('validate accepts reachable cubes, including rotated ones', () => {
  const rand = mulberry32(2);
  for (let i = 0; i < 200; i++) {
    const s = applyMoves(SOLVED, randomScramble(30, rand));
    assert.deepEqual(validate(s), { ok: true, errors: [] });
  }
  const superflip = "U R2 F B R B2 R U2 L B2 R U' D' R2 F R' L B2 U2 F2";
  assert.ok(validate(applyMoves(SOLVED, superflip)).ok);
  assert.ok(validate(applyMoves(SOLVED, "x y R U M' E z2 S")).ok);
});

function swap(s, i, j) {
  const a = [...s];
  [a[i], a[j]] = [a[j], a[i]];
  return a.join('');
}

test('validate rejects impossible cubes with a reason', () => {
  const base = applyMoves(SOLVED, "R U F' D2 L");
  const [u, a, b] = CORNER_SLOTS[0].stickers;
  const twisted = [...base]; [twisted[u], twisted[a], twisted[b]] = [base[b], base[u], base[a]];
  assert.match(validate(twisted.join('')).errors.join(), /twisted/);

  const [e0, e1] = EDGE_SLOTS[0].stickers;
  assert.match(validate(swap(base, e0, e1)).errors.join(), /flipped/);

  const e2 = EDGE_SLOTS[1].stickers;
  const swapped = [...base];
  [swapped[e0], swapped[e2[0]]] = [base[e2[0]], base[e0]];
  [swapped[e1], swapped[e2[1]]] = [base[e2[1]], base[e1]];
  assert.match(validate(swapped.join('')).errors.join(), /swapped/);

  assert.match(validate(SOLVED.replace('R', 'U')).errors.join(), /appears/);
  assert.equal(validate('short').ok, false);
});

test('validate accepts all 24 held orientations but rejects impossible center layouts', () => {
  const seen = new Set();
  for (const a of ['', 'x', 'x2', "x'", 'z', "z'"]) {
    for (const b of ['', 'y', 'y2', "y'"]) {
      const s = applyMoves(SOLVED, `${a} ${b} R U F'`);
      seen.add([4, 13, 22, 31, 40, 49].map((i) => s[i]).join(''));
      assert.ok(validate(s).ok, `${a} ${b}`);
    }
  }
  assert.equal(seen.size, 24);
  // Mirror image (red and orange centers swapped everywhere): consistent pieces, unreal cube.
  const mirror = (s) => [...s].map((c) => ({ R: 'L', L: 'R' })[c] ?? c).join('');
  assert.match(validate(mirror(SOLVED)).errors.join(), /centers are not arranged/);
  assert.match(validate(mirror(applyMoves(SOLVED, "R U F' L2 D B"))).errors.join(), /centers are not arranged/);
  // Two centers swapped: the first error names the centers, not a list of bogus corners.
  assert.match(validate(swap(SOLVED, 4, 22)).errors[0], /centers are not arranged/);
  // A duplicated center is still reported as such.
  const dup = [...SOLVED]; dup[22] = 'U'; dup[0] = 'F';
  assert.deepEqual(validate(dup.join('')).errors, ['Two centers have the same color.']);
});

test('validate rejects every single swap of two differently colored stickers', () => {
  const rand = mulberry32(5);
  for (let n = 0; n < 5; n++) {
    const s = applyMoves(SOLVED, randomScramble(25, rand));
    for (let i = 0; i < 54; i++) {
      for (let j = i + 1; j < 54; j++) if (s[i] !== s[j]) assert.equal(validate(swap(s, i, j)).ok, false, `${i}<->${j}`);
    }
  }
});
