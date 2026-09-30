// Sticker color classification. Pure functions, no DOM — runs in the browser and in Node tests.
//
// Nothing here trusts the face centers: a logo on the white cap, a cream cast from warm
// light or a face shown in any order and rotation must not corrupt the result. So we
//   1. estimate the white balance from the data (the 8 least saturated stickers are white),
//   2. turn every sticker into a brightness-independent (a*, b*) feature,
//   3. cluster the 48 non-center stickers into 6 groups of exactly 8 (balanced k-means),
//   4. name the clusters by white = neutral, the rest by hue order (red, orange, yellow, green, blue),
//   5. give each face's center a different color by min-cost elimination.

export const COLOR_NAMES = ['white', 'yellow', 'green', 'blue', 'red', 'orange'];

// ---- Color math ----------------------------------------------------------------------

const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

function linearToLab(R, G, B) {
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// sRGB (0-255) → CIELAB, D65.
export function rgbToLab({ r, g, b }) {
  return linearToLab(lin(r), lin(g), lin(b));
}

// Min-cost assignment (Hungarian, O(n^3)); cost is n×m with n <= m. Returns column per row.
function hungarian(cost) {
  const n = cost.length, m = cost[0].length;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

// ---- Features ------------------------------------------------------------------------

const sat = ({ r, g, b }) => { const mx = Math.max(r, g, b); return mx < 1 ? 0 : (mx - Math.min(r, g, b)) / mx; };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

const Y_TARGET = 0.25; // every sticker is rescaled to this luminance before taking its hue/chroma
const Y_FLOOR = 0.004;

// White-balanced, brightness-normalised (a*, b*): multiplying all channels by k (lighting,
// exposure, per-face shading) leaves it unchanged, and a neutral sticker lands on (0, 0).
function feature(c, gains) {
  const R = lin(c.r) * gains[0], G = lin(c.g) * gains[1], B = lin(c.b) * gains[2];
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const k = Y_TARGET / Math.max(Y, Y_FLOOR);
  const [, a, b] = linearToLab(R * k, G * k, B * k);
  return [a, b];
}

// Typical stickers under neutral light. Only used to start the clustering and to tell red
// from orange etc. by hue; the real palette is learned from the data.
const REFERENCE = {
  white: { r: 235, g: 235, b: 235 }, yellow: { r: 240, g: 210, b: 30 }, green: { r: 20, g: 150, b: 70 },
  blue: { r: 20, g: 70, b: 170 }, red: { r: 185, g: 25, b: 40 }, orange: { r: 245, g: 110, b: 25 },
};
const REF_FEATURES = COLOR_NAMES.map((n) => feature(REFERENCE[n], [1, 1, 1]));
const REF_HUE = REF_FEATURES.map(([a, b]) => Math.atan2(b, a));

// Gains (linear light) that make the white stickers neutral. White is by far the least
// saturated sticker color, so the 8 least saturated non-center stickers are (almost all) white;
// a per-channel median shrugs off the odd intruder.
function estimateGains(stickers) {
  const cand = stickers.filter((c) => Math.max(c.r, c.g, c.b) >= 30).sort((p, q) => sat(p) - sat(q)).slice(0, 8);
  if (cand.length < 4) return [1, 1, 1];
  const w = [0, 1, 2].map((ch) => median(cand.map((c) => lin([c.r, c.g, c.b][ch]))));
  const mean = (w[0] + w[1] + w[2]) / 3;
  if (!(mean > 1e-4)) return [1, 1, 1];
  return w.map((v) => Math.min(4, Math.max(0.25, mean / Math.max(v, 1e-4))));
}

// ---- Clustering ----------------------------------------------------------------------

// Balanced k-means: 6 groups of exactly `per` items, alternating min-cost assignment and
// centroid updates. Returns { assign[], cents[], cost }.
function balancedCluster(items, start, per) {
  let cents = start.map((c) => c.slice());
  let assign = new Array(items.length).fill(-1);
  const run = () => {
    const wide = items.map((it) => cents.flatMap((c) => {
      const d = (it[0] - c[0]) ** 2 + (it[1] - c[1]) ** 2;
      return new Array(per).fill(d);
    }));
    const cols = hungarian(wide);
    return cols.map((j) => Math.floor(j / per));
  };
  for (let pass = 0; pass < 12; pass++) {
    const next = run();
    const same = next.every((c, i) => c === assign[i]);
    assign = next;
    if (same) break;
    cents = cents.map((old, c) => {
      const mem = items.filter((_, i) => assign[i] === c);
      return mem.length ? [mem.reduce((s, x) => s + x[0], 0) / mem.length, mem.reduce((s, x) => s + x[1], 0) / mem.length] : old;
    });
  }
  let cost = 0;
  items.forEach((it, i) => { cost += dist(it, cents[assign[i]]) ** 2; });
  return { assign, cents, cost };
}

function permutations(n) {
  const out = [];
  const rec = (cur, rest) => {
    if (!rest.length) { out.push(cur); return; }
    rest.forEach((x, i) => rec([...cur, x], rest.filter((_, j) => j !== i)));
  };
  rec([], Array.from({ length: n }, (_, i) => i));
  return out;
}
const PERMS5 = permutations(5);
const PERMS6 = permutations(6);

const angDiff = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };

// Name each cluster: the least chromatic is white; the other five take the assignment of
// {red, orange, yellow, green, blue} that best matches their hue angles (each used once).
function nameClusters(cents) {
  const chroma = cents.map(([a, b]) => Math.hypot(a, b));
  const white = chroma.indexOf(Math.min(...chroma));
  const rest = [0, 1, 2, 3, 4, 5].filter((k) => k !== white);
  const hueNames = ['red', 'orange', 'yellow', 'green', 'blue'];
  const refHue = hueNames.map((n) => REF_HUE[COLOR_NAMES.indexOf(n)]);
  const hue = rest.map((k) => Math.atan2(cents[k][1], cents[k][0]));
  let best = null, bestCost = Infinity;
  for (const perm of PERMS5) { // perm[j] = which reference hue cluster rest[j] takes
    let c = 0;
    for (let j = 0; j < 5; j++) c += angDiff(hue[j], refHue[perm[j]]) ** 2;
    if (c < bestCost) { bestCost = c; best = perm; }
  }
  const names = new Array(6);
  names[white] = 'white';
  rest.forEach((k, j) => { names[k] = hueNames[best[j]]; });
  return names;
}

// ---- Public API ----------------------------------------------------------------------

function cleanRgb(c) {
  const ch = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(0, Math.min(255, +v)) : NaN);
  const r = ch(c?.r), g = ch(c?.g), b = ch(c?.b);
  return Number.isNaN(r + g + b) ? { r: 128, g: 128, b: 128, bad: true } : { r, g, b, bad: false };
}

const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
const margin = (d1, d2) => clamp01((d2 - d1) / (d2 + d1 || 1));

// faces: 6 arrays of 9 {r,g,b}, row-major, in any order and rotation.
// centerRings: optional 6 {r,g,b} read from the ring around each center cap (logo-free).
// → { names: string[6][9], confidence: number[6][9], centers: string[6], centerAlternatives: string[6][] }
// centerAlternatives are the next most plausible center assignments (best first): when two
// centers look alike (a logo, glare) which one is white is genuinely ambiguous, and
// assembleCube() uses the cube's structure to pick.
export function classifyStickers(faces, { centerRings } = {}) {
  let wellFormed = Array.isArray(faces) && faces.length === 6;
  const grid = Array.from({ length: 6 }, (_, f) => Array.from({ length: 9 }, (_, i) => {
    const c = cleanRgb(faces?.[f]?.[i]);
    if (c.bad) wellFormed = false;
    return c;
  }));
  const rings = Array.from({ length: 6 }, (_, f) => (Array.isArray(centerRings) && centerRings[f] ? cleanRgb(centerRings[f]) : null))
    .map((c) => (c && !c.bad ? c : null));

  const others = [];
  grid.forEach((face, f) => face.forEach((c, i) => { if (i !== 4) others.push({ f, i, c }); }));
  const gains = estimateGains(others.map((o) => o.c));
  const items = others.map((o) => feature(o.c, gains));

  // Start from the reference palette, and from that palette with the two commonly confused
  // pairs' hues nudged; keep whichever start ends with the tightest clusters.
  let best = balancedCluster(items, REF_FEATURES, 8);
  for (const shift of [-0.25, 0.25]) {
    const start = REF_FEATURES.map(([a, b], k) => {
      if (k === 0) return [a, b];
      const h = Math.atan2(b, a) + shift, m = Math.hypot(a, b);
      return [m * Math.cos(h), m * Math.sin(h)];
    });
    const alt = balancedCluster(items, start, 8);
    if (alt.cost < best.cost - 1e-6) best = alt;
  }
  const clusterName = nameClusters(best.cents);

  const names = Array.from({ length: 6 }, () => new Array(9));
  const confidence = Array.from({ length: 6 }, () => new Array(9).fill(0));

  let minSep = Infinity;
  for (let p = 0; p < 6; p++) for (let q = p + 1; q < 6; q++) minSep = Math.min(minSep, dist(best.cents[p], best.cents[q]));
  const quality = wellFormed ? clamp01(minSep / 15) : 0;

  others.forEach((o, k) => {
    const d = best.cents.map((c) => dist(items[k], c));
    const mine = d[best.assign[k]];
    const other = Math.min(...d.filter((_, c) => c !== best.assign[k]));
    names[o.f][o.i] = clusterName[best.assign[k]];
    confidence[o.f][o.i] = o.c.bad ? 0 : margin(mine, other) * quality;
  });

  // Centers: each face gets a different color. Cost = distance to each cluster's centroid;
  // the ring (when we have it) is trusted, the cap sample itself only lightly.
  const centerFeat = grid.map((face) => feature(face[4], gains));
  const ringFeat = rings.map((c) => (c ? feature(c, gains) : null));
  const cost = centerFeat.map((cf, f) => best.cents.map((c) => {
    const own = dist(cf, c) * (grid[f][4].bad ? 0 : 1);
    return ringFeat[f] ? dist(ringFeat[f], c) + 0.25 * own : own;
  }));
  const colOf = hungarian(cost);
  const centers = colOf.map((k) => clusterName[k]);
  colOf.forEach((k, f) => {
    names[f][4] = clusterName[k];
    const ref = ringFeat[f] ?? centerFeat[f];
    const d = best.cents.map((c) => dist(ref, c));
    const other = Math.min(...d.filter((_, c) => c !== k));
    confidence[f][4] = grid[f][4].bad && !ringFeat[f] ? 0 : margin(d[k], other) * quality;
  });

  const total = (perm) => perm.reduce((s, k, f) => s + cost[f][k], 0);
  const bestKey = colOf.join();
  const centerAlternatives = PERMS6.filter((p) => p.join() !== bestKey)
    .map((p) => ({ p, c: total(p) })).sort((x, y) => x.c - y.c).slice(0, 7)
    .map(({ p }) => p.map((k) => clusterName[k]));

  return { names, confidence, centers, centerAlternatives };
}
