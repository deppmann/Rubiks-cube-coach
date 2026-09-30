// Stylized 3D hands for the coach view: shows how to hold the cube and which hand/finger
// makes each move. Pure helpers (move -> motion table, two-bone IK, flick timing) are exported
// and unit-tested in Node; the Hands class builds three.js meshes and never touches the DOM.
//
// Coordinates are cube space: x -> R, y -> U, z -> F (camera sits front-right-top).
// The right hand is modelled at +x; the left hand is the same model inside a mirror group.
import * as THREE from '../vendor/three.module.min.js';

export const ACCENT_HEX = '#8b5cf6';
const SKIN_HEX = '#efd6c6';        // soft neutral skin tone, idle
const EDGE_HEX = '#6b5560';        // thin outline so the ghosted hands still read
const EDGE_ACTIVE_HEX = '#5b34c9';
const HAND_OPACITY = 0.62;
const OUTLINE = 0.035;
const XRAY_OPACITY = 0.32;          // hand reaching around the back is seen "through" the cube

// ---- Pure helpers ------------------------------------------------------------------

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-z': [0, 0, -1] };
const MOVE_RE = /^([URFDLBMESxyzurfdlb])(2|'|2'|)$/;

// Which hand/finger performs a move and how. Returns
// { kind: 'wrist' | 'flick' | 'none', hand: 'right'|'left'|'both'|null, finger: 'index'|'ring'|null,
//   pose: 'home'|'front'|'top'|'bottom'|'back', axis: [x,y,z]|null, turns: signed quarter turns,
//   count: number of flicks, angle: radians about axis (same sense as the layer turn) }
export function motionFor(move) {
  const m = MOVE_RE.exec(move);
  if (!m) throw new Error(`bad move "${move}"`);
  const base = m[1];
  const turns = m[2] === "'" ? -1 : m[2].startsWith('2') ? 2 : 1;
  const angle = -(Math.PI / 2) * turns;
  const prime = turns < 0;
  const half = Math.abs(turns) === 2;
  const out = (o) => ({ kind: 'none', hand: null, finger: null, pose: 'home', axis: null, turns, count: 1, angle: 0, ...o });
  switch (base) {
    case 'R': return out({ kind: 'wrist', hand: 'right', axis: AXES.x, angle });
    case 'L': return out({ kind: 'wrist', hand: 'left', axis: AXES['-x'], angle });
    case 'F': return out({ kind: 'wrist', hand: prime ? 'left' : 'right', pose: 'front', axis: AXES.z, angle });
    case 'B': return out({ kind: 'wrist', hand: 'right', pose: 'back', axis: AXES['-z'], angle });
    case 'U': return out({ kind: 'flick', hand: prime ? 'left' : 'right', finger: 'index', pose: 'top', count: half ? 2 : 1 });
    case 'D': return out({ kind: 'flick', hand: prime ? 'right' : 'left', finger: 'ring', pose: 'bottom', count: half ? 2 : 1 });
    case 'y': return out({ kind: 'wrist', hand: 'both', axis: AXES.y, angle });
    case 'x': return out({ kind: 'wrist', hand: 'both', axis: AXES.x, angle });
    case 'z': return out({ kind: 'wrist', hand: 'both', axis: AXES.z, angle });
    default: return out({});   // slices and wide turns: hands hold still
  }
}

// Position (0..1) of a fingertip along its outer -> inner path at turn progress t (0..1).
// One flick is a smooth sweep; two flicks sweep, snap back during a short pause, sweep again.
export function flickProgress(t, count = 1) {
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  if (count <= 1) return ease(t);
  const gap = 0.08, w = (1 - gap) / 2;
  if (t < w) return ease(t / w);
  if (t < w + gap) return 1 - ease((t - w) / gap);
  return ease((t - w - gap) / w);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Two-bone IK for a finger: base -> mid -> tip with bone lengths l1, l2, bending toward `pole`.
// Bone lengths are always preserved; if the target is out of reach the finger points straight at it.
export function twoBoneIK(base, target, l1, l2, pole) {
  const to = sub(target, base);
  const dist = len(to);
  const dir = dist > 1e-9 ? mul(to, 1 / dist) : [0, 0, 1];
  const d = Math.min(l1 + l2 - 1e-6, Math.max(Math.abs(l1 - l2) + 1e-6, dist));
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let p = sub(pole, mul(dir, dot(pole, dir)));
  if (len(p) < 1e-6) p = sub([0, 1, 0], mul(dir, dir[1]));
  if (len(p) < 1e-6) p = [1, 0, 0];
  p = norm(p);
  return {
    mid: add(add(base, mul(dir, a)), mul(p, h)),
    tip: add(base, mul(dir, d)),
    reached: dist <= l1 + l2 + 1e-9 && dist >= Math.abs(l1 - l2) - 1e-9,
  };
}

// ---- Hand model (right hand, local frame; +x points away from the cube) -----------------

const PALM = { c: [1.86, -0.2, -0.7], w: 1.25, h: 1.3, t: 0.3 };   // depth(z) x height(y) x thickness(x)
const FINGERS = {
  index:  { k: [1.86, 0.34, -1.3], l: [0.82, 0.68], r: 0.15, wrap: [0.55, 0.7, -1.68] },
  middle: { k: [1.86, 0.06, -1.3], l: [0.86, 0.7], r: 0.155, wrap: [0.55, 0.06, -1.68] },
  ring:   { k: [1.86, -0.22, -1.3], l: [0.8, 0.66], r: 0.148, wrap: [0.55, -0.22, -1.68] },
  pinky:  { k: [1.86, -0.5, -1.3], l: [0.66, 0.54], r: 0.135, wrap: [0.7, -0.5, -1.62] },
};
const THUMB = { k: [1.86, -0.62, -0.15], l: [0.95, 0.8], r: 0.17, wrap: [1.15, -1.15, 1.63] };
const ARM = { from: [1.95, -0.7, -0.12], dir: [0.85, -0.3, 0.45], len: 0.55, r: 0.34 };

// Where the hand root sits for each pose (right-hand frame; mirrored for the left hand).
const POSES = {
  home:   { pos: [0, 0, 0], yaw: 0 },
  front:  { pos: [0, 0.25, 0.0], yaw: 0 },
  top:    { pos: [-0.11, 0.66, 1.78], yaw: 0 },
  bottom: { pos: [-0.11, -0.78, 1.78], yaw: 0 },
  back:   { pos: [0.8, 0.0, 0.0], yaw: Math.PI / 2 },
};
// A finger not doing the work hangs relaxed instead of wrapping around the back.
const relaxedTip = (f) => [f.k[0] + 0.05, f.k[1] - 0.35, f.k[2] - 0.3];   // curled into a loose fist
const relaxedThumb = (f) => [f.k[0] + 0.3, f.k[1] + 0.5, f.k[2] - 0.05];

const FLICK = { x0: 1.2, x1: 0.2, z: 1.63, y: { index: 1.0, ring: -1.0 } };

const smooth = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Hands {
  constructor() {
    this.group = new THREE.Group();
    this._mats = [];
    this._geos = [];
    this.hands = {
      right: this._buildHand(1, 'right'),
      left: this._buildHand(-1, 'left'),
    };
    this.group.add(this.hands.left.wrist, this.hands.right.wrist);
    this._accent = new THREE.Color(ACCENT_HEX);
    this._accentDeep = new THREE.Color(EDGE_ACTIVE_HEX);
    this._skin = new THREE.Color(SKIN_HEX);
    this._turn = null;       // { move, t } while a layer turn is animating
    this._instant = false;
    this.visible = true;
    this.apply();
  }

  _edgeMat() {
    const m = new THREE.MeshBasicMaterial({ color: EDGE_HEX, side: THREE.BackSide });
    this._mats.push(m);
    return m;
  }

  _mat(opacity, prepass = false) {
    const m = prepass
      ? new THREE.MeshBasicMaterial({ colorWrite: false })
      : new THREE.MeshStandardMaterial({
        color: SKIN_HEX, roughness: 0.75, metalness: 0, transparent: true, opacity, emissive: SKIN_HEX, emissiveIntensity: 0.1,
      });
    this._mats.push(m);
    return m;
  }

  // One capsule (visible pass + depth-only pass so overlapping parts do not double-blend).
  _bone(parent, radius, length, mat, edge) {
    const geo = new THREE.CapsuleGeometry(radius, length, 4, 10);
    const hull = new THREE.CapsuleGeometry(radius + OUTLINE, length, 4, 10);
    return this._shape(parent, geo, mat, edge, hull);
  }

  // Visible pass + depth-only pass (so overlapping parts do not double-blend) + a back-face hull
  // that only shows outside the silhouette as a thin outline.
  _shape(parent, geo, mat, edge, hull = null) {
    this._geos.push(geo);
    const g = new THREE.Group();
    const pre = new THREE.Mesh(geo, this._preMat ||= this._mat(0, true));
    const vis = new THREE.Mesh(geo, mat);
    pre.renderOrder = 1; vis.renderOrder = 3;
    g.add(pre, vis);
    if (!hull) {
      geo.computeBoundingBox();
      const size = new THREE.Vector3(); geo.boundingBox.getSize(size);
      hull = geo.clone();
      hull.scale(1 + 2 * OUTLINE / size.x, 1 + 2 * OUTLINE / size.y, 1 + 2 * OUTLINE / size.z);
    }
    this._geos.push(hull);
    const out = new THREE.Mesh(hull, edge);
    out.renderOrder = 2;
    g.add(out);
    g.userData.outline = out;
    parent.add(g);
    return g;
  }

  _buildHand(side, name) {
    const wrist = new THREE.Group();     // world-axis turn about the cube center (wrist rotation)
    const mirror = new THREE.Group();    // x mirror for the left hand
    mirror.scale.x = side;
    const root = new THREE.Group();      // pose: hand moves to another grip
    wrist.add(mirror); mirror.add(root);
    const skin = this._mat(HAND_OPACITY);
    const edge = this._edgeMat();
    const hand = { side, name, wrist, mirror, root, skin, edge, fingers: {}, grip: 0, s: 0, angle: 0, motion: null, axis: [1, 0, 0], active: 0 };

    // Palm: rounded slab, thin along x.
    const shape = new THREE.Shape();
    const w = PALM.w, h = PALM.h, r = 0.3, x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y); shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
    const inner = PALM.t - 0.12;
    const palmGeo = new THREE.ExtrudeGeometry(shape, { depth: inner, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 6 });
    palmGeo.translate(0, 0, -inner / 2);
    palmGeo.rotateY(Math.PI / 2);        // shape x -> z (depth), extrusion -> x (thickness)
    const palm = this._shape(root, palmGeo, skin, edge);
    hand.palmG = palm;
    palm.position.set(...PALM.c);

    // Forearm stub, tilted toward the player.
    const arm = this._bone(root, ARM.r, ARM.len, skin, edge);
    const ad = norm(ARM.dir);
    hand.armG = arm;
    arm.position.set(...add(ARM.from, mul(ad, ARM.len / 2)));
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...ad));

    const build = (name, spec) => {
      // Each finger has its own material so the active one can glow accent.
      const mat = this._mat(HAND_OPACITY);
      const fe = this._edgeMat();
      const b1 = this._bone(root, spec.r, spec.l[0], mat, fe);
      const b2 = this._bone(root, spec.r * 0.92, spec.l[1], mat, fe);
      hand.fingers[name] = { spec, mat, edge: fe, b1, b2, tint: 0 };
    };
    for (const [n, s] of Object.entries(FINGERS)) build(n, s);
    build('thumb', THUMB);
    return hand;
  }

  // ---- control

  // Move `name`'s hands toward the grip for `move` (null: back to the home grip).
  prepare(move) {
    const m = move ? motionFor(move) : null;
    for (const h of Object.values(this.hands)) {
      const involved = !!m && m.kind !== 'none' && (m.hand === 'both' || m.hand === h.name);
      h.want = involved ? 1 : 0;
      if (involved) { h.motion = m; h.axis = m.axis || h.axis; }
    }
    if (this._instant) this.apply(true);
  }

  begin(move) {
    this._instant = false;
    this._turn = { move, t: 0, m: motionFor(move) };
    this.prepare(move);
  }

  // t in 0..1 (linear); the layer's easing is applied here so the wrist matches the cube.
  setTurn(t) { if (this._turn) this._turn.t = t; }

  end() {
    if (this._turn) {
      this._turn.t = 1;
      this._settleTurn();
      this._turn = null;
    }
    this.prepare(null);
  }

  // Reduced motion: show the grip statically (no wrist turn), snapping in and out.
  hold(move) {
    this._instant = true;
    this._turn = null;
    this.prepare(move);
    for (const h of Object.values(this.hands)) { h.angle = 0; h.s = 0; }
    this.apply(true);
  }

  release() {
    this._instant = true;
    this._turn = null;
    this.prepare(null);
    this.apply(true);
    this._instant = false;
  }

  setInstant(v) { this._instant = !!v; }

  _settleTurn() {
    const { m, t } = this._turn;
    for (const h of Object.values(this.hands)) {
      if (h.motion !== m || !(h.want > 0)) continue;
      this._pose(h, m, t);
    }
  }

  // Wrist angle / fingertip position for turn progress t.
  _pose(h, m, t) {
    const e = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    if (m.kind === 'wrist') h.angle = m.angle * e;
    if (m.kind === 'flick') h.s = flickProgress(t, m.count);
  }

  update(dt) {
    if (this._turn && !this._instant) {
      const { m, t } = this._turn;
      for (const h of Object.values(this.hands)) if (h.motion === m && h.want > 0) this._pose(h, m, t);
    }
    const k = smooth(14, dt), kd = smooth(9, dt);
    for (const h of Object.values(this.hands)) {
      h.grip += ((h.want || 0) - h.grip) * k;
      if (!(h.want > 0) || !this._turn) {
        // After the turn (or when not in one) the wrist and finger relax back.
        h.angle *= 1 - kd;
        h.s *= 1 - kd;
        if (Math.abs(h.angle) < 1e-3) h.angle = 0;
      }
    }
    this.apply();
  }

  // Lay the hand models out for the current state.
  apply(snap = false) {
    for (const h of Object.values(this.hands)) {
      if (snap) h.grip = h.want || 0;
      this._layout(h);
    }
    this.group.updateMatrixWorld(true);
    for (const h of Object.values(this.hands)) this._fingers(h);
  }

  _layout(h) {
    const m = h.motion;
    const g = h.grip;
    const pose = POSES[m ? m.pose : 'home'];
    h.wrist.quaternion.setFromAxisAngle(new THREE.Vector3(...h.axis), h.angle);
    // During a flick the whole hand travels part of the way with the fingertip.
    const sweep = m && m.kind === 'flick' ? (FLICK.x1 - FLICK.x0) * 0.55 * h.s : 0;
    h.root.position.set((pose.pos[0] + sweep) * g, pose.pos[1] * g, pose.pos[2] * g);
    h.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw * g);
    // Palm/forearm tint: the working hand glows a little, the working finger a lot.
    const act = m && m.kind !== 'none' ? g : 0;
    h.active = act;
    const behind = m && m.pose === 'back' ? g : 0;
    const op = HAND_OPACITY * (1 - behind) + XRAY_OPACITY * behind;
    h.skin.color.copy(this._skin).lerp(this._accent, act * (m && m.kind === 'wrist' ? 0.7 : 0.08));
    h.skin.emissive.copy(h.skin.color);
    h.skin.opacity = op;
    h.skin.depthTest = behind < 0.5;
    h.behind = behind;
    h.edge.color.set(EDGE_HEX).lerp(this._accentDeep, act * (m && m.kind === 'wrist' ? 0.9 : 0.1));
    for (const o of [h.palmG, h.armG]) if (o) o.userData.outline.visible = behind < 0.5;
  }

  _fingers(h) {
    const m = h.motion;
    const g = h.grip;
    const pose = m ? m.pose : 'home';
    const relax = pose === 'home' ? 0 : g;
    const world = new THREE.Vector3();
    for (const [name, f] of Object.entries(h.fingers)) {
      const spec = f.spec;
      const isThumb = name === 'thumb';
      const home = spec.wrap;
      const rest = isThumb ? relaxedThumb(spec) : relaxedTip(spec);
      let tip = home.map((v, i) => v + (rest[i] - v) * relax);
      let tint = 0;
      if (m && m.kind === 'flick' && name === m.finger) {
        const y = FLICK.y[name], sx = h.side, x = FLICK.x0 + (FLICK.x1 - FLICK.x0) * h.s;
        world.set(x * sx, y, FLICK.z);
        h.root.worldToLocal(world);
        tip = tip.map((v, i) => v + ([world.x, world.y, world.z][i] - v) * g);
        tint = g;
      }
      if (m && m.kind === 'wrist' && m.pose === 'front' && isThumb && g > 0) {
        // Front regrip: the thumb steps up onto the front face of the turning layer.
        const up = [1.15, 0.0, 1.63];
        tip = tip.map((v, i) => v + (up[i] - v) * g);
      }
      const wrapPole = isThumb ? [1, 0.2, 0.2] : [1, 0.15, 0];
      const curlPole = isThumb ? [1, 0.4, 0] : [0.2, 0.1, -1];
      const pole = wrapPole.map((v, i) => v + (curlPole[i] - v) * relax);
      const ik = twoBoneIK(spec.k, tip, spec.l[0], spec.l[1], pole);
      this._place(f.b1, spec.k, ik.mid);
      this._place(f.b2, ik.mid, ik.tip);
      f.tint += (tint - f.tint) * 0.5;
      f.mat.color.copy(h.skin.color).lerp(this._accent, f.tint);
      f.mat.emissive.copy(f.mat.color);
      f.mat.opacity = h.skin.opacity;
      f.mat.depthTest = h.skin.depthTest;
      f.edge.color.copy(h.edge.color).lerp(this._accentDeep, f.tint);
      f.b1.userData.outline.visible = f.b2.userData.outline.visible = h.behind < 0.5;
    }
  }

  _place(g, a, b) {
    const d = sub(b, a);
    g.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...norm(d)));
  }

  setVisible(v) { this.visible = !!v; this.group.visible = this.visible; }

  dispose() {
    this._geos.forEach((g) => g.dispose());
    this._mats.forEach((m) => m.dispose());
  }
}
