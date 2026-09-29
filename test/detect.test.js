import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFace, gridPoint, sampleFace } from '../src/detect.js';
import { randomScene, renderFrame, NATURAL_BG, HARD_BG, NAMES, mulberry32 } from './facesynth.js';

const dist = (p, q) => Math.hypot(p.r - q[0], p.g - q[1], p.b - q[2]);
const nearest = (rgb, palette) => NAMES.reduce((a, b) => (dist(rgb, palette[a]) <= dist(rgb, palette[b]) ? a : b));

// Grade one detection against the renderer's truth: position within 8% of the size, size within
// 15%, every sticker read as the right color, and the center ring as the center's color.
function grade(det, truth) {
  const T = truth.cube;
  if (!det.found) return 'not found';
  const err = Math.hypot(det.x + det.size / 2 - T.cx, det.y + det.size / 2 - T.cy) / T.size;
  if (err >= 0.08) return `position off by ${(100 * err).toFixed(0)}%`;
  if (Math.abs(det.size / T.size - 1) >= 0.15) return `size off by ${(100 * (det.size / T.size - 1)).toFixed(0)}%`;
  if (Math.abs(det.angle - T.angle) > 6) return `angle ${det.angle.toFixed(0)} vs ${T.angle.toFixed(0)}`;
  const got = det.cells.map((c) => nearest(c, T.palette));
  const bad = got.map((n, i) => (n === T.names[i] || i === 4 ? -1 : i)).filter((i) => i >= 0); // cell 4 may be the logo
  if (bad.length) return `stickers ${bad.join(',')} misread`;
  if (nearest(det.centerRing, T.palette) !== T.names[4]) return 'center ring misread';
  return null;
}

function runCases(n, opts, seedBase = 0) {
  const fails = [];
  for (let s = 0; s < n; s++) {
    const { spec, img, truth } = randomScene(seedBase + s, opts);
    const why = grade(detectFace(img), truth);
    if (why) fails.push(`seed ${seedBase + s} (${spec.bg}): ${why}`);
  }
  return fails;
}

test('finds the grid and reads the colors in ≥ 95% of 200 synthetic frames (tilt ±15°, logo, hand, noisy backgrounds)', () => {
  // Mixed frame shapes: a portrait phone frame, a square crop, and a landscape frame.
  const shapes = [{ width: 240, height: 320 }, { width: 200, height: 200 }, { width: 320, height: 240 }];
  const fails = [];
  const each = [70, 65, 65];
  shapes.forEach((shape, k) => fails.push(...runCases(each[k], shape, 1000 * k)));
  const total = each.reduce((a, b) => a + b, 0);
  assert.equal(total, 200);
  assert.ok(fails.length <= 10, `${fails.length}/200 failed:\n${fails.join('\n')}`);
});

test('a frame that is not near the frame edge is found at 640×480 too (larger frames are downscaled, then refined)', () => {
  const rand = mulberry32(3);
  let ok = 0;
  const N = 16;
  for (let s = 0; s < N; s++) {
    const { img, truth } = randomScene(50 + s, { width: 640, height: 480 });
    const T = truth.cube;
    const margin = Math.min(T.cx - T.size / 2, T.cy - T.size / 2, 640 - T.cx - T.size / 2, 480 - T.cy - T.size / 2);
    if (margin < 8) { ok++; continue; } // cube touching the frame edge: not a fair case
    if (!grade(detectFace(img), truth)) ok++;
  }
  void rand;
  assert.ok(ok >= N - 1, `${ok}/${N}`);
});

test('tilt up to ±25° is still found and measured', () => {
  let ok = 0;
  const N = 24;
  for (let s = 0; s < N; s++) {
    const rand = mulberry32(900 + s);
    const angle = (s % 2 ? 1 : -1) * (15 + rand() * 10);
    const size = 110 + rand() * 40;
    const names = Array.from({ length: 9 }, () => NAMES[(rand() * 6) | 0]);
    const { img, truth } = renderFrame({
      width: 240, height: 320, seed: 77 + s, bg: NATURAL_BG[s % NATURAL_BG.length], noise: 3,
      cube: { cx: 120, cy: 160, size, angle, names, gapFrac: 0.06, logo: true, hand: false },
    });
    if (!grade(detectFace(img), truth)) ok++;
  }
  assert.ok(ok >= 0.9 * N, `${ok}/${N}`);
});

test('soft focus and heavy sensor noise still work', () => {
  let ok = 0;
  const N = 20;
  for (let s = 0; s < N; s++) {
    const rand = mulberry32(300 + s);
    const names = Array.from({ length: 9 }, () => NAMES[(rand() * 6) | 0]);
    const { img, truth } = renderFrame({
      width: 240, height: 320, seed: 5 + s, bg: NATURAL_BG[s % NATURAL_BG.length], noise: 7, blur: 0.9,
      cube: { cx: 110 + rand() * 20, cy: 150 + rand() * 20, size: 130 + rand() * 30, angle: (rand() - 0.5) * 20, names, gapFrac: 0.07, logo: true, hand: true },
    });
    if (!grade(detectFace(img), truth)) ok++;
  }
  assert.ok(ok >= 0.85 * N, `${ok}/${N}`);
});

test('frames with no cube are never reported as a face (skin, fabric, rug, couch, wood, wall, noise, colored blocks)', () => {
  const false_pos = [];
  for (const kind of [...NATURAL_BG, ...HARD_BG]) {
    for (let s = 0; s < 14; s++) {
      const { img } = renderFrame({ width: 240, height: 320, seed: s * 13 + kind.length, bg: kind, noise: 2 + (s % 5) });
      const d = detectFace(img);
      if (d.found) false_pos.push(`${kind} #${s} score ${d.score.toFixed(2)}`);
    }
  }
  assert.deepEqual(false_pos, []);
  // Perfectly blank and tiny frames must not throw.
  assert.equal(detectFace({ width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(128) }).found, false);
  assert.equal(detectFace({ width: 10, height: 10, data: new Uint8ClampedArray(400) }).found, false);
});

test('prev: tracking a moving cube frame to frame keeps the lock and follows it', () => {
  const rand = mulberry32(11);
  const names = Array.from({ length: 9 }, () => NAMES[(rand() * 6) | 0]);
  let prev = null;
  let locked = 0;
  for (let k = 0; k < 20; k++) {
    const cube = { cx: 90 + k * 3, cy: 150 + Math.sin(k / 3) * 8, size: 120 + k, angle: -8 + k * 0.7, names, gapFrac: 0.06, logo: true, hand: true, gain: 0.9, cast: [1, 1, 1] };
    const { img, truth } = renderFrame({ width: 240, height: 320, seed: 400 + k, bg: 'rug', noise: 3, cube });
    const d = detectFace(img, { prev });
    prev = d.found ? d : null;
    if (!grade(d, truth)) locked++;
  }
  assert.ok(locked >= 19, `${locked}/20`);
});

test('gridPoint places points on a tilted grid; sampleFace reads it', () => {
  const det = { x: 50, y: 40, size: 90, angle: 0 };
  assert.deepEqual(gridPoint(det, 0, 0).map(Math.round), [50, 40]);
  assert.deepEqual(gridPoint(det, 1, 1).map(Math.round), [140, 130]);
  assert.deepEqual(gridPoint({ ...det, angle: 90 }, 1, 0).map(Math.round), [140, 40 + 90]); // top-right corner turned clockwise
  const { img, truth } = randomScene(4, { width: 240, height: 320 });
  const T = truth.cube;
  const d = { x: T.cx - T.size / 2, y: T.cy - T.size / 2, size: T.size, angle: T.angle };
  const { cells, centerRing } = sampleFace(img, d);
  assert.equal(cells.length, 9);
  cells.forEach((c, i) => { if (i !== 4) assert.equal(nearest(c, T.palette), T.names[i]); }); // (the center cell may show the logo)
  assert.equal(nearest(centerRing, T.palette), T.names[4]);
});

test('speed: a phone-class frame budget (measured on the ~200 px search image)', () => {
  const scenes = Array.from({ length: 24 }, (_, i) => randomScene(700 + i, { width: 240, height: 320 }).img);
  const prevs = scenes.map((im) => detectFace(im)); // also warms the JIT
  for (let r = 0; r < 2; r++) scenes.forEach((im, i) => detectFace(im, { prev: prevs[i] }));
  let t = performance.now();
  scenes.forEach((im) => detectFace(im));
  const full = (performance.now() - t) / scenes.length;
  t = performance.now();
  for (let r = 0; r < 3; r++) scenes.forEach((im, i) => detectFace(im, { prev: prevs[i] }));
  const tracked = (performance.now() - t) / (3 * scenes.length);
  console.log(`# detectFace: ${full.toFixed(1)} ms full search, ${tracked.toFixed(1)} ms tracking (240×320 input, this machine)`);
  assert.ok(tracked < 25, `tracking ${tracked.toFixed(1)} ms`);
  assert.ok(full < 40, `full search ${full.toFixed(1)} ms`); // typically ~15 ms; the bound leaves room for a slow CI box
});
