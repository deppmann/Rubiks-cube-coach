// Test helper (not a test): renders a facelet string the way a phone camera might see it,
// with lighting casts, noise, logo contamination, shuffled faces and rotated captures.
import { SOLVED, COLOR_OF, FACES, randomScramble, applyMoves } from '../src/cube.js';
import { rotateFace } from '../src/assemble.js';

export function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PALETTES = [
  { white: [225, 228, 232], yellow: [235, 200, 40], green: [20, 140, 80], blue: [20, 70, 170], red: [175, 25, 45], orange: [240, 105, 25] },
  { white: [240, 240, 240], yellow: [250, 225, 20], green: [25, 155, 60], blue: [15, 75, 165], red: [200, 20, 30], orange: [250, 105, 20] },
  { white: [232, 232, 226], yellow: [238, 215, 30], green: [35, 150, 65], blue: [25, 80, 175], red: [190, 30, 35], orange: [245, 115, 30] },
];
export const CASTS = [[1, 1, 1], [1, 0.93, 0.78], [0.85, 0.95, 1.1], [1, 0.97, 0.88], [0.95, 1, 1.05]];
export const LOGO = { r: 25, g: 79, b: 149 }; // the blue GAN logo, as photographed under warm light

const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

// Returns { faces, rings, truth } where faces[i] is the capture of canonical face order[i]
// turned so that rotating it clockwise rotations[i] quarter-turns makes it upright.
export function renderCube(facelets, rand, { logo = true, rings = false, cast, noise = 4, shuffle = true, rotate = true, linearCast = rand() < 0.5 } = {}) {
  const gauss = () => (rand() + rand() + rand() - 1.5) * 2;
  const palette = PALETTES[Math.floor(rand() * PALETTES.length)];
  const castC = cast ?? CASTS[Math.floor(rand() * CASTS.length)];
  const bright = 0.55 + rand() * 0.65;
  const paint = (base, faceGain, faceCast, shade) => {
    const out = base.map((v, k) => {
      let x = v;
      if (linearCast) x = 255 * srgb(toLin(v) * castC[k] * faceCast[k]);
      else x = v * castC[k] * faceCast[k];
      x = x * bright * faceGain * shade + gauss() * noise;
      return Math.max(0, Math.min(255, Math.round(x)));
    });
    return { r: out[0], g: out[1], b: out[2] };
  };
  const canon = FACES.map((f, fi) => {
    const faceGain = 0.9 + rand() * 0.2;
    const faceCast = [0, 1, 2].map(() => 1 + (rand() - 0.5) * 0.06);
    return Array.from({ length: 9 }, (_, i) => {
      const shade = 0.96 + rand() * 0.08;
      return paint(palette[COLOR_OF[facelets[fi * 9 + i]]], faceGain, faceCast, shade);
    });
  });
  const ringOf = FACES.map((f, fi) => paint(palette[COLOR_OF[facelets[fi * 9 + 4]]], 1, [1, 1, 1], 1));
  if (logo) {
    const fi = Math.floor(rand() * 6);
    const pick = rand();
    canon[fi][4] = pick < 0.6 ? { ...LOGO } : pick < 0.8 ? { r: 20, g: 20, b: 24 } : { r: 190, g: 25, b: 30 };
  }
  const order = FACES.map((_, i) => i);
  if (shuffle) order.sort(() => rand() - 0.5);
  const rotations = order.map(() => (rotate ? Math.floor(rand() * 4) : 0));
  const faces = order.map((fi, i) => rotateFace(canon[fi], (4 - rotations[i]) % 4));
  return { faces, rings: rings ? order.map((fi) => ringOf[fi]) : undefined, order, rotations };
}

export function randomCube(rand) {
  return applyMoves(SOLVED, randomScramble(25, rand));
}
