import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOLVED, COLOR_OF, FACES, randomScramble, applyMoves, validate } from '../src/cube.js';
import { SCAN_ORDER, classifyFaces, rgbToLab } from '../src/scanner.js';

// Typical camera renderings of each sticker color under neutral light.
const BASE = {
  white: [225, 228, 232], yellow: [235, 200, 40], green: [20, 140, 80],
  blue: [20, 70, 170], red: [175, 25, 45], orange: [240, 105, 25],
};

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synth(facelets, rand) {
  const gauss = () => (rand() + rand() + rand() - 1.5) * 2; // ~N(0,1)-ish
  const samples = {};
  FACES.forEach((f, fi) => {
    const bright = 0.6 + rand() * 0.6;
    const cast = [0, 1, 2].map(() => 1 + (rand() - 0.5) * 0.12);
    samples[f] = Array.from({ length: 9 }, (_, i) => {
      const base = BASE[COLOR_OF[facelets[fi * 9 + i]]];
      const local = bright * (0.96 + rand() * 0.08); // shading across the face
      const [r, g, b] = base.map((v, k) => Math.max(0, Math.min(255, Math.round(v * local * cast[k] + gauss() * 5))));
      return { r, g, b };
    });
  });
  return samples;
}

test('SCAN_ORDER covers each face once, F first', () => {
  assert.deepEqual(SCAN_ORDER.map((s) => s.face).sort(), [...FACES].sort());
  assert.equal(SCAN_ORDER[0].face, 'F');
  assert.deepEqual(SCAN_ORDER.slice(-2).map((s) => s.face), ['U', 'D']);
  for (const s of SCAN_ORDER) assert.ok(s.title && s.instruction);
});

test('rgbToLab sanity', () => {
  const [L] = rgbToLab({ r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(L - 100) < 0.1);
  assert.ok(Math.abs(rgbToLab({ r: 0, g: 0, b: 0 })[0]) < 0.1);
});

test('classifyFaces recovers scrambled cubes under varied lighting', () => {
  const rand = rng(12345);
  let exact = 0;
  for (let n = 0; n < 50; n++) {
    const facelets = applyMoves(SOLVED, randomScramble(25, rand));
    const { facelets: got, confidence } = classifyFaces(synth(facelets, rand));
    for (const f of FACES) assert.equal([...got].filter((c) => c === f).length, 9);
    assert.equal(confidence.length, 54);
    assert.ok(confidence.every((c) => c >= 0 && c <= 1));
    for (let f = 0; f < 6; f++) assert.equal(got[f * 9 + 4], FACES[f]);
    if (got === facelets) exact++;
  }
  assert.ok(exact >= 48, `only ${exact}/50 exact`);
});

test('solved cube classifies to itself', () => {
  const { facelets } = classifyFaces(synth(SOLVED, rng(7)));
  assert.equal(facelets, SOLVED);
  assert.ok(validate(facelets).ok);
});
