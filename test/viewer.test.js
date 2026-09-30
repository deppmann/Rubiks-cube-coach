import test from 'node:test';
import assert from 'node:assert/strict';
import { STICKERS, SOLVED, applyMove, stickerIndex, moveInfo, COLOR_OF } from '../src/cube.js';
import {
  STICKER_HEX, SPACING, HALF, stickerTransform, stickerHex, easeInOut, moveAngle, moveDuration,
  rotateVec, perpBasis, arcSpec, arcPoint, arcPoints, dimMix,
} from '../src/viewer3d.js';

const round = (v) => v.map((x) => Math.round(x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('sticker transforms are pos*spacing + normal*half', () => {
  for (const s of STICKERS) {
    const t = stickerTransform(s.index);
    t.position.forEach((v, k) => assert.ok(Math.abs(v - (s.pos[k] * SPACING + s.normal[k] * HALF)) < 1e-9));
    assert.deepEqual(t.normal, s.normal);
  }
});

test('STICKER_HEX covers every coach color', () => {
  for (const name of Object.values(COLOR_OF)) assert.match(STICKER_HEX[name], /^#[0-9a-f]{6}$/);
  assert.equal(stickerHex('D'), STICKER_HEX.white);
  assert.equal(stickerHex('?'), '#59606d');
});

test('animation rotation matches cube.js applyMove for every move', () => {
  const s0 = Array.from({ length: 54 }, (_, i) => String.fromCharCode(0x100 + i)).join('');
  const moves = [];
  for (const b of 'URFDLBMESxyzurfdlb') for (const m of ['', "'", '2']) moves.push(b + m);
  for (const mv of moves) {
    const { layer, axis } = moveInfo(mv);
    const after = applyMove(s0, mv);
    for (const st of STICKERS) {
      if (!layer(st.pos)) { assert.equal(after[st.index], s0[st.index]); continue; }
      const a = moveAngle(mv);
      const j = stickerIndex(round(rotateVec(st.pos, axis, a)), round(rotateVec(st.normal, axis, a)));
      assert.equal(after[j], s0[st.index], `${mv} sticker ${st.index}`);
    }
  }
});

test('durations: quarter 300ms, half 1.5x, speed divides', () => {
  assert.equal(moveDuration('R'), 300);
  assert.equal(moveDuration("R'"), 300);
  assert.equal(moveDuration('U2'), 450);
  assert.equal(moveDuration('R', 2), 150);
});

test('easeInOut is monotone with fixed endpoints', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.ok(easeInOut(0.25) < 0.25 && easeInOut(0.75) > 0.75);
});

test('perpBasis is orthonormal and right-handed', () => {
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, -1, 0], [-1, 0, 0], [0, 0, -1]]) {
    const { u, v } = perpBasis(axis);
    assert.ok(Math.abs(dot(u, axis)) < 1e-9 && Math.abs(dot(v, axis)) < 1e-9 && Math.abs(dot(u, v)) < 1e-9);
    cross(u, v).forEach((x, k) => assert.ok(Math.abs(x - axis[k]) < 1e-9));
  }
});

test('hint arc floats outside the face and travels in the turn direction', () => {
  for (const mv of ['U', "R'", 'F', 'D', "L'", 'B', 'y', "y'", 'R2', 'U2']) {
    const spec = arcSpec(mv);
    const { axis } = moveInfo(mv);
    const pts = arcPoints(spec, 16);
    for (const p of pts) {
      assert.ok(dot(p, axis) > 1.5, `${mv} arc must be outside the cube`);
      const radial = p.map((v, k) => v - spec.center[k]);
      assert.ok(Math.abs(Math.hypot(...radial) - spec.radius) < 1e-9);
    }
    // Direction must agree with the rotation applied to the layer (CW about axis for turns > 0).
    const p0 = pts[0].map((v, k) => v - spec.center[k]);
    const delta = pts[1].map((v, k) => v - pts[0][k]);
    const moved = rotateVec(p0, axis, Math.sign(moveAngle(mv)) * 0.01).map((v, k) => v - p0[k]);
    assert.ok(dot(delta, moved) > 0, `${mv} arrow direction`);
    // Tangent at the end is unit length and points along the travel.
    const { tangent } = arcPoint(spec, 1);
    assert.ok(Math.abs(Math.hypot(...tangent) - 1) < 1e-9);
  }
  assert.ok(arcSpec('R2').sweep > arcSpec('R').sweep);
  assert.equal(arcSpec('R2').double, true);
});

test('dimMix blends toward grey', () => {
  assert.deepEqual(dimMix([1, 0, 0], [0.5, 0.5, 0.5], 0), [1, 0, 0]);
  assert.deepEqual(dimMix([1, 0, 0], [0.5, 0.5, 0.5], 1), [0.5, 0.5, 0.5]);
});

test('SOLVED import sanity', () => assert.equal(SOLVED.length, 54));
