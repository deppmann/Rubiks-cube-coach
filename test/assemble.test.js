import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleCube, rotateFace } from '../src/assemble.js';
import { SOLVED, FACES, COLOR_OF, applyMoves, applyMove, validate } from '../src/cube.js';
import { rng } from './synth.js';

const toNames = (facelets) => FACES.map((_, fi) => [...facelets.slice(fi * 9, fi * 9 + 9)].map((l) => COLOR_OF[l]));

// Two fixed scrambles that have exactly one valid reading, and one with two.
const CUBE_A = applyMoves(SOLVED, "R U R' U' F2 D L' B2 U2 R F' D' L2 U B R2");
const CUBE_B = applyMoves(SOLVED, "L2 F' U B2 R D2 F L' U' B R2 D' F2 U2 L B'");
const AMBIGUOUS = applyMoves(SOLVED, "U' F L2 U' B L B L' F2 R2 F U' L2 D B' F2 D2 F U2 B F' R D2 U L2");

// A camera capture of face `names` that must be turned clockwise k times to be upright.
const capture = (upright, k) => rotateFace(upright, (4 - k) % 4);

// Shuffle the faces and turn each capture; returns names in scan order plus the truth.
function scanOf(facelets, rotations, order = [0, 1, 2, 3, 4, 5]) {
  const canon = toNames(facelets);
  return order.map((fi, i) => capture(canon[fi], rotations[i]));
}

test('rotateFace is a clockwise quarter-turn: (r, c) -> (c, 2 - r)', () => {
  const g = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(rotateFace(g, 1), [6, 3, 0, 7, 4, 1, 8, 5, 2]);
  assert.deepEqual(rotateFace(g, 2), [8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(rotateFace(g, 3), [2, 5, 8, 1, 4, 7, 0, 3, 6]);
  assert.deepEqual(rotateFace(g, 4), g);
  assert.deepEqual(rotateFace(g, -1), rotateFace(g, 3));
});

test('rotateFace agrees with the cube geometry in cube.js', () => {
  // Turning the whole cube like U (y) turns the U face clockwise as seen from above and the
  // D face counter-clockwise as seen from below, in each face's own reading order.
  const s = CUBE_A;
  const after = applyMove(s, 'y');
  assert.deepEqual([...after.slice(0, 9)], rotateFace([...s.slice(0, 9)], 1));
  assert.deepEqual([...after.slice(27, 36)], rotateFace([...s.slice(27, 36)], 3));
  // z turns like F: the F face turns clockwise, the B face counter-clockwise (seen from behind).
  const z = applyMove(s, 'z');
  assert.deepEqual([...z.slice(18, 27)], rotateFace([...s.slice(18, 27)], 1));
  assert.deepEqual([...z.slice(45, 54)], rotateFace([...s.slice(45, 54)], 3));
});

test('exact recovery for every one of the 4^6 rotation patterns (two cubes, shuffled faces)', () => {
  for (const [cube, order] of [[CUBE_A, [3, 0, 5, 1, 4, 2]], [CUBE_B, [0, 1, 2, 3, 4, 5]]]) {
    for (let pattern = 0; pattern < 4096; pattern++) {
      const rotations = [0, 1, 2, 3, 4, 5].map((i) => (pattern >> (2 * i)) & 3);
      const res = assembleCube(scanOf(cube, rotations, order));
      assert.equal(res.ok, true, `pattern ${pattern}`);
      assert.equal(res.facelets, cube, `pattern ${pattern}`);
      assert.deepEqual(res.rotations, rotations, `pattern ${pattern}`);
      assert.equal(res.candidates, 1);
      assert.equal(res.distinct, 1);
    }
  }
});

test('missing and duplicate centers are reported clearly', () => {
  const names = toNames(CUBE_A);
  const dup = names.map((f) => f.slice());
  dup[3][4] = 'yellow'; // the white face now claims a yellow center
  let res = assembleCube(dup);
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes('Two faces have a yellow center.'), res.errors.join('|'));
  assert.ok(res.errors.includes('No white face scanned yet.'), res.errors.join('|'));
  assert.equal(res.facelets.length, 54);

  const triple = names.map((f) => f.slice());
  triple[1][4] = 'red'; triple[2][4] = 'red'; // three red centers, no orange, no green
  res = assembleCube(triple);
  assert.ok(res.errors.includes('Three faces have a red center.'), res.errors.join('|'));
  assert.ok(res.errors.includes('No orange face scanned yet.'));
  assert.ok(res.errors.includes('No green face scanned yet.'));

  const junk = names.map((f) => f.slice());
  junk[0][4] = 'purple';
  res = assembleCube(junk);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /unreadable center/.test(e)));
  assert.ok(res.errors.includes('No yellow face scanned yet.'));
});

test('an impossible cube comes back best-effort with ok:false and reasons', () => {
  const bad = toNames(CUBE_A).map((f) => f.slice());
  [bad[0][1], bad[1][1]] = [bad[1][1], bad[0][1]]; // swap two edge stickers: a mis-scan
  const res = assembleCube(bad);
  assert.equal(res.ok, false);
  assert.equal(res.candidates, 0);
  assert.equal(res.facelets.length, 54);
  assert.ok(/^[URFDLB]{54}$/.test(res.facelets));
  assert.ok(res.errors.length > 0);
  assert.equal(validate(res.facelets).ok, false);
  // The single wrong pair is the only difference from the truth in the best guess.
  let diff = 0;
  for (let i = 0; i < 54; i++) if (res.facelets[i] !== CUBE_A[i]) diff++;
  assert.ok(diff <= 8, `best effort differs from the truth in ${diff} stickers`);
});

test('malformed input never throws', () => {
  for (const bad of [undefined, null, [], [[]], 'x', [1, 2, 3, 4, 5, 6], Array(6).fill(Array(4).fill('red'))]) {
    const res = assembleCube(bad);
    assert.equal(res.ok, false);
    assert.equal(res.facelets.length, 54);
    assert.ok(res.errors.length > 0);
  }
});

test('preferredRotations breaks ties; the default prefers no rotation', () => {
  // A solved cube looks the same however each face is turned: every pattern is valid.
  const names = toNames(SOLVED);
  let res = assembleCube(names);
  assert.equal(res.ok, true);
  assert.equal(res.candidates, 4096);
  assert.equal(res.distinct, 1);
  assert.deepEqual(res.rotations, [0, 0, 0, 0, 0, 0]);
  res = assembleCube(names, { preferredRotations: [1, 2, 3, 0, 1, 2] });
  assert.deepEqual(res.rotations, [1, 2, 3, 0, 1, 2]);
  assert.equal(res.facelets, SOLVED);

  // A real ambiguous scan: two different valid cubes; the preference picks between them.
  const canon = toNames(AMBIGUOUS);
  const first = assembleCube(canon);
  assert.equal(first.ok, true);
  assert.equal(first.distinct, 2);
  assert.equal(first.candidates, 2);
  assert.equal(first.facelets, AMBIGUOUS); // no preference: the reading with no turned faces wins
  // Prefer the rival reading: turning one face away from zero makes the other cube cheaper.
  let alt = null;
  for (let i = 0; i < 6 && !alt; i++) {
    for (const k of [1, 2, 3]) {
      const pref = [0, 0, 0, 0, 0, 0]; pref[i] = k;
      const r = assembleCube(canon, { preferredRotations: pref });
      if (r.facelets !== AMBIGUOUS) { alt = { r, pref }; break; }
    }
  }
  assert.ok(alt, 'the rival cube should win when its rotations are preferred');
  assert.equal(alt.r.ok, true);
  assert.notEqual(alt.r.facelets, AMBIGUOUS);
  assert.deepEqual(alt.r.rotations, alt.pref);
});

test('centerAlternatives rescue two look-alike centers, but only when needed', () => {
  const names = toNames(CUBE_A).map((f) => f.slice());
  const swapped = names.map((f) => f.slice());
  swapped[3][4] = 'blue'; swapped[5][4] = 'white'; // white/blue centers exchanged: not a real cube
  const alt = names.map((f) => f[4]);
  assert.equal(assembleCube(swapped).ok, false);
  const res = assembleCube(swapped, { centerAlternatives: [['red', 'red', 'red', 'red', 'red', 'red'], alt] });
  assert.equal(res.ok, true);
  assert.equal(res.facelets, CUBE_A);
  assert.equal(res.usedAlternative, 1); // the invalid first alternative (duplicate centers) is skipped
  assert.deepEqual(res.centers, alt);
  // A valid first reading is never second-guessed.
  const same = assembleCube(names, { centerAlternatives: [alt.slice().reverse()] });
  assert.equal(same.usedAlternative, -1);
});

test('worst-case assembly time stays well under 150 ms', () => {
  const rand = rng(3);
  const cases = [toNames(SOLVED), toNames(CUBE_A).map((f, i) => (i === 2 ? f.map(() => 'red').map((c, j) => (j === 4 ? 'green' : c)) : f))];
  cases.push(scanOf(CUBE_B, [3, 1, 2, 0, 3, 1], [5, 4, 3, 2, 1, 0]));
  let worst = 0;
  for (let n = 0; n < 20; n++) {
    for (const names of cases) {
      const t = performance.now();
      assembleCube(names, { preferredRotations: [0, 1, 2, 3, 0, 1].map((k) => (k + Math.floor(rand() * 4)) % 4) });
      worst = Math.max(worst, performance.now() - t);
    }
  }
  assert.ok(worst < 150, `worst ${worst.toFixed(1)} ms`);
});
