// Camera checkpoints while coaching. Pure and DOM-free, so the logic runs in Node tests.
//
// While the beginner follows a step, one camera glance at the face pointing at the lens (the
// F face of the step's expected state, held white-bottom / green-front) is enough to tell
// whether they did the moves right, are part way through, or made a slip.
//
//   paletteFromScan(...)        the user's own six sticker colors (Lab), learned from the scan
//   classifyWithPalette(...)    9 sticker RGBs → color names + confidence, using that palette
//                               (or a reference palette with per-frame white balance)
//   expectedFront(facelets)     the 9 colors the camera should see
//   diagnose(before, moves, observed) → ok | partial | mistake | unknown, with a plain-English
//                               message and, for a mistake, the moves that get back on the plan

import {
  COLOR_OF, applyMove, applyMoves, invertMoves, invertMove, moveInfo, parseMoves, simplifyMoves,
} from './cube.js';
import { rgbToLab, COLOR_NAMES } from './colors.js';

// ---- Expected faces ------------------------------------------------------------------------

const FACE_START = { U: 0, R: 9, F: 18, D: 27, L: 36, B: 45 };

// The 9 color names of one face, row-major as cube.js reads it (front: seen from the front, U on top).
export function expectedFace(facelets, face, colorOf = COLOR_OF) {
  const s = FACE_START[face];
  return Array.from({ length: 9 }, (_, i) => colorOf[facelets[s + i]]);
}
export const expectedFront = (facelets, colorOf = COLOR_OF) => expectedFace(facelets, 'F', colorOf);
export const expectedTop = (facelets, colorOf = COLOR_OF) => expectedFace(facelets, 'U', colorOf);

// ---- Palette -------------------------------------------------------------------------------

// Lightness counts half as much as chroma: shadows and exposure move L a lot, hue barely.
const L_WEIGHT = 0.5;
const labDist = (p, q) => Math.hypot(L_WEIGHT * (p[0] - q[0]), p[1] - q[1], p[2] - q[2]);
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const labMedian = (list) => [0, 1, 2].map((k) => median(list.map((l) => l[k])));
const chromaOf = (l) => Math.hypot(l[1], l[2]);

// Typical stickers under neutral light: the fallback when the user has not scanned this cube.
const REFERENCE_RGB = {
  white: { r: 232, g: 234, b: 238 }, yellow: { r: 244, g: 212, b: 24 }, green: { r: 12, g: 152, b: 72 },
  blue: { r: 16, g: 74, b: 174 }, red: { r: 188, g: 26, b: 44 }, orange: { r: 248, g: 106, b: 22 },
};
export const REFERENCE_PALETTE = {
  version: 1, source: 'reference',
  lab: Object.fromEntries(COLOR_NAMES.map((n) => [n, rgbToLab(REFERENCE_RGB[n])])),
};

const validRgb = (c) => c && [c.r, c.g, c.b].every((v) => Number.isFinite(+v) && v !== null && v !== '');
const toLab = (c) => rgbToLab({ r: Math.max(0, Math.min(255, +c.r)), g: Math.max(0, Math.min(255, +c.g)), b: Math.max(0, Math.min(255, +c.b)) });

function minSeparation(lab) {
  let m = Infinity;
  for (let i = 0; i < COLOR_NAMES.length; i++) {
    for (let j = i + 1; j < COLOR_NAMES.length; j++) m = Math.min(m, labDist(lab[COLOR_NAMES[i]], lab[COLOR_NAMES[j]]));
  }
  return m;
}

// The user's own colors, from a finished scan. Either
//   paletteFromScan(captures, names, confidence?)     captures: [{ cells: 9 rgb, centerRing }], names[6][9]
//   paletteFromScan({ faces, names, rings?, confidence? })
// `names[f][i]` is the color name buildCube()/classifyStickers() gave sticker i of capture f.
// Center caps are read from their ring (the cap itself may carry a logo). Stickers the classifier
// was unsure of are left out. → a small JSON-safe object, or null when the scan cannot supply all
// six colors distinctly.
export function paletteFromScan(captures, names, confidence, { minConfidence = 0.2 } = {}) {
  let faces, rings;
  if (Array.isArray(captures)) {
    faces = captures.map((c) => c.cells);
    rings = captures.map((c) => c.centerRing);
  } else if (captures && typeof captures === 'object') {
    ({ faces, rings, names, confidence } = captures);
  }
  if (!Array.isArray(faces) || !Array.isArray(names)) return null;
  const conf = (f, i) => {
    if (!confidence) return 1;
    const c = Array.isArray(confidence[f]) ? confidence[f][i] : confidence[f * 9 + i];
    return c ?? 1;
  };
  const samples = Object.fromEntries(COLOR_NAMES.map((n) => [n, []]));
  faces.forEach((face, f) => {
    for (let i = 0; i < 9; i++) {
      const name = names[f]?.[i];
      if (!samples[name]) continue;
      const rgb = i === 4 ? rings?.[f] : face?.[i];
      if (!validRgb(rgb) || conf(f, i) < minConfidence) continue;
      samples[name].push(toLab(rgb));
    }
  });
  const lab = {}, spread = {}, count = {};
  for (const n of COLOR_NAMES) {
    if (samples[n].length < 3) return null;
    lab[n] = labMedian(samples[n]);
    spread[n] = median(samples[n].map((l) => labDist(l, lab[n])));
    count[n] = samples[n].length;
  }
  if (minSeparation(lab) < 12) return null;
  return { version: 1, source: 'scan', lab, spread, count };
}

// A palette read back from storage (or anything else) is trusted only if it is complete.
export function validPalette(p) {
  if (!p || p.version !== 1 || !p.lab) return null;
  for (const n of COLOR_NAMES) {
    const l = p.lab[n];
    if (!Array.isArray(l) || l.length !== 3 || !l.every(Number.isFinite)) return null;
  }
  return minSeparation(p.lab) >= 12 ? p : null;
}

function nearest(lab, pal) {
  const d = COLOR_NAMES.map((n) => labDist(lab, pal[n]));
  let i1 = 0;
  d.forEach((v, i) => { if (v < d[i1]) i1 = i; });
  let d2 = Infinity;
  d.forEach((v, i) => { if (i !== i1 && v < d2) d2 = v; });
  return { name: COLOR_NAMES[i1], d1: d[i1], d2 };
}

const marginOf = (d1, d2) => clamp01((d2 - d1) / (d2 + d1 || 1));

// rgb9: the 9 stickers of one face, row-major as seen (detectFace().cells). opts.centerRing: the ring
// around the center cap (the cap itself can be a logo). The ring is the one sticker whose color we
// almost know, so it anchors the frame: any lighting shift between the scan and now is measured on
// it and removed from all nine stickers. Without a scanned palette the reference palette is used and
// the anchor must be white (the lowest-chroma sticker or the ring), which gives a per-frame white balance.
// → { names[9], confidence[9] (0..1), source: 'scan' | 'reference', anchored: boolean }
export function classifyWithPalette(rgb9, palette, { centerRing } = {}) {
  const scanned = validPalette(palette);
  const pal = scanned ? scanned.lab : REFERENCE_PALETTE.lab;
  const cells = Array.from({ length: 9 }, (_, i) => rgb9?.[i]);
  const ok = cells.map(validRgb);
  const labs = cells.map((c, i) => (ok[i] ? toLab(c) : [50, 0, 0]));
  const ringLab = validRgb(centerRing) ? toLab(centerRing) : null;

  // Anchor: a sticker of known color under today's light.
  let shift = [0, 0, 0], anchored = false;
  const applyAnchor = (lab, name, w) => {
    shift = [0, 1, 2].map((k) => (pal[name][k] - lab[k]) * w[k]);
    anchored = true;
  };
  const wScan = [0.7, 0.85, 0.85];
  if (ringLab) {
    const r = nearest(ringLab, pal);
    const trusted = r.d1 < 45 && marginOf(r.d1, r.d2) > 0.15;
    if (trusted && (scanned || r.name === 'white')) applyAnchor(ringLab, r.name, scanned ? wScan : [0.5, 1, 1]);
  }
  if (!anchored) { // no usable ring: the greyest sticker, if it is grey enough, is the white
    let g = -1;
    labs.forEach((l, i) => { if (ok[i] && i !== 4 && l[0] > 55 && chromaOf(l) < 30 && (g < 0 || chromaOf(l) < chromaOf(labs[g]))) g = i; });
    if (g >= 0) applyAnchor(labs[g], 'white', scanned ? wScan : [0.5, 1, 1]);
  }

  const names = [], confidence = [];
  for (let i = 0; i < 9; i++) {
    const lab = i === 4 && ringLab ? ringLab : labs[i];
    const adj = [lab[0] + shift[0], lab[1] + shift[1], lab[2] + shift[2]];
    const r = nearest(adj, pal);
    names.push(r.name);
    const far = 1 / (1 + (r.d1 / 32) ** 2); // far from every color: don't be confident
    confidence.push(ok[i] || (i === 4 && ringLab) ? marginOf(r.d1, r.d2) * far : 0);
  }
  return { names, confidence, source: scanned ? 'scan' : 'reference', anchored };
}

// ---- Candidates: what the cube could look like ---------------------------------------------

const AXIS_OF = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };

// Merge same-face turns even across the opposite face (R L R' = L), then the plain simplifier.
export function tidyMoves(seq) {
  const out = [];
  for (const mv of parseMoves(seq)) {
    const { base, turns } = moveInfo(mv);
    let merged = false;
    if (base in AXIS_OF) {
      for (let j = out.length - 1; j >= 0; j--) {
        const b = moveInfo(out[j]).base;
        if (!(b in AXIS_OF) || AXIS_OF[b] !== AXIS_OF[base]) break;
        if (b === base) {
          const t = (((moveInfo(out[j]).turns + turns) % 4) + 4) % 4;
          out.splice(j, 1, ...(t === 0 ? [] : [base + (t === 1 ? '' : t === 2 ? '2' : "'")]));
          merged = true;
          break;
        }
      }
    }
    if (!merged) out.push(mv);
  }
  return simplifyMoves(out);
}

const run = (state, moves) => moves.reduce(applyMove, state);
const SLIP_U = ['U', "U'", 'U2'];

// All states worth comparing for the plan `before` + `M`: nothing done, every prefix, the finished
// step, and every state a single slip could have produced (wrong way, skipped, done twice, a
// quarter instead of a half, or a stray turn of the top layer at the end). Cached: the app asks
// again on every camera frame.
const cache = new Map();
function candidatesFor(before, M) {
  const key = `${before}|${M.join(' ')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const n = M.length;
  const pre = [before];
  for (let i = 0; i < n; i++) pre.push(applyMove(pre[i], M[i]));
  const after = pre[n];
  const list = [{ cat: 0, kind: 'ok', k: n, state: after }];
  for (let k = 0; k < n; k++) list.push({ cat: 1, kind: 'partial', k, state: pre[k] });
  const seen = new Set(pre); // a slip that lands on a prefix is just "part way"; on `after`, just right
  const slip = (seq, info) => {
    const start = info.index ?? n;
    const state = run(pre[Math.min(start, n)], seq.slice(start));
    if (seen.has(state)) return;
    seen.add(state);
    list.push({ cat: 2, kind: 'mistake', state, seq, info });
  };
  for (let i = 0; i < n; i++) {
    const m = M[i], { base, turns } = moveInfo(m);
    const head = M.slice(0, i), tail = M.slice(i + 1);
    const swap = (did, type) => slip([...head, ...did, ...tail], { type, index: i, planned: m, did });
    if (turns === 2) {
      swap([base], 'quarter'); swap([base + "'"], 'quarter');
    } else {
      swap([invertMove(m)], 'wrongWay');
      swap([base + '2'], 'twice');
    }
    slip([...head, ...tail], { type: 'skip', index: i, planned: m, did: [] });
  }
  for (const e of SLIP_U) slip([...M, e], { type: 'extraU', index: n, planned: null, did: [e] });
  const built = { M, n, after, pre, list };
  cache.set(key, built);
  if (cache.size > 48) cache.delete(cache.keys().next().value);
  return built;
}

// ---- Diagnosis -----------------------------------------------------------------------------

const j = (moves) => moves.join(' ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SOLID = 0.75; // a mismatch on a sticker the classifier is this sure about is not a misread

function describeSlip(info, M, fix) {
  const m = info.planned;
  const face = m ? m[0] : 'U';
  const what = face === 'y' ? 'the whole cube' : face;
  let head;
  switch (info.type) {
    case 'wrongWay': head = `Looks like you turned ${what} the wrong way (${info.did[0]} instead of ${m}).`; break;
    case 'skip': head = `Looks like you skipped ${face === 'y' ? 'a whole-cube turn' : `a ${m}`} (move ${info.index + 1} of ${M.length}).`; break;
    case 'twice': head = `Looks like you turned ${what} twice (${m[0]}2 instead of ${m}).`; break;
    case 'quarter': head = `Looks like you only turned ${what} a quarter (${info.did[0]} instead of ${m}).`; break;
    case 'extraU': head = `Looks like the top layer got an extra turn at the end (${info.did[0]}).`; break;
    default: head = 'Looks like one move went wrong.';
  }
  if (!fix.length) return head;
  if (fix.length <= 6) return `${head} Do ${j(fix)} to fix it.`;
  return `${head} It was a few moves back, so the fix is longer: ${j(fix)}.`;
}

// before: facelets when the step began. stepMoves: the step's moves. observedNames: the 9 colors
// seen on the face pointing at the camera (row-major, as it looks). Options:
//   colorOf         letter → color name (COLOR_OF)
//   observedTop     9 colors of the top face, read with the cube tipped toward the camera (green
//                   side at the bottom of the picture); when given, both faces must agree
//   confidence, topConfidence   per-sticker 0..1 from classifyWithPalette, so a confident mismatch
//                   is not blamed on a misread
// → { verdict: 'ok' | 'partial' | 'mistake' | 'unknown', matched, message, fixMoves, ... }
//   matched     moves of the step the cube shows (ok: all of them, partial: that many, else 0)
//   fixMoves    mistake: moves that take the ACTUAL cube back onto the plan; else []
//   actual      mistake/partial: the facelets the diagnosis believes the cube is in
//   ambiguous   several different slips look the same; fixMoves is [] until the top face is shown
//   needsTop    asking the caller to show the top face too
//   blind       ok, but this step never changes the face(s) looked at, so nothing was confirmed
//   stickers    matching stickers out of `total` for the chosen reading
export function diagnose(before, stepMoves, observedNames, {
  colorOf = COLOR_OF, observedTop = null, confidence = null, topConfidence = null,
} = {}) {
  const M = parseMoves(stepMoves ?? []);
  const useTop = Array.isArray(observedTop) && observedTop.length === 9;
  const total = useTop ? 18 : 9;
  const unknown = (extra = '') => ({
    verdict: 'unknown', matched: 0, fixMoves: [], ambiguous: false, needsTop: false, total,
    message: `Doesn't match what I expected. Check that white is on the bottom and green is in front, or rescan the cube.${extra}`,
  });
  if (!Array.isArray(observedNames) || observedNames.length !== 9) return unknown();

  const { n, after, list } = candidatesFor(before, M);
  const cmp = (state) => {
    const bad = [];
    for (let i = 0; i < 9; i++) if (colorOf[state[18 + i]] !== observedNames[i]) bad.push({ face: 'F', i });
    if (useTop) for (let i = 0; i < 9; i++) if (colorOf[state[i]] !== observedTop[i]) bad.push({ face: 'U', i });
    return bad;
  };
  const solid = (b) => (b.face === 'F' ? confidence?.[b.i] : topConfidence?.[b.i]) >= SOLID;

  const hits = [];
  for (const c of list) {
    const bad = cmp(c.state);
    if (bad.length > 1 || (bad.length === 1 && solid(bad[0]))) continue; // at most one misread sticker
    hits.push({ c, m: bad.length });
  }
  if (!hits.length) return unknown();

  const done = (extra) => ({ needsTop: false, ambiguous: false, fixMoves: [], total, ...extra });

  // ok beats partial beats mistake (fewer misreads first inside a class).
  const cat = Math.min(...hits.map((h) => h.c.cat));
  const inCat = hits.filter((h) => h.c.cat === cat);
  const best = Math.min(...inCat.map((h) => h.m));
  const top = inCat.filter((h) => h.m === best);
  const stickers = total - best;

  if (cat === 0) {
    // How many of the last moves cannot be seen from the faces we looked at?
    const sig = (state) => `${expectedFace(state, 'F', colorOf).join()}${useTop ? `|${expectedFace(state, 'U', colorOf).join()}` : ''}`;
    const same = (state) => sig(state) === sig(after);
    const { pre } = candidatesFor(before, M);
    let firstSame = n;
    while (firstSame > 0 && same(pre[firstSame - 1])) firstSame--;
    const unseen = n - firstSame;
    const blind = n > 0 && unseen === n;
    let message = 'Matches — nice!';
    if (blind) message = `The ${useTop ? 'front and top look' : 'front looks'} right, but this step doesn't change ${useTop ? 'them' : 'it'}, so I can't confirm your moves from here. Check the 3D view by eye.`;
    else if (unseen > 0) message = `Matches — nice! The last ${unseen === 1 ? 'move' : `${unseen} moves`} (${j(M.slice(n - unseen))}) can't be seen from this side, so double-check ${unseen === 1 ? 'it' : 'them'} by eye.`;
    return done({ verdict: 'ok', matched: n, message, blind, unseen, stickers, actual: after });
  }

  if (cat === 1) {
    const ks = top.map((h) => h.c.k).sort((a, b) => a - b);
    const k = ks[0];
    const rest = M.slice(k);
    const range = ks.length > 1 && ks[ks.length - 1] !== k ? ` (the face looks the same after ${ks.length === 2 ? `${k} or ${ks[1]}` : `${k} to ${ks[ks.length - 1]}`} moves)` : '';
    const message = k === 0
      ? `Nothing done yet — start with: ${j(rest)}`
      : `You're ${plural(k, 'move')} in — next: ${j(rest)}${range}`;
    return done({ verdict: 'partial', matched: k, matchedRange: [k, ks[ks.length - 1]], remaining: rest, message, stickers, actual: top[0].c.state });
  }

  // A mistake. Group readings by the fix they need; one group means we know what to do.
  const withFix = top.map((h) => ({ h, fix: tidyMoves([...invertMoves(h.c.seq), ...M]) }));
  const groups = new Map();
  for (const w of withFix) if (!groups.has(j(w.fix))) groups.set(j(w.fix), w);
  const uniq = [...groups.values()].sort((a, b) => a.fix.length - b.fix.length || a.h.c.info.index - b.h.c.info.index);
  const pick = uniq[0];
  if (uniq.length === 1) {
    return done({
      verdict: 'mistake', matched: 0, fixMoves: pick.fix, message: describeSlip(pick.h.c.info, M, pick.fix),
      kind: pick.h.c.info.type, errorIndex: pick.h.c.info.index, stickers, actual: pick.h.c.state,
    });
  }
  const options = uniq.slice(0, 3).map((u) => describeSlip(u.h.c.info, M, u.fix).replace(/ Do .* to fix it\.$| It was a few moves back.*$/, ''));
  if (!useTop) {
    return done({
      verdict: 'mistake', matched: 0, ambiguous: true, needsTop: true, stickers, alternatives: uniq.map((u) => ({ fixMoves: u.fix, actual: u.h.c.state })),
      message: `Something went wrong, but from the front I can't tell what (${options.map((o) => o.replace(/^Looks like /, '').replace(/\.$/, '')).join('; or ')}). Show me the top face too: tip the cube toward the camera.`,
    });
  }
  // The top face did not settle it either: offer the shortest fix as a best guess.
  return done({
    verdict: 'mistake', matched: 0, ambiguous: true, needsTop: false, fixMoves: pick.fix, kind: pick.h.c.info.type, errorIndex: pick.h.c.info.index,
    stickers, actual: pick.h.c.state, alternatives: uniq.map((u) => ({ fixMoves: u.fix, actual: u.h.c.state })),
    message: `${describeSlip(pick.h.c.info, M, pick.fix)} That is my best guess: two slips look alike, so if the cube still isn't right after this, rescan it.`,
  });
}
