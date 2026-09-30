import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FaceTracker, FaceTray, buildCube, DEFAULTS } from '../src/autoscan.js';
import { SOLVED, applyMoves, validate } from '../src/cube.js';
import { rng, renderCube } from './synth.js';

// A detection like detectFace() returns: 9 stickers of `color` plus per-sticker offsets.
const gray = (v) => ({ r: v, g: v, b: v });
function det({ x = 100, y = 80, size = 160, angle = 0, score = 0.8, cells, ring = { r: 200, g: 30, b: 30 } } = {}) {
  return {
    found: true, x, y, size, angle, score,
    cells: cells ?? Array.from({ length: 9 }, (_, i) => ({ r: 40 + 20 * i, g: 90, b: 200 - 10 * i })),
    centerRing: ring,
  };
}
const NONE = { found: false, score: 0.1 };

test('one capture per hold: steady face for the hold time fires once, then stays quiet', () => {
  const t = new FaceTracker();
  const fired = [];
  for (let k = 0; k < 40; k++) { // 30 fps for 1.3 s
    const r = t.update(det(), k * 33);
    if (r.capture) fired.push(k);
  }
  assert.equal(fired.length, 1);
  assert.ok(fired[0] * 33 >= DEFAULTS.holdMs && fired[0] * 33 < DEFAULTS.holdMs + 100);
});

test('a moving or changing face never captures', () => {
  const t = new FaceTracker();
  for (let k = 0; k < 60; k++) assert.equal(t.update(det({ x: 100 + k * 15 }), k * 33).capture, null); // slides across
  const t2 = new FaceTracker();
  for (let k = 0; k < 60; k++) { // stickers flicker between two colors every frame
    const c = k % 2 ? 40 : 200;
    assert.equal(t2.update(det({ cells: Array.from({ length: 9 }, () => gray(c)) }), k * 33).capture, null);
  }
});

test('a short dropout does not restart the hold, a long one does', () => {
  const t = new FaceTracker();
  let n = 0;
  for (let k = 0; k < 30; k++) if (t.update(k === 8 || k === 9 ? NONE : det(), k * 33).capture) n++;
  assert.equal(n, 1);
  const t2 = new FaceTracker();
  n = 0;
  for (let k = 0; k < 30; k++) if (t2.update(k >= 5 && k < 25 ? NONE : det(), k * 33).capture) n++; // 660 ms gone
  assert.equal(n, 0);
});

test('weak detections do not count', () => {
  const t = new FaceTracker();
  for (let k = 0; k < 40; k++) assert.equal(t.update(det({ score: 0.2 }), k * 33).capture, null);
});

test('the capture is the per-sticker median over the hold, so one glare frame drops out', () => {
  const t = new FaceTracker();
  let cap = null;
  for (let k = 0; k < 40 && !cap; k++) {
    const d = det();
    if (k === 6) d.cells[0] = { r: 250, g: 250, b: 250 };
    cap = t.update(d, k * 33).capture ?? cap;
  }
  assert.ok(cap);
  assert.deepEqual(cap.cells[0], { r: 40, g: 90, b: 200 });
  assert.ok(cap.quality > 0.5 && cap.quality <= 1);
});

test('FaceTray: faces are told apart by center color; a re-shown face replaces only if steadier', () => {
  const tray = new FaceTray();
  const cap = (ring, quality) => ({ cells: [], centerRing: ring, quality });
  const RING = { white: { r: 225, g: 205, b: 180 }, yellow: { r: 230, g: 214, b: 14 }, green: { r: 40, g: 140, b: 60 }, blue: { r: 20, g: 80, b: 145 }, red: { r: 190, g: 22, b: 30 }, orange: { r: 245, g: 95, b: 25 } };
  const seen = ['orange', 'white', 'red', 'green', 'yellow', 'blue'];
  seen.forEach((n, i) => {
    const e = tray.offer(cap(RING[n], 0.5));
    assert.equal(e.kind, 'added');
    assert.equal(e.name, n, `center ${n} named ${e.name}`);
    assert.equal(e.index, i);
  });
  assert.equal(tray.count, 6);
  assert.deepEqual(tray.missing, []);
  // Same face again, slightly different lighting.
  const warm = { r: RING.green.r + 8, g: RING.green.g - 6, b: RING.green.b + 4 };
  assert.deepEqual(tray.offer(cap(warm, 0.45)), { kind: 'kept', index: 3, name: 'green' });
  assert.deepEqual(tray.offer(cap(warm, 0.7)), { kind: 'replaced', index: 3, name: 'green' });
  assert.equal(tray.captures()[3].quality, 0.7);
  tray.remove(3);
  assert.deepEqual(tray.missing, ['green']);
  assert.equal(tray.offer(cap(RING.green, 0.3)).kind, 'added');
});

test('FaceTray: red and orange centers stay apart even when the first guess would collide', () => {
  const tray = new FaceTray();
  // Warm light pushes red toward orange: both must still get their own slot.
  const a = tray.offer({ cells: [], centerRing: { r: 235, g: 85, b: 20 }, quality: 0.5 });
  const b = tray.offer({ cells: [], centerRing: { r: 210, g: 50, b: 30 }, quality: 0.5 });
  assert.notEqual(a.name, b.name);
  assert.equal(a.kind, 'added');
  assert.equal(b.kind, 'added');
});

test('buildCube: six shuffled, turned captures with logo contamination give the right cube', () => {
  const rand = rng(2024);
  const cubes = [applyMoves(SOLVED, "R U R' U' F2 D L' B2 U2 R F' D' L2 U B R2"), applyMoves(SOLVED, "L2 F' U B2 R D2 F L' U' B R2 D' F2 U2 L B'")];
  for (const cube of cubes) {
    for (let n = 0; n < 6; n++) {
      const { faces, rings } = renderCube(cube, rand, { rings: true, logo: true });
      const res = buildCube(faces.map((cells, i) => ({ cells, centerRing: rings[i] })));
      assert.equal(res.ok, true, res.errors.join(' '));
      assert.equal(res.facelets, cube);
      assert.ok(validate(res.facelets).ok);
      assert.ok(res.flags.every((i) => i >= 0 && i < 54 && i % 9 !== 4));
    }
  }
});

test('buildCube: unusable captures come back not-ok with plain-English errors and a best-effort net', () => {
  const rand = rng(5);
  const cube = applyMoves(SOLVED, "R U R' U' F2 D L' B2 U2 R F' D' L2 U B R2");
  const { faces, rings } = renderCube(cube, rand, { rings: true, logo: false });
  const caps = faces.map((cells, i) => ({ cells, centerRing: rings[i] }));
  caps[1] = caps[0]; // the same face twice
  const res = buildCube(caps);
  assert.equal(res.ok, false);
  assert.equal(res.facelets.length, 54);
  assert.ok(res.errors.length > 0 && res.errors.every((e) => typeof e === 'string' && e.length > 5));
});
