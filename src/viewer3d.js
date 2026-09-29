// Three.js cube viewer: animated moves, hint arrows, piece highlighting.
// Pure math helpers are exported (and unit-tested in Node); everything that touches the
// DOM/WebGL lives inside CubeViewer, so importing this file in Node is safe.
// Cube logic always comes from cube.js: after every animated turn we snap the logical
// state to applyMove() and recolor, so the display can never drift from the model.
import * as THREE from '../vendor/three.module.min.js';
import { COLOR_OF, STICKERS, SOLVED, applyMove, moveInfo, parseMoves } from './cube.js';

export const STICKER_HEX = {
  white: '#ffffff', yellow: '#ffd500', green: '#009b48', blue: '#0046ad', red: '#b71234', orange: '#ff5800',
};

// ---- Pure helpers ----------------------------------------------------------------

const DEFAULT_THETA = (35 * Math.PI) / 180;  // azimuth from +z toward +x: front-right
export const SPACING = 1;            // distance between cubie centers
export const CUBIE = 0.94;           // cubie edge length (the rest is the visible gap)
export const HALF = CUBIE / 2;       // center-to-face distance of a cubie
const FALLBACK_HEX = '#59606d';      // unknown sticker letter (e.g. an unscanned '?')

// Where facelet i sits in cube space and which way it faces.
export function stickerTransform(index, spacing = SPACING, half = HALF) {
  const { pos, normal } = STICKERS[index];
  return { position: pos.map((v, k) => v * spacing + normal[k] * half), normal: [...normal] };
}

export function stickerHex(letter, colorOf = COLOR_OF) {
  return STICKER_HEX[colorOf[letter]] ?? FALLBACK_HEX;
}

export const easeInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Signed rotation angle (radians, right-handed about the move's axis) for a move:
// clockwise seen from the axis tip is -90° per quarter turn (same as cube.js rotateCW).
export function moveAngle(move) {
  return -(Math.PI / 2) * moveInfo(move).turns;
}

// ~300ms per quarter turn, half turns 1.5x, divided by speed.
export function moveDuration(move, speed = 1) {
  const { turns } = moveInfo(move);
  return (300 * (Math.abs(turns) === 2 ? 1.5 : 1)) / Math.max(0.05, speed);
}

const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Rodrigues rotation of v by `angle` about unit axis a.
export function rotateVec(v, a, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), x = vcross(a, v), d = vdot(a, v);
  return v.map((_, k) => v[k] * c + x[k] * s + a[k] * d * (1 - c));
}

// Two unit vectors u, v perpendicular to axis with u × v = axis (so angle grows CCW seen from the tip).
export function perpBasis(axis) {
  const ref = Math.abs(axis[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u0 = vcross(ref, axis);
  const len = Math.hypot(...u0);
  const u = u0.map((k) => k / len);
  return { u, v: vcross(axis, u) };
}

// Parameters of the hint arrow for a move: an arc around the move's axis, floating just
// outside the turning face, travelling the way the layer turns.
export function arcSpec(move) {
  const { turns, axis } = moveInfo(move);
  const double = Math.abs(turns) === 2;
  const sweep = double ? (Math.PI * 5) / 6 : Math.PI / 2;
  // Center the arc on the side facing the default camera so it is seen in full.
  const { u, v } = perpBasis(axis);
  const view = [Math.sin(DEFAULT_THETA), 0.6, Math.cos(DEFAULT_THETA)];
  const mid = Math.atan2(vdot(view, v), vdot(view, u));
  const dir = turns > 0 ? -1 : 1;             // CW seen from the tip = decreasing angle
  // L, D and B face away from the default camera: a small arc behind them is hidden by the
  // cube, so widen it until it wraps around the visible edges of that layer.
  const facesAway = vdot(view, axis) < 0;
  return {
    axis: [...axis],
    center: axis.map((k) => k * 1.85),
    radius: facesAway ? 2.3 : 1.2,
    start: mid - (dir * sweep) / 2,
    dir,
    sweep,
    double,
  };
}

// Points along the arc at parameter t in [0,1], plus the unit tangent there.
export function arcPoint(spec, t) {
  const { u, v } = perpBasis(spec.axis);
  const ang = spec.start + spec.dir * spec.sweep * t;
  const p = spec.center.map((c, k) => c + spec.radius * (u[k] * Math.cos(ang) + v[k] * Math.sin(ang)));
  const tan = u.map((_, k) => spec.dir * (-u[k] * Math.sin(ang) + v[k] * Math.cos(ang)));
  return { point: p, tangent: tan };
}

export function arcPoints(spec, n = 24, tMax = 1) {
  return Array.from({ length: n + 1 }, (_, i) => arcPoint(spec, (i / n) * tMax).point);
}

// Mix a color (0..1 rgb) toward grey by k; used for the dimmed "not this piece" look.
export function dimMix(rgb, grey, k) {
  return rgb.map((c, i) => c + (grey[i] - c) * k);
}

// ---- Viewer ----------------------------------------------------------------------

const DEFAULT_PHI = (28 * Math.PI) / 180;    // elevation: from above
const FOV = 32;
const DIM_STRENGTH = 0.75;                   // dimmed stickers keep ~25% of their color
const DIM_SECONDS = 0.35;
const key3 = (p) => p.join(',');

function roundedRect(shape, w, h, r) {
  const x = -w / 2, y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

export class CubeViewer {
  constructor(container, { colorOf = COLOR_OF } = {}) {
    this.container = container;
    this.colorOf = colorOf;
    this.state = SOLVED;
    this._gen = 0;               // bumped by stop()/setState() to drop queued moves
    this._chain = Promise.resolve();
    this._anim = null;
    this._disposed = false;
    this._hintMove = null;
    this._hint = null;
    this._dirty = true;
    this._dim = new Float32Array(54);
    this._dimTarget = new Float32Array(54);
    this._disposables = [];

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    const canvas = (this.canvas = renderer.domElement);
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' });
    container.appendChild(canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this._buildLights();
    this._buildCube();

    // Orbit state (spherical around the origin) with damping.
    this._theta = DEFAULT_THETA;
    this._phi = DEFAULT_PHI;
    this._radius = 10;
    this._vTheta = 0;
    this._vPhi = 0;
    this._auto = true;
    this._autoT = 0;
    this._tween = null;
    this._dragging = false;

    this._bindEvents();
    this.setState(SOLVED);
    this._resize();
    this._last = performance.now();
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  // -- scene construction

  _buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xffffff, 0x8a90a0, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 7, 6);
    const fill = new THREE.DirectionalLight(0xdde6ff, 0.8);
    fill.position.set(-6, 2, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-2, -5, -6);
    s.add(key, fill, rim);
  }

  _track(o) { this._disposables.push(o); return o; }

  _buildCube() {
    this.cubeGroup = new THREE.Group();
    this.pivot = new THREE.Group();
    this.cubeGroup.add(this.pivot);
    this.scene.add(this.cubeGroup);

    // Body: rounded box via an extruded rounded rectangle with a bevel (no addons needed).
    const bevel = 0.06;
    const inner = CUBIE - 2 * bevel;
    const bodyGeo = this._track(new THREE.ExtrudeGeometry(roundedRect(new THREE.Shape(), inner, inner, 0.05), {
      depth: inner, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4,
    }));
    bodyGeo.translate(0, 0, -inner / 2);
    const bodyMat = this._track(new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.5, metalness: 0.05 }));
    const stickerGeo = this._track(new THREE.ShapeGeometry(roundedRect(new THREE.Shape(), 0.8, 0.8, 0.12), 6));

    this.cubies = [];
    this.cubieAt = new Map();
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
      const g = new THREE.Group();
      g.position.set(x * SPACING, y * SPACING, z * SPACING);
      g.add(new THREE.Mesh(bodyGeo, bodyMat));
      const c = { group: g, home: [x, y, z] };
      this.cubies.push(c);
      this.cubieAt.set(key3(c.home), c);
      this.cubeGroup.add(g);
    }

    this.stickerMeshes = STICKERS.map((s) => {
      const mat = this._track(new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0.35, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25,
      }));
      const mesh = new THREE.Mesh(stickerGeo, mat);
      const t = stickerTransform(s.index);
      // Local to its cubie: normal * (HALF + hair to avoid z-fighting).
      mesh.position.set(...s.normal.map((n) => n * (HALF + 0.004)));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...t.normal));
      this.cubieAt.get(key3(s.pos)).group.add(mesh);
      return mesh;
    });
    this._baseColors = STICKERS.map(() => new THREE.Color());
    this._grey = new THREE.Color('#8b909b');
  }

  // -- events / sizing

  _bindEvents() {
    this._onDown = (e) => {
      if (e.button !== undefined && e.button > 0) return;
      this._dragging = true;
      this._auto = false;
      this._tween = null;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this.canvas.style.cursor = 'grabbing';
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    };
    this._onMove = (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      const k = 0.008;
      this._theta -= dx * k;
      this._phi = Math.max(-1.45, Math.min(1.45, this._phi + dy * k));
      this._vTheta = -dx * k * 60;  // rad/s, carried on release for inertia
      this._vPhi = dy * k * 60;
    };
    this._onUp = (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      this.canvas.style.cursor = 'grab';
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.container);
  }

  _resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit the cube (bounding radius ~2.9 incl. arrows) in the tighter of the two fields of view.
    const vHalf = (FOV * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    this._radius = 3.1 / Math.sin(Math.min(vHalf, hHalf));
    this.camera.updateProjectionMatrix();
    this._dirty = true;
  }

  resetView() {
    this._auto = false;
    this._vTheta = this._vPhi = 0;
    // Take the shortest way round in azimuth.
    const twoPi = Math.PI * 2;
    const dTheta = ((((DEFAULT_THETA - this._theta) % twoPi) + 3 * Math.PI) % twoPi) - Math.PI;
    this._tween = { t: 0, t0: this._theta, p0: this._phi, dTheta, dPhi: DEFAULT_PHI - this._phi };
  }

  // -- public API

  setState(facelets) {
    if (typeof facelets !== 'string' || facelets.length !== 54) throw new Error('viewer needs a 54-char facelet string');
    this.stop();
    this._settle();
    this.state = facelets;
    this._recolor();
  }

  // Animate moves in order; calls queue behind one another. Resolves when finished (or dropped).
  play(moves, { speed = 1, onMove } = {}) {
    const list = parseMoves(moves);
    const gen = this._gen;
    const run = async () => {
      for (let i = 0; i < list.length; i++) {
        if (gen !== this._gen || this._disposed) return;
        // The snap happens inside the turn's finish, synchronously: stop() followed by
        // setState() must leave setState's state, not re-apply this move afterwards.
        await this._turn(list[i], speed, () => {
          this.state = applyMove(this.state, list[i]);  // snap: state is cube.js's, not the animation's
          this._settle();
          this._recolor();
        });
        if (onMove) onMove(list[i], i, this.state);
      }
    };
    const p = this._chain.then(run);
    this._chain = p.catch(() => {});
    return p;
  }

  // Finish the turn in progress instantly and drop everything queued.
  stop() {
    this._gen++;
    if (this._anim) this._anim.finish();
  }

  setHint(move) {
    this._hintMove = move;
    if (this._hint) {
      this.cubeGroup.remove(this._hint.group);
      this._hint.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
      this._hint = null;
    }
    if (move) this._hint = this._buildHint(move);
  }

  setHighlight(indices) {
    const on = indices ? new Set(indices) : null;
    for (let i = 0; i < 54; i++) this._dimTarget[i] = on && !on.has(i) ? 1 : 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      this.canvas.removeEventListener(ev, ev === 'pointerdown' ? this._onDown : ev === 'pointermove' ? this._onMove : this._onUp);
    }
    this.setHint(null);
    this._disposables.forEach((d) => d.dispose());
    this.renderer.dispose();
    this.canvas.remove();
  }

  // -- internals

  _recolor() {
    for (let i = 0; i < 54; i++) this._baseColors[i].set(stickerHex(this.state[i], this.colorOf));
    this._dirty = true;
  }

  _paint() {
    for (let i = 0; i < 54; i++) {
      this.stickerMeshes[i].material.color.copy(this._baseColors[i]).lerp(this._grey, this._dim[i] * DIM_STRENGTH);
    }
  }

  // Put every cubie back at its home slot (colors live on the stickers, driven by state).
  _settle() {
    this.pivot.quaternion.identity();
    for (const c of this.cubies) {
      if (c.group.parent !== this.cubeGroup) this.cubeGroup.add(c.group);
    }
    this._dirty = true;
  }

  _turn(move, speed, commit = () => {}) {
    const info = moveInfo(move);
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { commit(); return Promise.resolve(); }
    // Cubies are always at home between moves, so the layer test uses home positions.
    for (const c of this.cubies) if (info.layer(c.home)) this.pivot.add(c.group);
    const axis = new THREE.Vector3(...info.axis);
    const angle = moveAngle(move);
    return new Promise((resolve) => {
      const anim = {
        t0: performance.now(), dur: moveDuration(move, speed),
        finish: () => {
          this.pivot.quaternion.setFromAxisAngle(axis, angle);
          this._anim = null;
          commit();
          resolve();
        },
        step: (now) => {
          const t = (now - anim.t0) / anim.dur;
          if (t >= 1) return anim.finish();
          this.pivot.quaternion.setFromAxisAngle(axis, angle * easeInOut(t));
        },
      };
      this._anim = anim;
    });
  }

  _buildHint(move) {
    const spec = arcSpec(move);
    const group = new THREE.Group();
    const color = 0x8b5cf6;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false });
    const headLen = 0.34;
    const headAng = headLen / spec.radius / spec.sweep;  // fraction of the arc the head covers
    const pts = arcPoints(spec, 32, 1 - headAng).map((p) => new THREE.Vector3(...p));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.05, 10, false), mat);
    const end = arcPoint(spec, 1), base = arcPoint(spec, 1 - headAng);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.15, headLen, 16), mat);
    head.position.set(...base.point.map((v, k) => (v + end.point[k]) / 2));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...end.tangent).normalize());
    group.add(tube, head);
    const mats = [mat];
    if (spec.double) {
      const label = this._label('2');
      const mid = arcPoint(spec, 0.5).point;
      const out = spec.axis;
      label.position.set(...mid.map((v, k) => v + out[k] * 0.05 + (v - spec.center[k]) * (0.42 / spec.radius)));
      label.scale.set(0.7, 0.7, 1);
      group.add(label);
      mats.push(label.material);
    }
    this.cubeGroup.add(group);
    return { group, mats };
  }

  _label(text) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.font = '700 96px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.strokeText(text, 64, 68);
    g.fillStyle = '#c4b5fd';
    g.fillText(text, 64, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  }

  _tick(now) {
    if (this._disposed) return;
    this._raf = requestAnimationFrame((t) => this._tick(t));
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (this._anim) this._anim.step(now);
    if (!this.container.clientWidth) return; // tab hidden (display: none): don't burn GPU/battery drawing it

    // Orbit: inertia after a drag, gentle sway while idle, or an animated reset.
    if (this._tween) {
      const tw = this._tween;
      tw.t = Math.min(1, tw.t + dt / (reduce ? 0.001 : 0.6));
      const e = easeInOut(tw.t);
      this._theta = tw.t0 + tw.dTheta * e;
      this._phi = tw.p0 + tw.dPhi * e;
      if (tw.t >= 1) { this._tween = null; this._auto = !reduce; this._autoT = 0; this._autoBase = this._theta; }
    } else if (!this._dragging) {
      const damp = Math.exp(-dt * 4);
      this._theta += this._vTheta * dt;
      this._phi = Math.max(-1.45, Math.min(1.45, this._phi + this._vPhi * dt));
      this._vTheta *= damp;
      this._vPhi *= damp;
      if (this._auto && !reduce) {
        // Sway around the default view instead of spinning, so F/R/U stay in sight.
        this._autoT += dt;
        this._theta = DEFAULT_THETA + 0.4 * Math.sin(this._autoT * 0.35);
      }
    }
    const cp = Math.cos(this._phi);
    this.camera.position.set(this._radius * cp * Math.sin(this._theta), this._radius * Math.sin(this._phi), this._radius * cp * Math.cos(this._theta));
    this.camera.lookAt(0, 0, 0);

    // Highlight fade.
    const step = dt / DIM_SECONDS;
    for (let i = 0; i < 54; i++) {
      const d = this._dimTarget[i] - this._dim[i];
      if (d !== 0) {
        this._dim[i] = Math.abs(d) <= step ? this._dimTarget[i] : this._dim[i] + Math.sign(d) * step;
        this._dirty = true;
      }
    }
    if (this._dirty) { this._paint(); this._dirty = false; }

    if (this._hint) {
      const o = reduce ? 0.9 : 0.55 + 0.4 * Math.sin(now / 1000 * 4.2);
      for (const m of this._hint.mats) m.opacity = o;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
