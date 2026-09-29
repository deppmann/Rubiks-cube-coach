// Camera capture + sticker color classification.
// classifyFaces is pure (no DOM) so it runs in Node tests; CameraScanner is the only part
// that touches the browser.

import { classifyStickers, rgbToLab } from './colors.js';
import { validate } from './cube.js';

export const SCAN_ORDER = [
  { face: 'F', title: 'Green face', instruction: 'Hold the cube with white on the bottom and the green center facing the camera. Line it up with the grid.' },
  { face: 'R', title: 'Orange face', instruction: 'Turn the whole cube to the left so the orange center faces the camera. Keep white on the bottom.' },
  { face: 'B', title: 'Blue face', instruction: 'Turn it the same way again to show the blue center. White stays on the bottom.' },
  { face: 'L', title: 'Red face', instruction: 'One more turn shows the red center. White is still on the bottom.' },
  { face: 'U', title: 'Yellow face', instruction: 'Tip the top toward the camera so yellow faces you. The green side should be at the bottom of the picture.' },
  { face: 'D', title: 'White face', instruction: 'Now tip the cube so white faces you, with the green side at the top of the picture.' },
];

// ---- Color classification (pure) ---------------------------------------------------
// The color math lives in colors.js (white balance, balanced clustering, center elimination);
// rgbToLab stays exported from here for compatibility.

export { rgbToLab };

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];

// samples: { U: [9 rgb], ... } (each face upright, as scanned in SCAN_ORDER) → { facelets,
// confidence[54] }. Each letter is the face whose center the sticker matches; every letter
// gets exactly 9 stickers. Centers are inferred, not trusted, so a logo on a center cap or a
// warm cast does not corrupt the result. Extra: `names`/`centers` (color names, U R F D L B order).
export function classifyFaces(samples, { centerRings } = {}) {
  const res = classifyStickers(FACE_ORDER.map((f) => samples?.[f]), { centerRings });
  const build = (centers) => {
    const letterOf = Object.fromEntries(centers.map((c, i) => [c, FACE_ORDER[i]]));
    return res.names.map((face, i) => face.map((c, j) => letterOf[j === 4 ? centers[i] : c] ?? '?').join('')).join('');
  };
  // Faces are in a known order here, so when two centers look alike (a logo, glare) the
  // cube's own structure tells which reading is real: first candidate that validates wins.
  let centers = res.centers, facelets = build(centers);
  if (!validate(facelets).ok) {
    for (const alt of res.centerAlternatives) {
      const f = build(alt);
      if (validate(f).ok) { centers = alt; facelets = f; break; }
    }
  }
  return { facelets, confidence: res.confidence.flat(), names: res.names.map((n, i) => n.map((c, j) => (j === 4 ? centers[i] : c))), centers };
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
