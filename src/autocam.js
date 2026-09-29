// Camera side of the auto-capture scan (the only DOM part): runs detectFace on the live video,
// draws what it sees on the overlay, and reports faces that were held steady long enough.
// The camera stream, its friendly errors and stop() come from CameraScanner; this class replaces
// its fixed-guide loop with detection.
import { CameraScanner } from './scanner.js';
import { detectFace, gridPoint, sampleFace } from './detect.js';
import { FaceTracker } from './autoscan.js';

const SEARCH_LONG = 256;      // long side of the frame handed to detectFace (it searches on ~200 px)
const FRAME_MS = 80;          // detection period: about 12 fps
const HI_LONG = 960;          // long side of the one-off full-detail read at capture time
const THUMB = 96;             // thumbnail size in px
const FALLBACK_GUIDE = 0.62;  // manual capture without a detection reads a centered square, as a fraction

const rgbCss = ({ r, g, b }) => `rgb(${r},${g},${b})`;

export class AutoCamera extends CameraScanner {
  // hooks: { onStatus({ phase, progress, det }), onCapture(capture, { manual }) }
  constructor({ video, overlay, hooks = {} }) {
    super({ video, overlay });
    this.hooks = hooks;
    this.tracker = new FaceTracker();
    this.det = null;            // last detection, in coordinates of the visible region scaled to `small`
    this.small = null;          // the small canvas detectFace reads
    this.phase = 'searching';
    this.progress = 0;
    this.flashUntil = 0;
    this._lastDetect = 0;
    this._loop = this._autoLoop;
  }

  // The part of the video the cam-frame box shows (object-fit: cover crops the rest), in video px.
  _visible() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight, cw = v.clientWidth || 1, ch = v.clientHeight || 1;
    const scale = Math.max(cw / vw, ch / vh);
    const sw = cw / scale, sh = ch / scale;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh, cw, ch };
  }

  _grab(canvasKey, long) {
    const r = this._visible();
    const k = long / Math.max(r.sw, r.sh);
    const w = Math.max(16, Math.round(r.sw * k)), h = Math.max(16, Math.round(r.sh * k));
    let c = this[canvasKey];
    if (!c) {
      c = this[canvasKey] = document.createElement('canvas');
      c.ctx = c.getContext('2d', { willReadFrequently: true });
    }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.ctx.imageSmoothingQuality = 'medium';
    c.ctx.drawImage(this.video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
    return { canvas: c, image: c.ctx.getImageData(0, 0, w, h), region: r, k };
  }

  _autoLoop = () => {
    this._raf = requestAnimationFrame(this._loop);
    if (!this.video.videoWidth) return;
    const now = performance.now();
    if (now - this._lastDetect >= FRAME_MS) {
      this._lastDetect = now;
      this._detect(now);
    }
    this._paint(now);
  };

  _detect(now) {
    let det;
    try {
      const { image } = this._grab('small', SEARCH_LONG);
      det = detectFace(image, { prev: this.det });
    } catch (e) {
      console.warn('face detection failed', e);
      return;
    }
    this.det = det.found ? det : null;
    const r = this.tracker.update(det, now);
    this.phase = r.phase;
    this.progress = r.progress;
    this.hooks.onStatus?.({ phase: r.phase, progress: r.progress, det: this.det });
    if (r.capture) this._deliver(r.capture, false);
  }

  // A capture from the tracker (or the manual button): sharpen it with a full-detail read of the
  // same spot, add a thumbnail, and hand it to the app.
  _deliver(capture, manual) {
    const det = capture.det;
    try { this._sharpen(capture, det); } catch (e) { console.warn('full-detail read failed', e); }
    capture.thumb = this._thumbnail(det);
    this.flashUntil = performance.now() + 350;
    navigator.vibrate?.(40);
    this.hooks.onCapture?.(capture, { manual });
  }

  // Re-read the stickers from a bigger copy of the current frame (less blur and averaging than the
  // 256 px search image). Kept only if it agrees with the steady reading and the face is still there.
  _sharpen(capture, det) {
    const hi = this._grab('big', HI_LONG);
    const scale = hi.canvas.width / this.small.width;
    const prev = { ...det, x: det.x * scale, y: det.y * scale, size: det.size * scale };
    const d = detectFace(hi.image, { prev });
    if (!d.found || d.score < 0.8 * det.score) return;
    const far = (p, q) => Math.hypot(p.r - q.r, p.g - q.g, p.b - q.b) > 60;
    if (d.cells.some((c, i) => i !== 4 && far(c, capture.cells[i])) || far(d.centerRing, capture.centerRing)) return;
    capture.cells = d.cells;
    capture.centerRing = d.centerRing;
    capture.sharp = true;
  }

  // A small upright picture of the face, cut from the live video (the grid is turned to stand straight).
  _thumbnail(det) {
    const c = document.createElement('canvas');
    c.width = c.height = THUMB;
    const ctx = c.getContext('2d');
    const region = this._visible();
    const s = region.sw / this.small.width; // video px per small-canvas px
    const cx = region.sx + (det.x + det.size / 2) * s, cy = region.sy + (det.y + det.size / 2) * s;
    const size = det.size * s * 1.12;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, THUMB, THUMB);
    ctx.translate(THUMB / 2, THUMB / 2);
    ctx.rotate(-det.angle * Math.PI / 180);
    ctx.scale(THUMB / size, THUMB / size);
    ctx.drawImage(this.video, -cx, -cy);
    return c.toDataURL('image/jpeg', 0.7);
  }

  // Manual "Capture" button: the current detection if there is one, otherwise the old fixed
  // centered square, so a stubborn frame can still be read by hand.
  captureNow() {
    if (!this.video.videoWidth) throw new Error('The camera is not ready yet.');
    const { image } = this._grab('small', SEARCH_LONG);
    let det = this.det;
    if (!det) {
      const w = image.width, h = image.height, side = FALLBACK_GUIDE * Math.min(w, h);
      det = { found: true, x: (w - side) / 2, y: (h - side) / 2, size: side, angle: 0, score: 0.5 };
    }
    // Fresh read of the chosen square (the live detection may be a frame old).
    const { cells, centerRing } = sampleFace(image, det);
    const capture = { det, cells, centerRing, quality: 0.5, jitter: 0, t: performance.now(), frames: 1, manual: true };
    this._deliver(capture, true);
    return capture;
  }

  // ---- Overlay ---------------------------------------------------------------------

  _paint(now) {
    const cv = this.overlay;
    const r = this._visible();
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.cw * dpr) || cv.height !== Math.round(r.ch * dpr)) {
      cv.width = Math.round(r.cw * dpr); cv.height = Math.round(r.ch * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.cw, r.ch);
    const det = this.det;
    if (!det || !this.small) {
      // Nothing found yet: a faint guide square shows where the manual button would read.
      const side = FALLBACK_GUIDE * Math.min(r.cw, r.ch);
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.roundRect((r.cw - side) / 2, (r.ch - side) / 2, side, side, 14);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    const kx = r.cw / this.small.width, ky = r.ch / this.small.height;
    const holding = this.phase === 'holding' || this.phase === 'held';
    const good = this.phase === 'held' || this.phase === 'captured' || now < this.flashUntil;
    const pt = (u, v) => { const [x, y] = gridPoint(det, u, v); return [x * kx, y * ky]; };
    const cellPath = (i, j, inset) => {
      const a = pt((j + inset) / 3, (i + inset) / 3), b = pt((j + 1 - inset) / 3, (i + inset) / 3);
      const c = pt((j + 1 - inset) / 3, (i + 1 - inset) / 3), d = pt((j + inset) / 3, (i + 1 - inset) / 3);
      ctx.beginPath();
      ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath();
    };
    // Each cell shows what the camera reads (the center shows its ring color, not the logo).
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const col = i === 1 && j === 1 ? det.centerRing : det.cells[i * 3 + j];
        cellPath(i, j, 0.16);
        ctx.fillStyle = rgbCss(col);
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();
      }
    }
    // Outline: white while looking, filling green as the hold completes.
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = good ? '#22c55e' : 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    const [p0, p1, p2, p3] = [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)];
    ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...p3); ctx.closePath();
    ctx.stroke();
    if (holding && !good && this.progress > 0) {
      ctx.strokeStyle = '#22c55e';
      const pts = [p0, p1, p2, p3, p0];
      const lens = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
      let left = this.progress * lens.reduce((a, b) => a + b, 0);
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      for (let k = 0; k < 4 && left > 0; k++) {
        const f = Math.min(1, left / lens[k]);
        ctx.lineTo(pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f);
        left -= lens[k];
      }
      ctx.stroke();
    }
  }
}
