// Camera capture + sticker color classification.
// The color math and classifyFaces are pure (no DOM) so they run in Node tests;
// CameraScanner is the only part that touches the browser.

export const SCAN_ORDER = [
  { face: 'F', title: 'Green face', instruction: 'Hold the cube with white on the bottom and the green center facing the camera. Line it up with the grid.' },
  { face: 'R', title: 'Orange face', instruction: 'Turn the whole cube to the left so the orange center faces the camera. Keep white on the bottom.' },
  { face: 'B', title: 'Blue face', instruction: 'Turn it the same way again to show the blue center. White stays on the bottom.' },
  { face: 'L', title: 'Red face', instruction: 'One more turn shows the red center. White is still on the bottom.' },
  { face: 'U', title: 'Yellow face', instruction: 'Tip the top toward the camera so yellow faces you. The green side should be at the bottom of the picture.' },
  { face: 'D', title: 'White face', instruction: 'Now tip the cube so white faces you, with the green side at the top of the picture.' },
];

// ---- Color math (pure) -----------------------------------------------------------

const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

// sRGB (0-255) → CIELAB, D65.
export function rgbToLab({ r, g, b }) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Lighting changes L a lot but hue little, so L is down-weighted; hue (a,b) separates
// red/orange and white/yellow. Chroma-normalised hue is added so dim orange isn't "red".
const L_WEIGHT = 0.45;
function features(lab) {
  const [L, a, b] = lab;
  const chroma = Math.hypot(a, b);
  // Unit hue vector scaled by a saturating chroma: pushes red/orange apart at any brightness.
  const k = 30 * Math.min(1, chroma / 25) / (chroma || 1);
  return [L_WEIGHT * L, a, b, k * a, k * b];
}
const dist2 = (p, q) => { let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] - q[i]) ** 2; return s; };

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

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];

// samples: { U: [9 rgb], ... } → { facelets, confidence[54] }. Each letter is the face
// whose center the sticker matches; every letter gets exactly 9 stickers.
export function classifyFaces(samples) {
  const feats = FACE_ORDER.map((f) => samples[f].map((s) => features(rgbToLab(s))));
  const centerF = feats.map((fs) => fs[4]);
  let cents = centerF.map((c) => c.slice());
  const dim = cents[0].length;
  const items = []; // non-center stickers
  feats.forEach((fs, f) => fs.forEach((x, i) => { if (i !== 4) items.push({ f, i, x }); }));

  let cost;
  const assign = () => {
    cost = items.map((it) => cents.map((c) => dist2(it.x, c)));
    // 6 colors × 8 slots each (centers already hold the 9th).
    const wide = cost.map((row) => row.flatMap((d) => new Array(8).fill(d)));
    const cols = hungarian(wide);
    items.forEach((it, k) => { it.c = Math.floor(cols[k] / 8); });
  };
  assign();
  // K-means style refinement: centroids from centers + assigned stickers, then reassign.
  for (let pass = 0; pass < 2; pass++) {
    cents = cents.map((_, c) => {
      const mem = items.filter((it) => it.c === c).map((it) => it.x).concat([centerF[c]]);
      return Array.from({ length: dim }, (_, d) => mem.reduce((s, x) => s + x[d], 0) / mem.length);
    });
    assign();
  }

  const chars = new Array(54);
  const confidence = new Array(54).fill(1);
  FACE_ORDER.forEach((f, fi) => { chars[fi * 9 + 4] = f; });
  items.forEach((it, k) => {
    const idx = FACE_ORDER.indexOf(FACE_ORDER[it.f]) * 9 + it.i;
    chars[idx] = FACE_ORDER[it.c];
    const d = cost[k].map(Math.sqrt);
    const mine = d[it.c];
    const other = Math.min(...d.filter((_, c) => c !== it.c));
    confidence[idx] = Math.max(0, Math.min(1, (other - mine) / (other + mine || 1)));
  });
  return { facelets: chars.join(''), confidence };
}

// ---- Camera (DOM) ----------------------------------------------------------------

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const GUIDE_FRAC = 0.6;  // guide square side, as a fraction of the shorter video side
const PATCH_FRAC = 0.4;  // sampled patch side, as a fraction of a cell (stay off the black borders)

export class CameraScanner {
  constructor({ video, overlay }) {
    this.video = video;
    this.overlay = overlay;
    this.stream = null;
    this.live = new Array(9).fill(null);
    this._raf = 0;
    this._lastSample = 0;
    this._work = null;
  }

  async start() {
    if (!window.isSecureContext) throw new Error('The camera needs a secure page. Open this app over https (or localhost).');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access. Try a recent Chrome, Safari or Firefox.');
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
      } catch (e) {
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
        this.stream = await navigator.mediaDevices.getUserMedia({ video: size, audio: false }); // any camera
      }
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw new Error('Camera permission was denied. Allow camera access in your browser settings and try again.');
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') throw new Error('No camera found on this device. You can enter the colors by hand instead.');
      if (e.name === 'NotReadableError') throw new Error('The camera is busy. Close other apps using it and try again.');
      throw new Error(`Could not start the camera (${e.message || e.name}).`);
    }
    const v = this.video;
    v.setAttribute('playsinline', '');
    v.playsInline = true;
    v.muted = true;
    v.srcObject = this.stream;
    await v.play();
    // The preview is deliberately not mirrored, so what you see is the true orientation
    // of the cube and sample() needs no flip.
    this._loop();
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  // Guide square in intrinsic video pixels.
  _guide() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const side = GUIDE_FRAC * Math.min(vw, vh);
    return { x: (vw - side) / 2, y: (vh - side) / 2, side };
  }

  // Map intrinsic video coords to displayed CSS px, honoring object-fit.
  _mapping() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const cw = this.video.clientWidth, ch = this.video.clientHeight;
    const fit = getComputedStyle(this.video).objectFit;
    const scale = fit === 'contain' ? Math.min(cw / vw, ch / vh) : fit === 'fill' ? null : Math.max(cw / vw, ch / vh);
    if (scale === null) return { sx: cw / vw, sy: ch / vh, ox: 0, oy: 0 };
    return { sx: scale, sy: scale, ox: (cw - vw * scale) / 2, oy: (ch - vh * scale) / 2 };
  }

  // Median RGB of the patch in each cell, row-major, from the raw frame.
  _readCells() {
    const { x, y, side } = this._guide();
    const S = Math.round(side);
    if (!this._work) {
      this._work = document.createElement('canvas');
      this._ctx = this._work.getContext('2d', { willReadFrequently: true });
    }
    this._work.width = S; this._work.height = S;
    this._ctx.drawImage(this.video, x, y, side, side, 0, 0, S, S); // unmirrored source pixels
    const cell = S / 3, p = Math.max(2, Math.round(cell * PATCH_FRAC));
    const out = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const px = Math.round(c * cell + (cell - p) / 2), py = Math.round(r * cell + (cell - p) / 2);
        const d = this._ctx.getImageData(px, py, p, p).data;
        const R = [], G = [], B = [];
        for (let i = 0; i < d.length; i += 4) { R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); }
        out.push({ r: median(R), g: median(G), b: median(B) });
      }
    }
    return out;
  }

  sample() {
    if (!this.video.videoWidth) throw new Error('The camera is not ready yet.');
    return this._readCells();
  }

  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    if (!this.video.videoWidth) return;
    const now = performance.now();
    if (now - this._lastSample > 120) { this._lastSample = now; this.live = this._readCells(); }
    this._draw();
  };

  _draw() {
    const cv = this.overlay;
    const cw = this.video.clientWidth, ch = this.video.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const { x, y, side } = this._guide();
    const m = this._mapping();
    const cell = side / 3, gap = cell * 0.06, rad = cell * 0.14;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const X = m.ox + (x + c * cell + gap) * m.sx, Y = m.oy + (y + r * cell + gap) * m.sy;
        const W = (cell - 2 * gap) * m.sx, H = (cell - 2 * gap) * m.sy;
        ctx.beginPath();
        ctx.roundRect(X, Y, W, H, rad * m.sx);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        const s = this.live[r * 3 + c];
        if (s) { // what the camera reads, as a dot in the cell center
          ctx.beginPath();
          ctx.arc(X + W / 2, Y + H / 2, Math.min(W, H) * 0.16, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.stroke();
        }
      }
    }
  }
}
