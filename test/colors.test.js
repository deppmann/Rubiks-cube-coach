import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_NAMES, classifyStickers } from '../src/colors.js';
import { assembleCube } from '../src/assemble.js';
import { classifyFaces } from '../src/scanner.js';
import { SOLVED, COLOR_OF, FACES } from '../src/cube.js';
import { rng, renderCube, randomCube, LOGO } from './synth.js';

// A real photo: white GAN face under warm indoor light, row-major. Index 4 is the white
// center cap, read as the blue GAN logo.
const WHITE_FACE = [
  { r: 231, g: 211, b: 182 }, { r: 232, g: 214, b: 15 }, { r: 248, g: 99, b: 29 },
  { r: 227, g: 207, b: 179 }, { r: 25, g: 79, b: 149 }, { r: 228, g: 210, b: 16 },
  { r: 190, g: 19, b: 26 }, { r: 49, g: 144, b: 57 }, { r: 196, g: 26, b: 32 },
];
const WHITE_FACE_NAMES = ['white', 'yellow', 'orange', 'white', 'white', 'yellow', 'red', 'green', 'red'];
// The rest of that cube, rendered with the same warm cast (blue has no real sample: guessed).
const WARM = {
  white: [229, 209, 180], yellow: [231, 213, 15], orange: [247, 100, 28], red: [193, 22, 29],
  green: [49, 144, 57], blue: [22, 72, 140],
};

// Five more faces holding exactly the stickers the white face leaves over (9 of each color),
// with a real, distinct center on each. The white face lands at a random slot.
function warmCube(rand) {
  const centers = ['yellow', 'green', 'blue', 'red', 'orange'];
  const pool = COLOR_NAMES.flatMap((c) => new Array(9).fill(c));
  for (const n of [...WHITE_FACE_NAMES, ...centers]) pool.splice(pool.indexOf(n), 1);
  pool.sort(() => rand() - 0.5);
  const noisy = (c) => {
    const k = 0.85 + rand() * 0.3;
    const v = WARM[c].map((x) => Math.max(0, Math.min(255, Math.round(x * k + (rand() - 0.5) * 8))));
    return { r: v[0], g: v[1], b: v[2] };
  };
  const faces = centers.map((c, f) => {
    const eight = pool.slice(f * 8, f * 8 + 8);
    return [...eight.slice(0, 4), c, ...eight.slice(4)].map(noisy);
  });
  const whiteAt = Math.floor(rand() * 6);
  faces.splice(whiteAt, 0, WHITE_FACE.slice());
  return { faces, whiteAt };
}

test('COLOR_NAMES', () => {
  assert.deepEqual(COLOR_NAMES, ['white', 'yellow', 'green', 'blue', 'red', 'orange']);
});

test('real white face with the logo-blue center classifies as white (center ring supplied)', () => {
  const rand = rng(31);
  for (let n = 0; n < 12; n++) {
    const { faces, whiteAt } = warmCube(rand);
    const rings = faces.map((face, f) => (f === whiteAt ? { r: 226, g: 206, b: 178 } : face[4]));
    const res = classifyStickers(faces, { centerRings: rings });
    assert.deepEqual(res.names[whiteAt], WHITE_FACE_NAMES);
    assert.equal(res.centers[whiteAt], 'white');
    assert.equal(new Set(res.centers).size, 6);
  }
});

test('real white face: stickers are right without a ring, and the cube structure settles the center', () => {
  const rand = rng(32);
  for (let n = 0; n < 12; n++) {
    const { faces, whiteAt } = warmCube(rand);
    const res = classifyStickers(faces);
    const got = res.names[whiteAt].slice();
    assert.deepEqual([0, 1, 2, 3, 5, 6, 7, 8].map((i) => got[i]), [0, 1, 2, 3, 5, 6, 7, 8].map((i) => WHITE_FACE_NAMES[i]));
    // The logo-blue cap and the true blue center both look blue: one of the candidate
    // readings must make the white face's center white.
    const readings = [res.centers, ...res.centerAlternatives];
    assert.ok(readings.some((c) => c[whiteAt] === 'white' && new Set(c).size === 6));
    for (const c of COLOR_NAMES) assert.equal(res.names.flat().filter((x) => x === c).length, 9);
  }
});

test('200 random cubes: shuffled, rotated, cast, dim/bright, logo on a center — exact recovery', () => {
  const rand = rng(2024);
  let exact = 0, ambiguous = 0;
  for (let n = 0; n < 200; n++) {
    const truth = randomCube(rand);
    const { faces } = renderCube(truth, rand, { logo: true });
    let out;
    assert.doesNotThrow(() => {
      const c = classifyStickers(faces);
      assert.equal(c.names.length, 6);
      assert.ok(c.confidence.flat().every((v) => v >= 0 && v <= 1));
      assert.equal(new Set(c.centers).size, 6);
      out = assembleCube(c.names, { centerAlternatives: c.centerAlternatives });
    });
    if (out.ok && out.facelets === truth) exact++;
    else if (out.distinct > 1) ambiguous++; // two genuinely valid cubes: needs the rotation prior
  }
  assert.ok(exact >= 196, `only ${exact}/200 exact (${ambiguous} genuinely ambiguous)`);
});

test('center rings make the logo harmless without any structural help', () => {
  const rand = rng(77);
  for (let n = 0; n < 40; n++) {
    const truth = randomCube(rand);
    const { faces, rings, order, rotations } = renderCube(truth, rand, { logo: true, rings: true });
    const c = classifyStickers(faces, { centerRings: rings });
    order.forEach((fi, i) => assert.equal(c.centers[i], COLOR_OF[FACES[fi]]));
    const out = assembleCube(c.names);
    if (out.distinct === 1) assert.equal(out.facelets, truth);
    assert.equal(out.ok, true);
    assert.equal(rotations.length, 6);
  }
});

test('strong warm and cool casts on a solved cube', () => {
  for (const cast of [[1, 0.93, 0.78], [0.85, 0.95, 1.1], [1, 0.8, 0.6]]) {
    const rand = rng(5);
    const { faces, order, rotations } = renderCube(SOLVED, rand, { logo: false, cast });
    const c = classifyStickers(faces);
    const a = assembleCube(c.names, { preferredRotations: rotations });
    assert.ok(a.ok);
    assert.equal(a.facelets, SOLVED);
    assert.equal(order.length, 6);
  }
});

test('garbage input never throws and reports low confidence', () => {
  const gray = { r: 128, g: 128, b: 128 };
  const flat = Array.from({ length: 6 }, () => Array.from({ length: 9 }, () => gray));
  const cases = [
    undefined, null, 5, 'x', [], [[]], flat,
    Array.from({ length: 6 }, () => Array.from({ length: 9 }, () => ({ r: 0, g: 0, b: 0 }))),
    Array.from({ length: 6 }, () => Array.from({ length: 9 }, () => ({ r: NaN, g: undefined, b: 'x' }))),
    Array.from({ length: 6 }, () => Array.from({ length: 4 }, () => gray)),
    Array.from({ length: 7 }, () => Array.from({ length: 9 }, () => ({ r: 300, g: -20, b: 1e9 }))),
  ];
  for (const bad of cases) {
    let res;
    assert.doesNotThrow(() => { res = classifyStickers(bad, { centerRings: [null, 3, {}, gray] }); });
    assert.equal(res.names.length, 6);
    assert.ok(res.names.every((f) => f.length === 9 && f.every((n) => COLOR_NAMES.includes(n))));
    assert.ok(res.confidence.flat().every((v) => v >= 0 && v <= 1));
    assert.equal(res.centers.length, 6);
    assert.doesNotThrow(() => assembleCube(res.names));
  }
  const res = classifyStickers(flat);
  assert.ok(Math.max(...res.confidence.flat()) < 0.05, 'a uniform gray cube must not look confident');
  assert.ok(Math.max(...classifyStickers(cases[8]).confidence.flat()) === 0);
});

test('classifyFaces (fixed rotations) also survives a logo center and a cast', () => {
  const rand = rng(404);
  let exact = 0;
  for (let n = 0; n < 60; n++) {
    const truth = randomCube(rand);
    const { faces } = renderCube(truth, rand, { logo: true, shuffle: false, rotate: false });
    const samples = Object.fromEntries(FACES.map((f, i) => [f, faces[i]]));
    const { facelets, confidence } = classifyFaces(samples);
    assert.equal(confidence.length, 54);
    for (const f of FACES) assert.equal([...facelets].filter((c) => c === f).length, 9);
    if (facelets === truth) exact++;
  }
  assert.ok(exact >= 58, `only ${exact}/60 exact`);
});

test('classifyFaces on the real warm white face (D) with the logo center', () => {
  const { faces: fs, whiteAt } = warmCube(rng(9));
  const order = ['U', 'R', 'F', 'D', 'L', 'B'];
  const samples = Object.fromEntries(order.map((f, i) => [f, fs[i]]));
  const { facelets, centers } = classifyFaces(samples, { centerRings: fs.map((face, i) => (i === whiteAt ? { r: 226, g: 206, b: 178 } : face[4])) });
  assert.equal(new Set(centers).size, 6);
  assert.equal(centers[whiteAt], 'white');
  for (const f of FACES) assert.equal([...facelets].filter((c) => c === f).length, 9);
  assert.equal(facelets.slice(whiteAt * 9 + 4, whiteAt * 9 + 5), order[whiteAt]);
});
