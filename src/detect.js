// Find a Rubik's Cube face (a 3×3 grid of bright tiles separated by thin dark gaps) in a
// camera frame and read its nine sticker colors. Pure and DOM-free: it takes an
// ImageData-like { width, height, data: Uint8ClampedArray RGBA }, so it runs in Node tests
// and in the browser alike.
//
// How it works. The search runs on a ~200 px copy of the frame so it stays cheap:
//   1. A per-pixel "valley" map marks thin dark lines that sit between brighter pixels (one
//      map for vertical lines, one for horizontal). The downscale keeps each block's darkest
//      brightness, so hairline gaps survive it.
//   2. COARSE SEARCH. Every square (position × size) is scored as a 3×3 grid: the gap
//      segments between cells must lie on (slightly dilated) valleys, and a few pixels
//      per cell must be near-uniform and "cube colored" (saturated, or bright and neutral for
//      white; the center cell is read beside the logo, not on it). To tolerate tilt the
//      search runs on a few rotated views of the valley maps, and each view is axis-aligned so
//      any segment is four integral-image lookups.
//   3. FINE FIT of the best candidate on a small rotated crop: pattern search on the sharp
//      valley maps and box-sum color statistics, then a snap to the four inner gap lines
//      (their sub-pixel centroids give center and size, their lean gives the tilt), repeated
//      until the tilt settles. With a larger source image the fit is polished on a crop
//      taken from the original pixels.
//   4. Each cell's color is the median over its inner 40% in the original pixels; the center
//      also yields `centerRing`, a median over a ring around the logo.
//
// `prev` (the last detection) skips the search: the fit starts from where the face was.

export const WORK_SIZE = 200;          // long side of the search image
export const FOUND_SCORE = 0.40;       // a fit scoring below this is "no face"
const SIZE_MIN = 0.28, SIZE_MAX = 0.95; // square side as a fraction of the short side
const SIZE_STEP = 1.14;
const SEARCH_ROTS = [-16, 0, 16];      // coarse views; each covers about ±8° of tilt
const TOP_K = 5;                       // candidates kept per view
const QUICK_MIN = 0.6, GAP_MIN = 0.65; // coarse gap-evidence gates
const GAP_LO = 0.03, GAP_HI = 0.15;    // strip-mean valley strength that counts as no / a full gap
const LEVEL_SPLIT = 60;                // grids larger than this (work px) are searched at half resolution
const REFINE_MIN = 0.25;               // a coarse score below this is not worth a fine fit
const PATCH = 0.40;                    // sampled patch, fraction of a cell
const RING_IN = 0.30, RING_OUT = 0.44; // center ring radii, fraction of a cell

const rad = Math.PI / 180;
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerpStep = (v, a, b) => smooth((v - a) / (b - a));
const ri = Math.round;
const RECIP = new Float32Array(256).map((_, m) => 2 / (m + 12)); // valley strength = 2 (dip - floor) / (m + 12)
const FLOOR = new Float32Array(256).map((_, m) => 3 + m / 32);   // sensor-noise margin subtracted from every dip

// ---- Valley maps -----------------------------------------------------------------------

// gv[x,y] is high when pixel x is much darker than the brighter pixels on both sides of it
// (a dark vertical line); gh does the same vertically. Two widths are tried: a thin gap (the
// references sit 2..3 px away) and a wide one (4..6 px away, for a cube held close to the
// camera whose gaps are several pixels wide). v is brightness.
let M2 = new Uint8Array(0), M3 = new Uint8Array(0); // running maxima over 2 and 3 pixels
function valleys(v, w, h, gv, gh) {
  if (M2.length < w * h) { M2 = new Uint8Array(w * h); M3 = new Uint8Array(w * h); }
  // Horizontal: M2[x] = max(v[x..x+1]), M3[x] = max(v[x..x+2]); the thin references are M2 at
  // x-3 and x+2, the wide ones M3 at x-6 and x+4 (indices clamped at the image edge).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = v[row + x], b = v[row + (x + 1 < w ? x + 1 : w - 1)], c = v[row + (x + 2 < w ? x + 2 : w - 1)];
      const m = a > b ? a : b;
      M2[row + x] = m; M3[row + x] = m > c ? m : c;
    }
    for (let x = 0; x < w; x++) {
      const c = v[row + x];
      const tl = M2[row + (x >= 3 ? x - 3 : 0)], tr = M2[row + (x + 2 < w ? x + 2 : w - 1)];
      const wl = M3[row + (x >= 6 ? x - 6 : 0)], wr = M3[row + (x + 4 < w ? x + 4 : w - 1)];
      const t = tl < tr ? tl : tr, u = wl < wr ? wl : wr, mm = t > u ? t : u;
      const g = mm - c > FLOOR[mm] ? (mm - c - FLOOR[mm]) * RECIP[mm] : 0;
      gv[row + x] = g > 1 ? 1 : g;
    }
  }
  // Vertical: the same on columns, using the row-wise M arrays rebuilt down the image.
  for (let y = 0; y < h; y++) {
    const row = y * w, y1 = (y + 1 < h ? y + 1 : h - 1) * w, y2 = (y + 2 < h ? y + 2 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const a = v[row + x], b = v[y1 + x], c = v[y2 + x];
      const m = a > b ? a : b;
      M2[row + x] = m; M3[row + x] = m > c ? m : c;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const t3 = (y >= 3 ? y - 3 : 0) * w, b2 = (y + 2 < h ? y + 2 : h - 1) * w;
    const w6 = (y >= 6 ? y - 6 : 0) * w, w4 = (y + 4 < h ? y + 4 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const c = v[row + x];
      const tl = M2[t3 + x], tr = M2[b2 + x], wl = M3[w6 + x], wr = M3[w4 + x];
      const t = tl < tr ? tl : tr, u = wl < wr ? wl : wr, mm = t > u ? t : u;
      const g = mm - c > FLOOR[mm] ? (mm - c - FLOOR[mm]) * RECIP[mm] : 0;
      gh[row + x] = g > 1 ? 1 : g;
    }
  }
}

// Grey dilation by ±2 px (two 3-wide max passes): gv along x, gh along y.
function dilate(gv, gh, dv, dh, w, h, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = gv[row + (x > 0 ? x - 1 : 0)], b = gv[row + x], c = gv[row + (x + 1 < w ? x + 1 : w - 1)];
      tmp[row + x] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
    for (let x = 0; x < w; x++) {
      const a = tmp[row + (x > 0 ? x - 1 : 0)], b = tmp[row + x], c = tmp[row + (x + 1 < w ? x + 1 : w - 1)];
      dv[row + x] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w, row = y * w, dn = (y + 1 < h ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const a = gh[up + x], b = gh[row + x], c = gh[dn + x];
      tmp[row + x] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w, row = y * w, dn = (y + 1 < h ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const a = tmp[up + x], b = tmp[row + x], c = tmp[dn + x];
      dh[row + x] = a > b ? (a > c ? a : c) : (b > c ? b : c);
    }
  }
}

// ---- Coarse search: a base image plus rotated views of its dilated valley maps -----------

class Base {
  constructor() { this.cap = 0; }

  // work: { width, height, data RGBA, minV } (alpha holds the block-minimum brightness if minV)
  load(work) {
    const w = work.width, h = work.height, n = w * h;
    this.w = w; this.h = h; this.data = work.data;
    if (n > this.cap) {
      this.cap = n;
      this.v = new Uint8Array(n);
      for (const k of ['gv', 'gh', 'dv', 'dh', 'tmp']) this[k] = new Float32Array(n);
      const n2 = ((w + 1) >> 1) * ((h + 1) >> 1);
      for (const k of ['gv2', 'gh2', 'dv2', 'dh2', 'tmp2']) this[k] = new Float32Array(n2);
    }
    const w2 = (w + 1) >> 1, h2 = (h + 1) >> 1;
    this.w2 = w2; this.h2 = h2;
    const d = work.data, v = this.v;
    if (work.minV) for (let i = 0, q = 3; i < n; i++, q += 4) v[i] = d[q];
    else for (let i = 0, q = 0; i < n; i++, q += 4) { const r = d[q], g = d[q + 1], b = d[q + 2]; v[i] = r > g ? (r > b ? r : b) : (g > b ? g : b); }
    valleys(v, w, h, this.gv, this.gh);
    dilate(this.gv, this.gh, this.dv, this.dh, w, h, this.tmp);
    // Half resolution (max-pooled valleys, dilated again): the same tolerance in half the
    // pixels, so the position lattice can stay coarse for large grids.
    const { gv, gh, gv2, gh2 } = this;
    for (let y = 0; y < h2; y++) {
      const r0 = 2 * y * w, r1 = Math.min(2 * y + 1, h - 1) * w;
      for (let x = 0; x < w2; x++) {
        const x0 = 2 * x, x1 = Math.min(2 * x + 1, w - 1);
        let a = gv[r0 + x0], b = gv[r0 + x1], c = gv[r1 + x0], d = gv[r1 + x1];
        gv2[y * w2 + x] = Math.max(a, b, c, d);
        a = gh[r0 + x0]; b = gh[r0 + x1]; c = gh[r1 + x0]; d = gh[r1 + x1];
        gh2[y * w2 + x] = Math.max(a, b, c, d);
      }
    }
    dilate(gv2, gh2, this.dv2, this.dh2, w2, h2, this.tmp2);
  }
}

class View {
  constructor() { this.cap = 0; }

  // A vw×vh window on the base image whose center is base point (cx, cy), with the content
  // turned clockwise by rot degrees (a cube tilted by θ looks upright with rot = -θ).
  // level 1 works on the half-resolution maps: view pixels are then 2 base pixels wide.
  set(base, cx, cy, rot, vw, vh, level = 0) {
    this.base = base; this.w = vw; this.h = vh; this.cx = cx; this.cy = cy; this.rot = rot;
    const a = rot * rad, cs = Math.cos(a), sn = Math.sin(a);
    this.cs = cs; this.sn = sn;
    const sc = level ? 2 : 1;
    this.sc = sc;
    const W = vw + 1, m = W * (vh + 1);
    if (m > this.cap) { this.cap = m; this.GVD = new Float32Array(m); this.GHD = new Float32Array(m); }
    const { GVD, GHD } = this;
    const bw = level ? base.w2 : base.w, bh = level ? base.h2 : base.h, dv = level ? base.dv2 : base.dv, dh = level ? base.dh2 : base.dh;
    cx /= sc; cy /= sc;
    for (let x = 0; x <= vw; x++) { GVD[x] = 0; GHD[x] = 0; }
    for (let y = 0; y < vh; y++) {
      let sv = 0, sh = 0;
      const o0 = (y + 1) * W, o1 = y * W;
      GVD[o0] = 0; GHD[o0] = 0;
      const dy = y + 0.5 - vh / 2;
      for (let x = 0; x < vw; x++) {
        const dx = x + 0.5 - vw / 2;
        let px = ri(cx + cs * dx + sn * dy - 0.5), py = ri(cy - sn * dx + cs * dy - 0.5);
        px = px < 0 ? 0 : px >= bw ? bw - 1 : px; py = py < 0 ? 0 : py >= bh ? bh - 1 : py;
        const q = py * bw + px;
        sv += dv[q]; sh += dh[q];
        GVD[o0 + x + 1] = GVD[o1 + x + 1] + sv; GHD[o0 + x + 1] = GHD[o1 + x + 1] + sh;
      }
    }
  }

  toSrc(u, v) {
    const dx = u - this.w / 2, dy = v - this.h / 2, sc = this.sc;
    return [this.cx + sc * (this.cs * dx + this.sn * dy), this.cy + sc * (this.cs * dy - this.sn * dx)];
  }
}

// ---- Fine fit: a resampled crop with sharp valley maps and color sums -------------------

class Frame {
  constructor() { this.cap = 0; this.w = 0; this.h = 0; }

  // Fill from src (RGBA). The frame's center maps to (cx, cy) in src; k source px per frame px;
  // rot degrees clockwise applied to the content. When downscaling (k > 1.5) each frame pixel
  // averages a lattice of source pixels and keeps the darkest brightness among them.
  build(src, cx, cy, k, rot, w, h) {
    this.w = w; this.h = h; this.cx = cx; this.cy = cy; this.k = k; this.rot = rot;
    const n = w * h, m = (w + 1) * (h + 1);
    if (n > this.cap) {
      this.cap = n;
      this.rgb = new Uint8Array(3 * n); this.v = new Uint8Array(n);
      this.gv = new Float32Array(n); this.gh = new Float32Array(n);
      this.IR = new Float64Array(m); this.IG = new Float64Array(m); this.IB = new Float64Array(m); this.IQ = new Float64Array(m);
      this.GV = new Float32Array(m); this.GH = new Float32Array(m);
    }
    const sw = src.width, sh = src.height, sd = src.data, rgb = this.rgb, vv = this.v;
    const a = rot * rad, cs = Math.cos(a), sn = Math.sin(a);
    const lat = k > 1.5 ? Math.min(6, Math.ceil(k / 2)) : 0;
    const inv = lat ? 1 / (lat * lat) : 0, useA = !!src.minV;
    let o = 0, vi = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, o += 3) {
        if (lat) {
          let r = 0, g = 0, b = 0, vm = 255;
          for (let j = 0; j < lat; j++) {
            for (let i = 0; i < lat; i++) {
              const dx = (x + (i + 0.5) / lat - w / 2) * k, dy = (y + (j + 0.5) / lat - h / 2) * k;
              let px = ri(cx + cs * dx + sn * dy - 0.5), py = ri(cy - sn * dx + cs * dy - 0.5);
              px = px < 0 ? 0 : px >= sw ? sw - 1 : px; py = py < 0 ? 0 : py >= sh ? sh - 1 : py;
              const q = (py * sw + px) * 4;
              const sr = sd[q], sg = sd[q + 1], sb = sd[q + 2];
              r += sr; g += sg; b += sb;
              const sv = useA ? sd[q + 3] : sr > sg ? (sr > sb ? sr : sb) : (sg > sb ? sg : sb);
              if (sv < vm) vm = sv;
            }
          }
          rgb[o] = r * inv; rgb[o + 1] = g * inv; rgb[o + 2] = b * inv;
          vv[vi++] = vm;
        } else {
          const dx = (x + 0.5 - w / 2) * k, dy = (y + 0.5 - h / 2) * k;
          let fx = cx + cs * dx + sn * dy - 0.5, fy = cy - sn * dx + cs * dy - 0.5;
          fx = fx < 0 ? 0 : fx > sw - 1 ? sw - 1 : fx; fy = fy < 0 ? 0 : fy > sh - 1 ? sh - 1 : fy;
          const x0 = fx | 0, y0 = fy | 0, x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
          const ax = fx - x0, ay = fy - y0;
          const q00 = (y0 * sw + x0) * 4, q10 = (y0 * sw + x1) * 4, q01 = (y1 * sw + x0) * 4, q11 = (y1 * sw + x1) * 4;
          const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
          const r = sd[q00] * w00 + sd[q10] * w10 + sd[q01] * w01 + sd[q11] * w11;
          const g = sd[q00 + 1] * w00 + sd[q10 + 1] * w10 + sd[q01 + 1] * w01 + sd[q11 + 1] * w11;
          const b = sd[q00 + 2] * w00 + sd[q10 + 2] * w10 + sd[q01 + 2] * w01 + sd[q11 + 2] * w11;
          rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
          vv[vi++] = useA ? sd[q00 + 3] * w00 + sd[q10 + 3] * w10 + sd[q01 + 3] * w01 + sd[q11 + 3] * w11
            : r > g ? (r > b ? r : b) : (g > b ? g : b);
        }
      }
    }
    valleys(vv, w, h, this.gv, this.gh);
    const { IR, IG, IB, IQ, GV, GH, gv, gh } = this, W = w + 1;
    for (let x = 0; x <= w; x++) { IR[x] = IG[x] = IB[x] = IQ[x] = GV[x] = GH[x] = 0; }
    for (let y = 0; y < h; y++) {
      let sr = 0, sg = 0, sb = 0, sq = 0, sv = 0, sHz = 0;
      const o0 = (y + 1) * W, o1 = y * W;
      IR[o0] = IG[o0] = IB[o0] = IQ[o0] = GV[o0] = GH[o0] = 0;
      for (let x = 0, p = y * w * 3, g = y * w; x < w; x++, p += 3, g++) {
        const r = rgb[p], gg = rgb[p + 1], b = rgb[p + 2];
        sr += r; sg += gg; sb += b; sq += r * r + gg * gg + b * b; sv += gv[g]; sHz += gh[g];
        const i = o0 + x + 1, j = o1 + x + 1;
        IR[i] = IR[j] + sr; IG[i] = IG[j] + sg; IB[i] = IB[j] + sb; IQ[i] = IQ[j] + sq;
        GV[i] = GV[j] + sv; GH[i] = GH[j] + sHz;
      }
    }
  }

  toSrc(u, v) {
    const dx = (u - this.w / 2) * this.k, dy = (v - this.h / 2) * this.k;
    const a = this.rot * rad, cs = Math.cos(a), sn = Math.sin(a);
    return [this.cx + cs * dx + sn * dy, this.cy - sn * dx + cs * dy];
  }
}

// ---- Scoring ---------------------------------------------------------------------------

// Mean of an integral image over the box (x0, y0)-(x1, y1), rounded to whole pixels (min 1×1).
function boxAvg(I, W, x0, y0, x1, y1) {
  x0 = ri(x0); y0 = ri(y0); x1 = ri(x1); y1 = ri(y1);
  if (x1 <= x0) x1 = x0 + 1;
  if (y1 <= y0) y1 = y0 + 1;
  return (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
}

// Mean gap-line evidence on the cell-to-cell segments of the grid (x, y, s) in the maps GV
// (vertical lines) and GH (horizontal lines): the geometric mean of the two directions' averages.
// `quick` looks at the 4 middle segments only.
function gapScore(GV, GH, W, x, y, s, quick, inset) {
  const c = s / 3, hw = Math.max(1.5, 0.09 * c);
  let sv = 0, sh = 0, n = 0;
  for (let k = 1; k <= 2; k++) {
    const xc = x + k * c, yc = y + k * c;
    for (let r = quick ? 1 : 0; r < (quick ? 2 : 3); r++) {
      const a = y + r * c + inset * c, b = y + (r + 1) * c - inset * c;
      sv += lerpStep(boxAvg(GV, W, xc - hw, a, xc + hw, b), GAP_LO, GAP_HI);
      const a2 = x + r * c + inset * c, b2 = x + (r + 1) * c - inset * c;
      sh += lerpStep(boxAvg(GH, W, a2, yc - hw, b2, yc + hw), GAP_LO, GAP_HI);
      n++;
    }
  }
  // Both directions must show gaps: wood grain or a striped rug has lines one way only.
  return Math.sqrt((sv / n) * (sh / n));
}

// How "cube-like" a color is: saturated and not too dark, or bright and neutral (white).
function cubeness(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx ? (mx - mn) / mx : 0;
  const colored = lerpStep(sat, 0.38, 0.62) * lerpStep(mx, 45, 95);
  const white = (1 - lerpStep(sat, 0.20, 0.36)) * lerpStep(mn, 105, 165);
  return colored > white ? colored : white;
}

const cellQuality = (r, g, b, sd, center) => {
  const t = sd / (center ? 30 : 18);
  return cubeness(r, g, b) / (1 + t * t);
};
const combine = (sum, min) => (sum / 9) * (0.6 + 0.4 * min);

// Coarse score of the square (x, y, s) in a view: gap evidence gates, then a few pixels per cell.
const PIX = new Float64Array(27);
function pixAt(view, u, v, o) {
  const b = view.base, dx = u - view.w / 2, dy = v - view.h / 2, sc = view.sc;
  let ix = ri(view.cx + sc * (view.cs * dx + view.sn * dy) - 0.5), iy = ri(view.cy + sc * (view.cs * dy - view.sn * dx) - 0.5);
  ix = ix < 0 ? 0 : ix >= b.w ? b.w - 1 : ix; iy = iy < 0 ? 0 : iy >= b.h ? b.h - 1 : iy;
  const p = (iy * b.w + ix) * 4;
  PIX[o] = b.data[p]; PIX[o + 1] = b.data[p + 1]; PIX[o + 2] = b.data[p + 2];
}

function scoreCoarse(view, x, y, s) {
  if (x < 0 || y < 0 || x + s > view.w || y + s > view.h || s < 12) return 0;
  const W = view.w + 1, c0 = s / 3, hw0 = Math.max(1.5, 0.09 * c0);
  // One segment first: most positions have nothing there.
  if (boxAvg(view.GVD, W, x + c0 - hw0, y + c0 + 0.28 * c0, x + c0 + hw0, y + 2 * c0 - 0.28 * c0) < 0.12) return 0;
  if (gapScore(view.GVD, view.GHD, W, x, y, s, true, 0.28) < QUICK_MIN) return 0;
  const gap = gapScore(view.GVD, view.GHD, W, x, y, s, false, 0.28);
  if (gap < GAP_MIN) return 0;
  const c = s / 3, d = 0.2 * c;
  let sum = 0, min = 1;
  for (let r = 0; r < 3; r++) {
    for (let cc = 0; cc < 3; cc++) {
      const cx = x + (cc + 0.5) * c, cy = y + (r + 0.5) * c, center = r === 1 && cc === 1;
      let n = 9;
      if (center) { // four points on the cap beside the logo
        const e = 0.35 * c;
        pixAt(view, cx - e, cy, 0); pixAt(view, cx + e, cy, 3); pixAt(view, cx, cy - e, 6); pixAt(view, cx, cy + e, 9);
        n = 4;
      } else { // 3×3 lattice inside the tile
        let o = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++, o += 3) pixAt(view, cx + i * d, cy + j * d, o);
      }
      let mr = 0, mg = 0, mb = 0, q2 = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 3, R = PIX[o], G = PIX[o + 1], B = PIX[o + 2];
        mr += R; mg += G; mb += B; q2 += R * R + G * G + B * B;
      }
      mr /= n; mg /= n; mb /= n;
      const q = cellQuality(mr, mg, mb, Math.sqrt(Math.max(0, q2 / n - (mr * mr + mg * mg + mb * mb))), center);
      sum += q;
      if (q < min) min = q;
    }
  }
  return combine(sum, min) * gap;
}

const TMP = new Float64Array(4);
// Mean color and spread of the box (x0, y0)-(x1, y1) in a fine frame → TMP = [r, g, b, sd].
function boxStats(f, x0, y0, x1, y1) {
  const W = f.w + 1;
  x0 = ri(x0); y0 = ri(y0); x1 = ri(x1); y1 = ri(y1);
  if (x1 <= x0) x1 = x0 + 1;
  if (y1 <= y0) y1 = y0 + 1;
  const n = (x1 - x0) * (y1 - y0);
  const A = y0 * W + x0, B = y0 * W + x1, C = y1 * W + x0, D = y1 * W + x1;
  const r = (f.IR[D] - f.IR[B] - f.IR[C] + f.IR[A]) / n;
  const g = (f.IG[D] - f.IG[B] - f.IG[C] + f.IG[A]) / n;
  const b = (f.IB[D] - f.IB[B] - f.IB[C] + f.IB[A]) / n;
  const q = (f.IQ[D] - f.IQ[B] - f.IQ[C] + f.IQ[A]) / n;
  TMP[0] = r; TMP[1] = g; TMP[2] = b;
  TMP[3] = Math.sqrt(Math.max(0, q - (r * r + g * g + b * b)));
}

// Four bars around the middle of the center cell (clear of a logo and of the cell corners).
function ringStats(f, cx, cy, c) {
  const a = 0.31 * c, b = 0.40 * c, l = 0.13 * c;
  let r = 0, g = 0, bl = 0, sd = 0;
  const bars = [[cx - b, cy - l, cx - a, cy + l], [cx + a, cy - l, cx + b, cy + l], [cx - l, cy - b, cx + l, cy - a], [cx - l, cy + a, cx + l, cy + b]];
  for (const [x0, y0, x1, y1] of bars) {
    boxStats(f, x0, y0, x1, y1);
    r += TMP[0]; g += TMP[1]; bl += TMP[2]; sd += TMP[3];
  }
  TMP[0] = r / 4; TMP[1] = g / 4; TMP[2] = bl / 4; TMP[3] = sd / 4;
}

// Fine score in [0, 1] of the square (x, y, s), axis-aligned in the frame.
function scoreFine(f, x, y, s) {
  if (x < 0 || y < 0 || x + s > f.w || y + s > f.h || s < 12) return 0;
  const W = f.w + 1;
  if (gapScore(f.GV, f.GH, W, x, y, s, true, 0.2) < 0.02) return 0;
  const gap = gapScore(f.GV, f.GH, W, x, y, s, false, 0.2);
  if (gap < 0.05) return 0;
  const c = s / 3, hi = 0.26 * c;
  let sum = 0, min = 1;
  for (let r = 0; r < 3; r++) {
    for (let cc = 0; cc < 3; cc++) {
      const cx = x + (cc + 0.5) * c, cy = y + (r + 0.5) * c, center = r === 1 && cc === 1;
      if (center) ringStats(f, cx, cy, c);
      else boxStats(f, cx - hi, cy - hi, cx + hi, cy + hi);
      const q = cellQuality(TMP[0], TMP[1], TMP[2], TMP[3], center);
      sum += q;
      if (q < min) min = q;
    }
  }
  return combine(sum, min) * gap;
}

// Pattern search over (x, y, s) from the given start; score(x, y, s) → [best, x, y, s].
function hillClimb(score, x, y, s, levels = 3) {
  let best = score(x, y, s);
  const dps = [2, 1, 0.5, 0.25], dss = [0.06, 0.03, 0.015, 0.007];
  for (let lv = 0; lv < levels; lv++) {
    const dp = dps[lv];
    for (let iter = 0; iter < 24; iter++) {
      const ds = dss[lv] * s;
      let bx = x, by = y, bs = s, bv = best;
      const tryAt = (nx, ny, ns) => { const v = score(nx, ny, ns); if (v > bv) { bv = v; bx = nx; by = ny; bs = ns; } };
      tryAt(x + dp, y, s); tryAt(x - dp, y, s); tryAt(x, y + dp, s); tryAt(x, y - dp, s);
      tryAt(x - ds / 2, y - ds / 2, s + ds); tryAt(x + ds / 2, y + ds / 2, s - ds);
      tryAt(x + dp, y + dp, s); tryAt(x - dp, y - dp, s); tryAt(x + dp, y - dp, s); tryAt(x - dp, y + dp, s);
      if (bv <= best) break;
      best = bv; x = bx; y = by; s = bs;
    }
  }
  return [best, x, y, s];
}

// ---- Coarse search and refinement -----------------------------------------------------

const base = new Base();
const view = new View();
const frame = new Frame();

// Keep the TOP_K best distinct candidates {score, x, y, s} seen so far.
function addTop(top, c) {
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    if (Math.abs(t.x + t.s / 2 - c.x - c.s / 2) < 0.3 * t.s && Math.abs(t.y + t.s / 2 - c.y - c.s / 2) < 0.3 * t.s && Math.abs(t.s / c.s - 1) < 0.25) {
      if (c.score > t.score) top[i] = c;
      return;
    }
  }
  if (top.length < TOP_K) top.push(c);
  else {
    let w = 0;
    for (let i = 1; i < top.length; i++) if (top[i].score < top[w].score) w = i;
    if (c.score > top[w].score) top[w] = c;
  }
}

function scanView(v, top, sMin, sMax) {
  for (let s = sMin; s <= sMax; s *= SIZE_STEP) {
    const step = Math.max(2, Math.round(s / 16));
    const xMax = v.w - s, yMax = v.h - s;
    for (let y = 0; y <= yMax; y += step) {
      for (let x = 0; x <= xMax; x += step) {
        const sc = scoreCoarse(v, x, y, s);
        if (sc > 0.08) addTop(top, { score: sc, x, y, s });
      }
    }
  }
}

// Coarse pattern search from a candidate {cx, cy, s, rot} (base coords) in a small tilted view.
function refineCoarse(cand) {
  const sc = cand.level ? 2 : 1, cs = cand.s / sc;
  const o = Math.max(32, Math.ceil(1.5 * cs) + 8);
  view.set(base, cand.cx, cand.cy, cand.rot, o, o, cand.level);
  const [score, x, y, s] = hillClimb((a, b, c) => scoreCoarse(view, a, b, c), o / 2 - cs / 2, o / 2 - cs / 2, cs, 2);
  const [cx, cy] = view.toSrc(x + s / 2, y + s / 2);
  return { score, cx, cy, s: s * sc, rot: cand.rot };
}

// Sub-pixel position of the dark line near `at` along an axis: the weighted centroid of the
// valley evidence in the window at ± half, over the rows/columns lo..hi. NaN if no clear line.
function lineCentroid(f, vertical, at, half, lo, hi) {
  const I = vertical ? f.GV : f.GH, W = f.w + 1;
  const a = Math.floor(at - half), b = Math.ceil(at + half);
  const vals = [];
  let mx = 0;
  for (let i = a; i < b; i++) {
    const val = i < 0 || i >= (vertical ? f.w : f.h) ? 0
      : vertical ? boxAvg(I, W, i, lo, i + 1, hi) : boxAvg(I, W, lo, i, hi, i + 1);
    vals.push(val);
    if (val > mx) mx = val;
  }
  if (mx < 0.15) return NaN;
  let sw = 0, sx = 0;
  const t = 0.35 * mx;
  vals.forEach((val, j) => { if (val > t) { sw += val - t; sx += (val - t) * (a + j + 0.5); } });
  return sx / sw;
}

// Fit the grid to the measured positions of the four inner gap lines: they sit at 1/3 and 2/3
// of the square, so their centroids give center and size to sub-pixel accuracy, and how much
// each line leans gives the residual tilt. → { x, y, s, dTheta (deg, clockwise) } or null.
function snap(f, x, y, s) {
  const c = s / 3, half = Math.max(2.5, 0.16 * c);
  const vx = [], hy = []; // per line: centroids of its 3 segments
  let lean = 0, nLean = 0;
  for (let k = 1; k <= 2; k++) {
    const pv = [], ph = [];
    for (let r = 0; r < 3; r++) {
      const a = r * c + 0.2 * c, b = (r + 1) * c - 0.2 * c;
      pv.push(lineCentroid(f, true, x + k * c, half, y + a, y + b));
      ph.push(lineCentroid(f, false, y + k * c, half, x + a, x + b));
    }
    // Slope of the line's position along its length. A grid turned clockwise by theta has
    // vertical lines with dx/dy = -tan(theta) and horizontal lines with dy/dx = tan(theta).
    for (const [ps, sign] of [[pv, -1], [ph, 1]]) {
      const ok = ps.map((val, r) => [r, val]).filter(([, val]) => !Number.isNaN(val));
      if (ok.length < 2) continue;
      const mr = ok.reduce((t, [r]) => t + r, 0) / ok.length, mp = ok.reduce((t, [, val]) => t + val, 0) / ok.length;
      let num = 0, den = 0;
      for (const [r, val] of ok) { num += (r - mr) * (val - mp); den += (r - mr) ** 2; }
      lean += sign * Math.atan((num / den) / c); nLean++;
    }
    vx.push(pv.filter((val) => !Number.isNaN(val))); hy.push(ph.filter((val) => !Number.isNaN(val)));
  }
  if (vx.some((val) => !val.length) || hy.some((val) => !val.length)) return null;
  const mean = (arr) => arr.reduce((t, val) => t + val, 0) / arr.length;
  const p1 = mean(vx[0]), p2 = mean(vx[1]), q1 = mean(hy[0]), q2 = mean(hy[1]);
  const sv = 3 * (p2 - p1), sh = 3 * (q2 - q1);
  if (sv < 0.7 * s || sv > 1.3 * s || sh < 0.7 * s || sh > 1.3 * s) return null;
  const ns = (sv + sh) / 2;
  return { x: (p1 + p2) / 2 - ns / 2, y: (q1 + q2) / 2 - ns / 2, s: ns, dTheta: nLean ? (lean / nLean) / rad : 0 };
}

// Fine fit of a candidate {cx, cy, s, rot} (src coords) on crops taken from `src` at k source
// px per crop px. Each round: look at the gap lines first (tolerant of a few pixels and several
// degrees of error) and, if the grid is still visibly tilted, re-aim the crop and go again;
// otherwise pattern-search the score and snap to the gap lines for the final geometry.
function refineFine(src, k, cand, iters, fixedSize) {
  let { cx, cy, s, rot } = cand;
  let best = null;
  const score = (a, b, c) => scoreFine(frame, a, b, c);
  for (let it = 0; it < iters; it++) {
    const o = fixedSize || Math.max(32, Math.ceil(1.45 * s / k) + 8);
    frame.build(src, cx, cy, k, rot, o, o);
    let x = o / 2 - s / k / 2, y = x, ss = s / k, dTheta = 0;
    const pre = snap(frame, x, y, ss);
    if (pre) {
      x = pre.x; y = pre.y; ss = pre.s; dTheta = pre.dTheta;
      if (Math.abs(dTheta) > 1.5 && it < iters - 1) { // re-aim first: scoring is fragile while tilted
        [cx, cy] = frame.toSrc(x + ss / 2, y + ss / 2);
        s = ss * k;
        rot -= dTheta;
        continue;
      }
    }
    let sc;
    [sc, x, y, ss] = hillClimb(score, x, y, ss, 3);
    for (let n = 0; n < 3; n++) {
      const sn = snap(frame, x, y, ss);
      if (!sn) break;
      const v = scoreFine(frame, sn.x, sn.y, sn.s);
      dTheta = sn.dTheta;
      if (v < 0.85 * sc) break; // the measured lines disagree with the grid: keep the pattern-search fit
      const moved = Math.abs(sn.s - ss) + Math.abs(sn.x - x) + Math.abs(sn.y - y);
      sc = Math.max(sc, v); x = sn.x; y = sn.y; ss = sn.s;
      if (moved < 0.5) break;
    }
    [cx, cy] = frame.toSrc(x + ss / 2, y + ss / 2);
    s = ss * k;
    const r = { score: sc, cx, cy, s, rot };
    if (!best || sc > best.score) best = r;
    if (Math.abs(dTheta) < 0.6) break;
    rot -= dTheta;
  }
  return best;
}

// ---- Downscaling ---------------------------------------------------------------------

// The work copy keeps the *darkest* brightness of each block in its alpha channel (minV), so
// hairline gaps survive the downscale; colors are block averages.
const workBuf = { width: 0, height: 0, data: null, minV: true };
function makeWork(img) {
  const long = Math.max(img.width, img.height);
  if (long <= WORK_SIZE * 1.25) return { work: img, f: 1 };
  const f = long / WORK_SIZE;
  const w = Math.round(img.width / f), h = Math.round(img.height / f);
  if (!workBuf.data || workBuf.data.length < w * h * 4) workBuf.data = new Uint8ClampedArray(w * h * 4);
  workBuf.width = w; workBuf.height = h;
  const n = Math.max(2, Math.min(6, Math.ceil(f / 2))), inv = 1 / (n * n), fx = img.width / w, fy = img.height / h;
  const sd = img.data, out = workBuf.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, vm = 255;
      for (let j = 0; j < n; j++) {
        const sy = Math.min(img.height - 1, Math.floor((y + (j + 0.5) / n) * fy));
        for (let i = 0; i < n; i++) {
          const q = (sy * img.width + Math.min(img.width - 1, Math.floor((x + (i + 0.5) / n) * fx))) * 4;
          const sr = sd[q], sg = sd[q + 1], sb = sd[q + 2];
          r += sr; g += sg; b += sb;
          const sv = sr > sg ? (sr > sb ? sr : sb) : (sg > sb ? sg : sb);
          if (sv < vm) vm = sv;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv; out[o + 3] = vm;
    }
  }
  return { work: workBuf, f: (fx + fy) / 2 };
}

// ---- Geometry helpers and sampling -----------------------------------------------------

// Image position of the point (u, v) in the grid's own frame, each 0..1 across the grid
// (0,0 = top-left corner). det needs x, y, size and angle (degrees, clockwise).
export function gridPoint(det, u, v) {
  const a = (det.angle || 0) * rad, cs = Math.cos(a), sn = Math.sin(a);
  const dx = (u - 0.5) * det.size, dy = (v - 0.5) * det.size;
  return [det.x + det.size / 2 + cs * dx - sn * dy, det.y + det.size / 2 + sn * dx + cs * dy];
}

function median256(hist, n) {
  let acc = 0;
  const half = n / 2;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= half) return i; }
  return 255;
}

// Median color of the sample points (flat [x0, y0, x1, y1, ...]) in an RGBA image.
const H = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
function medianColor(img, points) {
  H[0].fill(0); H[1].fill(0); H[2].fill(0);
  let n = 0;
  const { width: w, height: h, data } = img;
  for (let i = 0; i < points.length; i += 2) {
    const px = Math.floor(points[i]), py = Math.floor(points[i + 1]);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const q = (py * w + px) * 4;
    H[0][data[q]]++; H[1][data[q + 1]]++; H[2][data[q + 2]]++;
    n++;
  }
  if (!n) return { r: 0, g: 0, b: 0 };
  return { r: median256(H[0], n), g: median256(H[1], n), b: median256(H[2], n) };
}

// Median color of each cell's inner 40% (row-major in the grid's frame) and of the ring
// around the center logo, read from the original pixels of img along the detected grid.
export function sampleFace(img, det) {
  const c = det.size / 3;
  const a = (det.angle || 0) * rad, cs = Math.cos(a), sn = Math.sin(a);
  const cx0 = det.x + det.size / 2, cy0 = det.y + det.size / 2;
  const per = Math.max(4, Math.min(22, Math.round(PATCH * c))); // about one sample per pixel
  const cells = [];
  const pts = [];
  for (let r = 0; r < 3; r++) {
    for (let cc = 0; cc < 3; cc++) {
      const ux = (cc - 1) * c, uy = (r - 1) * c;
      pts.length = 0;
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < per; i++) {
          const dx = ux + ((i + 0.5) / per - 0.5) * PATCH * c, dy = uy + ((j + 0.5) / per - 0.5) * PATCH * c;
          pts.push(cx0 + cs * dx - sn * dy, cy0 + sn * dx + cs * dy);
        }
      }
      cells.push(medianColor(img, pts));
    }
  }
  const ringPts = [];
  const per2 = Math.max(8, Math.min(40, Math.round(2 * RING_OUT * c)));
  for (let j = 0; j < per2; j++) {
    for (let i = 0; i < per2; i++) {
      const dx = ((i + 0.5) / per2 - 0.5) * 2 * RING_OUT * c, dy = ((j + 0.5) / per2 - 0.5) * 2 * RING_OUT * c;
      const d = Math.hypot(dx, dy);
      if (d < RING_IN * c || d > RING_OUT * c) continue;
      ringPts.push(cx0 + cs * dx - sn * dy, cy0 + sn * dx + cs * dy);
    }
  }
  return { cells, centerRing: medianColor(img, ringPts) };
}

// ---- Public API -----------------------------------------------------------------------

// Detect a cube face. `prev` (the last detection, same image coordinates) makes the fit
// start from where the face was, which is faster and steadier than a fresh search.
// → { found, x, y, size, angle, cells: [9 {r,g,b}], centerRing: {r,g,b}, score }
// (x, y, size) is the grid's square in img pixels; when the grid is tilted it is the
// axis-aligned square with the same center, and `angle` (degrees, clockwise) says how far
// the grid is turned about that center. Use gridPoint() to place things on it. Cells are
// row-major in the grid's own frame.
export function detectFace(img, { prev } = {}) {
  const { work, f } = makeWork(img);
  const ww = work.width, wh = work.height;
  const none = (score = 0) => ({ found: false, x: 0, y: 0, size: 0, angle: 0, cells: [], centerRing: null, score });
  if (ww < 24 || wh < 24) return none();

  let best = null;
  // 1. Fit from the previous detection (no search: the gap lines pull the fit into place).
  if (prev && prev.found !== false && prev.size) {
    const r = refineFine(work, 1, { cx: (prev.x + prev.size / 2) / f, cy: (prev.y + prev.size / 2) / f, s: prev.size / f, rot: -(prev.angle || 0) }, 2);
    if (r.score >= FOUND_SCORE) best = r;
  }
  // 2. Full search: coarse scan of a few rotated views, then fit the best candidates.
  if (!best) {
    base.load(work);
    const cands = [];
    const short = Math.min(ww, wh);
    for (const rot of SEARCH_ROTS) {
      // Small grids at full resolution, large ones at half resolution (see Base.load).
      for (const level of [0, 1]) {
        const sc = level ? 2 : 1;
        view.set(base, ww / 2, wh / 2, rot, level ? base.w2 : ww, level ? base.h2 : wh, level);
        const top = [];
        scanView(view, top, level ? LEVEL_SPLIT / sc : SIZE_MIN * short, level ? SIZE_MAX * short / sc : LEVEL_SPLIT - 0.01);
        for (const t of top) {
          const [cx, cy] = view.toSrc(t.x + t.s / 2, t.y + t.s / 2);
          cands.push({ score: t.score, cx, cy, s: t.s * sc, rot, level });
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of cands) { // best few, skipping near-duplicates seen through different views
      if (picked.some((p) => Math.hypot(p.cx - c.cx, p.cy - c.cy) < 0.3 * p.s && Math.abs(p.s / c.s - 1) < 0.3)) continue;
      picked.push(c);
      if (picked.length === 3) break;
    }
    const seeds = picked.map(refineCoarse).filter((c) => c.score >= REFINE_MIN).sort((a, b) => b.score - a.score);
    for (const c of seeds.slice(0, 2)) {
      const r = refineFine(work, 1, c, 3);
      if (!best || r.score > best.score) best = r;
      if (best.score >= FOUND_SCORE) break;
    }
  }
  if (!best || best.score < FOUND_SCORE) return none(best ? best.score : 0);

  // 3. Polish on a crop of the original pixels when the source is much bigger than the work image.
  let cx = best.cx * f, cy = best.cy * f, size = best.s * f, rot = best.rot, score = best.score;
  if (f > 1.6) {
    const target = 120, k = size / target;
    const hi = refineFine(img, k, { cx, cy, s: size, rot }, 1, Math.round(target * 1.5));
    if (hi.score >= 0.8 * score) { cx = hi.cx; cy = hi.cy; size = hi.s; rot = hi.rot; score = Math.max(score, hi.score); }
  }
  const det = { found: true, x: cx - size / 2, y: cy - size / 2, size, angle: -rot, score };
  const { cells, centerRing } = sampleFace(img, det);
  det.cells = cells;
  det.centerRing = centerRing;
  return det;
}

export const _debug = { boxStats, ringStats, TMP, cellQuality, gapScore, cubeness, scanView, SEARCH_ROTS, Base, View, Frame, base, view, frame, scoreCoarse, scoreFine, hillClimb, snap, refineCoarse, refineFine, makeWork };
