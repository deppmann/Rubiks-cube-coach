// Test helper (not a test): synthetic camera frames for the face detector. A cube face with
// thin dark gaps, an optional logo on the center cap, lit and tilted, over skin, fabric, rug,
// couch, wood or plain-noise backgrounds. Pure JS, no DOM: renderFrame() returns an
// ImageData-like { width, height, data } plus the ground truth. (Also used by the headless
// browser check, which draws these frames onto a canvas.)

export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sticker colors as a camera sees them under neutral light.
export const BASE = {
  white: [232, 234, 238], yellow: [246, 212, 18], green: [8, 152, 74],
  blue: [14, 74, 176], red: [190, 24, 44], orange: [250, 104, 20],
};
export const NAMES = Object.keys(BASE);
export const NATURAL_BG = ['skin', 'fabric', 'rug', 'couch', 'wood', 'wall'];
export const HARD_BG = ['noise', 'blocks'];

const clamp = (v, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
const coverage = (sd) => clamp(0.5 - sd, 0, 1); // signed distance in px → antialiased alpha

function boxSd(px, py, hx, hy, r) { // rounded box, half extents hx, hy, corner radius r
  const qx = Math.abs(px) - hx + r, qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function paintBackground(data, w, h, kind, rand) {
  const p1 = rand() * 6.28, p2 = rand() * 6.28, fx = 0.01 + rand() * 0.03, fy = 0.01 + rand() * 0.03;
  const jit = (v, d) => v + rand() * 2 * d - d;
  const base = {
    skin: [jit(206, 10), jit(152, 10), jit(124, 8)],
    fabric: [jit(108, 10), jit(116, 10), jit(146, 10)],
    rug: [jit(200, 10), jit(190, 10), jit(170, 10)],
    couch: [jit(188, 10), jit(178, 10), jit(162, 10)],
    wood: [jit(120, 15), jit(78, 10), jit(46, 6)],
    wall: [jit(200, 20), jit(200, 20), jit(195, 20)],
  }[kind] || [128, 128, 128];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (kind === 'noise') { data[o] = rand() * 255; data[o + 1] = rand() * 255; data[o + 2] = rand() * 255; data[o + 3] = 255; continue; }
      let shade = 1 + 0.10 * Math.sin(x * fx + p1) + 0.10 * Math.sin(y * fy + p2);
      if (kind === 'fabric') shade += 0.04 * Math.sin(y * 1.6) + 0.03 * Math.sin(x * 1.9);
      if (kind === 'wood') shade += 0.10 * Math.sin(y * 0.45 + 3 * Math.sin(x * 0.02));
      data[o] = base[0] * shade; data[o + 1] = base[1] * shade; data[o + 2] = base[2] * shade; data[o + 3] = 255;
    }
  }
  const blob = (cx, cy, rx, ry, col, a = 1) => {
    for (let y = Math.max(0, Math.floor(cy - ry - 1)); y < Math.min(h, cy + ry + 2); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx - 1)); x < Math.min(w, cx + rx + 2); x++) {
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
        const cv = clamp(0.5 - (d - 1) * Math.min(rx, ry), 0, 1) * a;
        if (!cv) continue;
        const o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) data[o + k] = data[o + k] * (1 - cv) + col[k] * cv;
      }
    }
  };
  if (kind === 'rug') { // small, colorful clutter
    const n = Math.round(w * h / 90);
    for (let i = 0; i < n; i++) {
      const r = rand();
      const c = r < 0.4 ? [40 + rand() * 40, 50 + rand() * 40, 90 + rand() * 80] : r < 0.7 ? [150 + rand() * 60, 60 + rand() * 40, 50 + rand() * 40] : [60 + rand() * 40, 50 + rand() * 30, 40 + rand() * 30];
      blob(rand() * w, rand() * h, 1 + rand() * 4, 1 + rand() * 4, c, 0.9);
    }
  }
  if (kind === 'blocks') { // random colored rectangles, half of them cube-colored
    for (let i = 0; i < 40; i++) {
      const bx = rand() * w, by = rand() * h, bw = 4 + rand() * 40, bh = 4 + rand() * 40;
      const c = rand() < 0.5 ? BASE[NAMES[(rand() * 6) | 0]] : [rand() * 255, rand() * 255, rand() * 255];
      for (let y = Math.max(0, by | 0); y < Math.min(h, by + bh); y++) {
        for (let x = Math.max(0, bx | 0); x < Math.min(w, bx + bw); x++) {
          const o = (y * w + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
        }
      }
    }
  }
  return blob;
}

// spec: { width, height, seed, bg, noise, blur,
//         cube: { cx, cy, size, angle, names[9], gapFrac, logo, hand, gain, cast } | null }
// → { img, truth: { cube: { cx, cy, size, angle, cells[9 rgb], names, palette } | null } }
export function renderFrame(spec) {
  const { width: w, height: h } = spec;
  const rand = mulberry32(spec.seed ?? 1);
  const data = new Uint8ClampedArray(w * h * 4);
  const f = new Float32Array(w * h * 3);
  const blob = paintBackground(data, w, h, spec.bg || 'wall', rand);
  const cube = spec.cube;
  const truth = { cube: null };
  const gain = cube?.gain ?? 0.6 + rand() * 0.5;
  const cast = cube?.cast ?? [1 + (rand() - 0.5) * 0.14, 1, 1 + (rand() - 0.5) * 0.14];

  if (cube) {
    const { cx, cy, size: s, angle = 0 } = cube;
    const a = angle * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    const c = s / 3, gap = (cube.gapFrac ?? 0.05) * c, tileR = 0.10 * c;
    if (cube.hand) { // fingers behind the cube, at its left and bottom edges
      const dirs = [[-1, 0.1], [0.05, 1], [-1, 0.6]];
      for (const [ux, uy] of dirs.slice(0, 2 + (rand() < 0.5 ? 1 : 0))) {
        const px = cx + cs * ux * s * 0.58 - sn * uy * s * 0.58, py = cy + sn * ux * s * 0.58 + cs * uy * s * 0.58;
        blob(px, py, s * (0.15 + rand() * 0.1), s * (0.28 + rand() * 0.1), [212 + rand() * 20, 158 + rand() * 20, 132 + rand() * 20], 1);
      }
    }
    const reach = s * 0.75 + 3;
    // Lit sticker colors; the shade varies gently across the face.
    const shadeAt = (gx, gy) => 0.94 + 0.10 * ((gx + gy) / s + 1) / 2;
    const lit = (name, shade) => BASE[name].map((v, k) => clamp(v * gain * cast[k] * shade));
    const logoCol = cube.logoColor || [22, 92, 205];
    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(h, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(w, Math.ceil(cx + reach)); x++) {
        const ix = x + 0.5 - cx, iy = y + 0.5 - cy;
        const gx = cs * ix + sn * iy, gy = -sn * ix + cs * iy; // grid coords, origin at center
        const plate = coverage(boxSd(gx, gy, s / 2, s / 2, 0.03 * s));
        if (!plate) continue;
        const o = (y * w + x) * 4;
        let col = [24 * gain, 24 * gain, 27 * gain];
        const ci = Math.max(0, Math.min(2, Math.floor((gx + s / 2) / c))), ri = Math.max(0, Math.min(2, Math.floor((gy + s / 2) / c)));
        const tx = (ci - 1) * c, ty = (ri - 1) * c;
        const center = ri === 1 && ci === 1;
        const cellCov = center ? coverage(Math.hypot(gx - tx, gy - ty) - 0.44 * c) : coverage(boxSd(gx - tx, gy - ty, c / 2 - gap / 2, c / 2 - gap / 2, tileR));
        if (cellCov) {
          let tc = lit(cube.names[ri * 3 + ci], shadeAt(gx, gy));
          if (center && cube.logo) {
            const lg = coverage(Math.hypot(gx - tx, (gy - ty) / 1.1) - 0.24 * c);
            tc = tc.map((v, k) => v * (1 - lg) + logoCol[k] * gain * lg);
          }
          col = col.map((v, k) => v * (1 - cellCov) + tc[k] * cellCov);
        }
        for (let k = 0; k < 3; k++) data[o + k] = data[o + k] * (1 - plate) + col[k] * plate;
      }
    }
    truth.cube = {
      cx, cy, size: s, angle,
      cells: cube.names.map((n, i) => lit(n, shadeAt(((i % 3) - 1) * c, (Math.floor(i / 3) - 1) * c))),
      names: cube.names.slice(),
      palette: Object.fromEntries(NAMES.map((n) => [n, lit(n, 0.99)])),
    };
  }

  // Global light (backgrounds get it too when there is no cube), blur, sensor noise.
  for (let i = 0, n = w * h; i < n; i++) {
    const o = i * 4;
    for (let k = 0; k < 3; k++) f[i * 3 + k] = data[o + k] * (cube ? 1 : gain * cast[k]);
  }
  const blur = spec.blur ?? 0.5, noise = spec.noise ?? 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        let v = f[(y * w + x) * 3 + k];
        if (blur > 0) {
          const l = f[(y * w + Math.max(0, x - 1)) * 3 + k], r = f[(y * w + Math.min(w - 1, x + 1)) * 3 + k];
          const u = f[(Math.max(0, y - 1) * w + x) * 3 + k], d = f[(Math.min(h - 1, y + 1) * w + x) * 3 + k];
          v = v * (1 - blur) + (l + r + u + d) / 4 * blur;
        }
        data[o + k] = clamp(v + (rand() + rand() + rand() - 1.5) * 2 * noise);
      }
      data[o + 3] = 255;
    }
  }
  return { img: { width: w, height: h, data }, truth };
}

// A random cube-face scene for `seed`: size 30–92% of the short side, tilt ±15°, natural background.
export function randomScene(seed, { width = 240, height = 320, bgs = NATURAL_BG } = {}) {
  const rand = mulberry32(seed * 7919 + 13);
  const short = Math.min(width, height);
  const size = short * (0.30 + rand() * 0.62);
  const angle = (rand() - 0.5) * 30;
  const half = size / 2 + 1;
  const cx = half + rand() * Math.max(0, width - 2 * half), cy = half + rand() * Math.max(0, height - 2 * half);
  const names = Array.from({ length: 9 }, () => NAMES[(rand() * 6) | 0]);
  const spec = {
    width, height, seed: seed + 1000, bg: bgs[(rand() * bgs.length) | 0],
    cube: { cx, cy, size, angle, names, gapFrac: 0.04 + rand() * 0.05, logo: rand() < 0.7, hand: rand() < 0.5 },
    noise: 2 + rand() * 4,
  };
  return { spec, ...renderFrame(spec) };
}
