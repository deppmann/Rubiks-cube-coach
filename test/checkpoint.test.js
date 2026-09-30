import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLVED, COLOR_OF, FACES, applyMoves, randomScramble, parseMoves, moveInfo, invertMove,
} from '../src/cube.js';
import { solveBeginner } from '../src/solver.js';
import { COLOR_NAMES } from '../src/colors.js';
import { buildCube } from '../src/autoscan.js';
import {
  paletteFromScan, classifyWithPalette, validPalette, expectedFront, expectedTop, expectedFace, diagnose, tidyMoves,
} from '../src/checkpoint.js';
import { rng } from './synth.js';
import { BASE } from './facesynth.js';

// ---- Steps to test on: real coach steps from random scrambles -------------------------------

function collectSteps(seed, wantScrambles = 30) {
  const rand = rng(seed);
  const steps = [];
  for (let s = 0; s < wantScrambles; s++) {
    const start = applyMoves(SOLVED, randomScramble(20 + Math.floor(rand() * 8), rand));
    const res = solveBeginner(start);
    assert.ok(res.ok, res.error);
    let before = start;
    for (const stage of res.stages) {
      for (const step of stage.steps) {
        if (step.moves.length) steps.push({ before, moves: step.moves, after: step.after, stage: stage.id });
        before = step.after;
      }
    }
  }
  return steps;
}
const ALL = collectSteps(1234);
function sample(n, seed) {
  const rand = rng(seed);
  const pool = ALL.slice().sort(() => rand() - 0.5);
  return pool.slice(0, n);
}
const STEPS = sample(300, 99);
const front = (facelets) => expectedFront(facelets);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const diffCount = (a, b) => a.filter((v, i) => v !== b[i]).length;

test('the pool covers every stage and long algorithms', () => {
  assert.equal(STEPS.length, 300);
  assert.equal(new Set(ALL.map((s) => s.stage)).size, 7);
  assert.ok(Math.max(...ALL.map((s) => s.moves.length)) >= 12);
});

// ---- expectedFront -------------------------------------------------------------------------

test('expectedFront reads the F face upright, following COLOR_OF (and a custom colorOf)', () => {
  assert.deepEqual(expectedFront(SOLVED), Array(9).fill('green'));
  assert.deepEqual(expectedTop(SOLVED), Array(9).fill('yellow'));
  // After R the front's right column takes the D-face colors (white), left column stays green.
  assert.deepEqual(expectedFront(applyMoves(SOLVED, 'R')), ['green', 'green', 'white', 'green', 'green', 'white', 'green', 'green', 'white']);
  // After y the orange face is in front.
  assert.deepEqual(expectedFront(applyMoves(SOLVED, 'y')), Array(9).fill('orange'));
  const custom = { ...COLOR_OF, F: 'purple' };
  assert.deepEqual(expectedFront(SOLVED, custom), Array(9).fill('purple'));
  assert.deepEqual(expectedFace(applyMoves(SOLVED, 'U'), 'F').slice(0, 3), ['orange', 'orange', 'orange']);
});

// ---- diagnose: ok / partial ----------------------------------------------------------------

test('300 coach steps: the exact expected after-state is ok', () => {
  for (const s of STEPS) {
    const d = diagnose(s.before, s.moves, front(s.after));
    assert.equal(d.verdict, 'ok', `${s.moves.join(' ')}: ${d.message}`);
    assert.equal(d.matched, s.moves.length);
    assert.deepEqual(d.fixMoves, []);
    assert.match(d.message, /Matches|can't confirm|can't be seen/);
  }
});

test('300 coach steps: every prefix of the moves reads as partial (or, when the face cannot show it, ok)', () => {
  let partial = 0, total = 0, viaOk = 0;
  for (const s of STEPS) {
    const target = front(s.after);
    for (let k = 0; k < s.moves.length; k++) {
      const state = applyMoves(s.before, s.moves.slice(0, k));
      const obs = front(state);
      const d = diagnose(s.before, s.moves, obs);
      total++;
      assert.notEqual(d.verdict, 'mistake', `${s.moves.join(' ')} after ${k}: ${d.message}`);
      assert.notEqual(d.verdict, 'unknown');
      if (d.verdict === 'partial') {
        partial++;
        assert.ok(d.matched <= k, `matched ${d.matched} > ${k}`);
        // The face after `matched` moves looks exactly like what was seen.
        assert.ok(same(front(applyMoves(s.before, s.moves.slice(0, d.matched))), obs) || diffCount(front(applyMoves(s.before, s.moves.slice(0, d.matched))), obs) <= 1);
        assert.equal(d.remaining.join(' '), s.moves.slice(d.matched).join(' '));
        assert.match(d.message, d.matched === 0 ? /^Nothing done yet — start with: / : /^You're \d+ moves? in — next: /);
      } else {
        viaOk++;
        assert.ok(diffCount(obs, target) <= 1, 'ok only when the front cannot be told from the finished one');
      }
    }
  }
  assert.ok(partial / total > 0.8, `partial ${partial}/${total}`);
  console.log(`  prefixes: ${partial} partial, ${viaOk} looked like the finished front, of ${total}`);
});

test('partial message names the moves left, e.g. "You\'re 2 moves in — next: U\' R\'"', () => {
  const before = applyMoves(SOLVED, "R U F' L D");
  const moves = ['F', 'R', "U'", "R'"];
  const d = diagnose(before, moves, front(applyMoves(before, moves.slice(0, 2))));
  assert.equal(d.verdict, 'partial');
  assert.equal(d.matched, 2);
  assert.equal(d.message, "You're 2 moves in — next: U' R'");
  const d0 = diagnose(before, moves, front(before));
  assert.equal(d0.verdict, 'partial');
  assert.equal(d0.matched, 0);
  assert.match(d0.message, /Nothing done yet — start with: F R U' R'/);
});

// ---- diagnose: single mistakes -------------------------------------------------------------

// A slip applied to the whole plan; every kind the spec lists. Returns null if it does nothing.
function injectSlip(moves, rand) {
  const kinds = ['wrongWay', 'skip', 'twice', 'extraU'];
  const kind = kinds[Math.floor(rand() * kinds.length)];
  const i = Math.floor(rand() * moves.length);
  const m = moves[i], { base, turns } = moveInfo(m);
  const seq = moves.slice();
  if (kind === 'wrongWay') { if (turns === 2) seq.splice(i, 1, base + (rand() < 0.5 ? '' : "'")); else seq[i] = invertMove(m); }
  else if (kind === 'skip') seq.splice(i, 1);
  else if (kind === 'twice') { if (turns === 2) return null; seq[i] = base + '2'; }
  else seq.push(['U', "U'", 'U2'][Math.floor(rand() * 3)]);
  return { kind, seq };
}

test('300 coach steps: an injected single slip is a mistake and fixMoves lead the ACTUAL cube back onto the plan', () => {
  const rand = rng(4242);
  let tried = 0, mistakes = 0, exact = 0, ambiguous = 0, topResolved = 0, nearOk = 0;
  const kindsSeen = new Set();
  for (const s of STEPS) {
    const slip = injectSlip(s.moves, rand);
    if (!slip) continue;
    const actual = applyMoves(s.before, slip.seq);
    if (actual === s.after) continue;
    const obs = front(actual);
    // Slips that look exactly like a prefix or the finished face are not detectable from the front.
    const plan = [s.after, ...s.moves.map((_, k) => applyMoves(s.before, s.moves.slice(0, k)))];
    if (plan.some((p) => diffCount(front(p), obs) <= 1)) { nearOk++; continue; }
    tried++;
    let d = diagnose(s.before, s.moves, obs);
    assert.equal(d.verdict, 'mistake', `${s.moves.join(' ')} -> ${slip.seq.join(' ')}: ${d.message}`);
    if (d.ambiguous) {
      ambiguous++;
      assert.deepEqual(d.fixMoves, [], 'no fix is offered while the reading is ambiguous');
      assert.ok(d.needsTop);
      assert.match(d.message, /top face/);
      d = diagnose(s.before, s.moves, obs, { observedTop: expectedTop(actual) });
      assert.equal(d.verdict, 'mistake');
      if (d.ambiguous) continue; // the top does not settle it either; flagged, best guess only
      topResolved++;
    }
    mistakes++;
    kindsSeen.add(d.kind);
    assert.equal(applyMoves(actual, d.fixMoves), s.after, `${s.moves.join(' ')} -> ${slip.seq.join(' ')}: fix ${d.fixMoves.join(' ')} (${d.message})`);
    assert.equal(d.actual, actual, 'the diagnosis names the real cube state');
    assert.ok(d.fixMoves.length > 0);
    assert.doesNotThrow(() => parseMoves(d.fixMoves));
    if (!d.ambiguous && d.fixMoves.length <= 6) assert.match(d.message, /Do .* to fix it\./);
    if (d.kind === 'wrongWay' || d.kind === 'skip' || d.kind === 'twice' || d.kind === 'extraU') exact++;
  }
  console.log(`  slips: ${tried} detectable (${nearOk} invisible from the front), ${mistakes} with a verified fix, ${ambiguous} needed the top face (${topResolved} resolved by it)`);
  assert.ok(tried >= 120, `only ${tried} detectable slips`);
  assert.ok(mistakes / tried > 0.85, `verified fixes ${mistakes}/${tried}`);
  assert.ok(exact > 60);
  for (const k of ['wrongWay', 'skip', 'twice', 'extraU']) assert.ok(kindsSeen.has(k), `never saw ${k}`);
});

test('the example message from the spec: a wrong-way last move', () => {
  const before = applyMoves(SOLVED, "R U R' U' F'");
  const moves = ['F', 'R', 'U'];
  const actual = applyMoves(before, ['F', 'R', "U'"]);
  const d = diagnose(before, moves, front(actual));
  assert.equal(d.verdict, 'mistake');
  assert.equal(d.message, "Looks like you turned U the wrong way (U' instead of U). Do U2 to fix it.");
  assert.deepEqual(d.fixMoves, ['U2']);
  assert.equal(applyMoves(actual, d.fixMoves), applyMoves(before, moves));
});

test('a slip in the middle of a longer step gets a longer fix that still works; extra top turn is named', () => {
  const before = applyMoves(SOLVED, "R U R' U' L' U' L");
  const moves = ['R', 'U', "R'", "U'", 'R', 'U', "R'", "U'"];
  const seq = moves.slice(); seq[2] = 'R'; // R' → R
  const actual = applyMoves(before, seq);
  const d = diagnose(before, moves, front(actual), { observedTop: expectedTop(actual) });
  assert.equal(d.verdict, 'mistake');
  assert.equal(applyMoves(actual, d.fixMoves), applyMoves(before, moves));
  assert.match(d.message, /turned R the wrong way \(R instead of R'\)/);
  const after = applyMoves(before, moves);
  const extra = applyMoves(after, "U'");
  const e = diagnose(before, moves, front(extra), { observedTop: expectedTop(extra) });
  assert.equal(e.verdict, 'mistake');
  assert.equal(applyMoves(extra, e.fixMoves), after);
});

test('before itself, and the tie-break ok > partial > mistake', () => {
  // A step whose moves never touch the front: the front cannot tell before from after -> ok (blind).
  const before = applyMoves(SOLVED, "R U R' U'");
  const d = diagnose(before, ['B', "B'", 'B'], front(before));
  assert.equal(d.verdict, 'ok');
  assert.equal(d.blind, true);
  assert.match(d.message, /can't confirm/);
  // With a hidden tail: last moves are B turns, so a front matching the first moves is ok, with a note.
  const moves = ['F', 'B'];
  const after = applyMoves(before, moves);
  const e = diagnose(before, moves, front(after));
  assert.equal(e.verdict, 'ok');
  assert.equal(e.unseen, 1);
  assert.match(e.message, /last move \(B\) can't be seen/);
  // Nothing to do: an empty step is ok when the face is right.
  assert.equal(diagnose(before, [], front(before)).verdict, 'ok');
});

test('ambiguous slips ask for the top face and then resolve', () => {
  // Find, among the pool, a slip whose front is shared by two slips with different fixes.
  let found = null;
  const rand = rng(7);
  for (const s of ALL) {
    for (let t = 0; t < 10 && !found; t++) {
      const slip = injectSlip(s.moves, rand);
      if (!slip) continue;
      const actual = applyMoves(s.before, slip.seq);
      const d = diagnose(s.before, s.moves, front(actual));
      if (d.verdict === 'mistake' && d.ambiguous) found = { s, actual };
    }
    if (found) break;
  }
  assert.ok(found, 'no ambiguous slip in the pool');
  const { s, actual } = found;
  const d = diagnose(s.before, s.moves, front(actual));
  assert.ok(d.needsTop && d.alternatives.length >= 2);
  assert.match(d.message, /Show me the top face too/);
  const t = diagnose(s.before, s.moves, front(actual), { observedTop: expectedTop(actual) });
  assert.equal(t.verdict, 'mistake');
  assert.equal(t.needsTop, false);
  assert.ok(t.alternatives === undefined || t.alternatives.length >= 1);
});

// ---- Robustness ----------------------------------------------------------------------------

test('one misread sticker still gives ok (and partial); two do not', () => {
  const rand = rng(5);
  let ok = 0, tried = 0, partialOk = 0, partialTried = 0;
  for (const s of STEPS) {
    const obs = front(s.after);
    const i = Math.floor(rand() * 9);
    const wrong = COLOR_NAMES.filter((c) => c !== obs[i]);
    const flipped = obs.slice();
    flipped[i] = wrong[Math.floor(rand() * wrong.length)];
    tried++;
    if (diagnose(s.before, s.moves, flipped).verdict === 'ok') ok++;
    // and a prefix with a flipped sticker
    const k = Math.floor(rand() * s.moves.length);
    const pobs = front(applyMoves(s.before, s.moves.slice(0, k)));
    if (diffCount(pobs, obs) > 1) {
      const pf = pobs.slice();
      pf[i] = COLOR_NAMES.filter((c) => c !== pobs[i])[Math.floor(rand() * 5)];
      partialTried++;
      if (diagnose(s.before, s.moves, pf).verdict === 'partial') partialOk++;
    }
  }
  console.log(`  1 flipped sticker: ok ${ok}/${tried}, partial ${partialOk}/${partialTried}`);
  assert.ok(ok / tried >= 0.99, `ok ${ok}/${tried}`);
  assert.ok(partialOk / partialTried >= 0.9, `partial ${partialOk}/${partialTried}`);
});

test('a confident mismatch is not excused as a misread', () => {
  const s = STEPS.find((x) => x.moves.length >= 3);
  const obs = front(s.after);
  const flipped = obs.slice();
  flipped[0] = COLOR_NAMES.find((c) => c !== obs[0]);
  const sure = new Array(9).fill(0.95);
  assert.equal(diagnose(s.before, s.moves, flipped, { confidence: sure }).verdict === 'ok', false);
  assert.equal(diagnose(s.before, s.moves, flipped, { confidence: sure.map((_, i) => (i === 0 ? 0.1 : 0.95)) }).verdict, 'ok');
});

test('garbage and a wrongly held cube are unknown, with advice', () => {
  const rand = rng(11);
  let unknown = 0, n = 0;
  for (const s of STEPS) {
    const garbage = Array.from({ length: 9 }, () => COLOR_NAMES[Math.floor(rand() * 6)]);
    n++;
    const d = diagnose(s.before, s.moves, garbage);
    if (d.verdict === 'unknown') {
      unknown++;
      assert.match(d.message, /Doesn't match what I expected\. Check that white is on the bottom and green is in front, or rescan the cube/);
      assert.deepEqual(d.fixMoves, []);
    }
  }
  assert.ok(unknown / n >= 0.99, `${unknown}/${n}`);
  // The bottom face read as if it were the front: not what the plan expects.
  let wrongFace = 0;
  for (const s of STEPS) {
    const d = expectedFace(s.after, 'D');
    if (diagnose(s.before, s.moves, d).verdict === 'unknown') wrongFace++;
  }
  assert.ok(wrongFace / STEPS.length > 0.9, `wrongFace ${wrongFace}`);
  // Malformed input never throws.
  for (const bad of [null, undefined, [], ['white'], 'green']) assert.equal(diagnose(SOLVED, ['R'], bad).verdict, 'unknown');
});

test('tidyMoves cancels across opposite faces and stays equivalent', () => {
  assert.deepEqual(tidyMoves(["R", "L", "R'"]), ['L']);
  assert.deepEqual(tidyMoves(["U", "U'"]), []);
  assert.deepEqual(tidyMoves(['F', 'B', 'F']), ['F2', 'B']);
  const rand = rng(3);
  for (let t = 0; t < 50; t++) {
    const seq = randomScramble(12, rand);
    const doubled = [...seq, ...seq.slice().reverse().map(invertMove)];
    assert.equal(applyMoves(SOLVED, tidyMoves(doubled)), SOLVED);
  }
});

// ---- Palette -------------------------------------------------------------------------------

const clampB = (v) => Math.max(0, Math.min(255, Math.round(v)));
// A sticker as the camera sees it: base color × light (gain, cast) × shading + noise.
function shoot(name, light, rand) {
  const g = () => (rand() + rand() + rand() - 1.5) * 2;
  const shade = 0.95 + rand() * 0.1;
  const c = BASE[name].map((v, k) => clampB(v * light.gain * light.cast[k] * shade + g() * (light.noise ?? 3)));
  return { r: c[0], g: c[1], b: c[2] };
}
const LIGHTS = {
  daylight: { gain: 1.0, cast: [1, 1, 1] },
  warm: { gain: 0.9, cast: [1.05, 0.96, 0.8] },
  cool: { gain: 0.85, cast: [0.92, 0.98, 1.1] },
  dim: { gain: 0.55, cast: [1, 0.98, 0.94] },
  bright: { gain: 1.15, cast: [1, 1, 0.97] },
};
// Six faces of `facelets`, canonical order and orientation, cap of the logo face replaced.
function scanCube(facelets, light, rand, { logo = true } = {}) {
  const logoFace = Math.floor(rand() * 6);
  return FACES.map((_, f) => {
    const names = Array.from({ length: 9 }, (_, i) => COLOR_OF[facelets[f * 9 + i]]);
    const cells = names.map((n) => shoot(n, light, rand));
    const ring = shoot(names[4], light, rand);
    if (logo && f === logoFace) cells[4] = { r: 25, g: 79, b: 149 };
    return { cells, centerRing: ring, names };
  });
}

test('paletteFromScan learns the six colors from a real scan pipeline (logo cap ignored)', () => {
  const rand = rng(2024);
  for (let t = 0; t < 8; t++) {
    const cube = applyMoves(SOLVED, randomScramble(25, rand));
    const light = Object.values(LIGHTS)[t % 5];
    const caps = scanCube(cube, light, rand);
    const res = buildCube(caps);
    assert.ok(res.ok, res.errors.join());
    const pal = paletteFromScan(caps, res.names, res.confidence);
    assert.ok(pal, 'palette');
    assert.equal(validPalette(pal), pal);
    assert.equal(pal.source, 'scan');
    assert.deepEqual(Object.keys(pal.lab).sort(), [...COLOR_NAMES].sort());
    for (const n of COLOR_NAMES) assert.ok(pal.count[n] >= 6, `${n} n=${pal.count[n]}`);
    // JSON-safe: storing and reloading changes nothing.
    assert.deepEqual(JSON.parse(JSON.stringify(pal)), pal);
    // The object form works the same.
    const pal2 = paletteFromScan({ faces: caps.map((c) => c.cells), rings: caps.map((c) => c.centerRing), names: res.names, confidence: res.confidence });
    assert.deepEqual(pal2.lab, pal.lab);
  }
});

test('paletteFromScan rejects incomplete or muddled scans', () => {
  const names = Array.from({ length: 6 }, () => Array(9).fill('white'));
  const faces = names.map(() => Array.from({ length: 9 }, () => ({ r: 200, g: 200, b: 200 })));
  assert.equal(paletteFromScan(faces.map((cells) => ({ cells, centerRing: { r: 1, g: 2, b: 3 } })), names), null);
  assert.equal(paletteFromScan(null), null);
  assert.equal(validPalette({ version: 1, lab: {} }), null);
  assert.equal(validPalette(null), null);
});

test('with the scan palette, noisy live faces under other light are named right', () => {
  const rand = rng(77);
  let stickers = 0, right = 0, faces = 0, perfect = 0;
  for (let t = 0; t < 40; t++) {
    const cube = applyMoves(SOLVED, randomScramble(25, rand));
    const keys = Object.keys(LIGHTS);
    const scanLight = LIGHTS[keys[t % 5]];
    const caps = scanCube(cube, scanLight, rand);
    const res = buildCube(caps);
    const pal = paletteFromScan(caps, res.names, res.confidence);
    // Same physical cube, later: a different state, and the light has drifted.
    const later = applyMoves(cube, randomScramble(15, rand));
    const liveLight = { gain: scanLight.gain * (0.75 + rand() * 0.5), cast: scanLight.cast.map((c) => c * (0.95 + rand() * 0.1)), noise: 4 };
    const live = scanCube(later, liveLight, rand, { logo: false })[2]; // the F face
    const cls = classifyWithPalette(live.cells, pal, { centerRing: live.centerRing });
    faces++;
    let all = true;
    cls.names.forEach((n, i) => { stickers++; if (n === live.names[i]) right++; else all = false; });
    if (all) perfect++;
    assert.equal(cls.confidence.length, 9);
    assert.ok(cls.confidence.every((c) => c >= 0 && c <= 1));
    assert.equal(cls.source, 'scan');
  }
  console.log(`  palette classify: ${right}/${stickers} stickers, ${perfect}/${faces} faces perfect`);
  assert.ok(right / stickers >= 0.985, `${right}/${stickers}`);
  assert.ok(perfect / faces >= 0.85, `${perfect}/${faces}`);
});

test('without a palette: reference colors with per-frame white balance', () => {
  const rand = rng(31);
  let stickers = 0, right = 0;
  for (let t = 0; t < 60; t++) {
    const cube = applyMoves(SOLVED, randomScramble(25, rand));
    const light = { gain: 0.6 + rand() * 0.6, cast: [1 + (rand() - 0.5) * 0.2, 1, 1 + (rand() - 0.5) * 0.24], noise: 3 };
    const f = scanCube(cube, light, rand, { logo: rand() < 0.5 })[2];
    const cls = classifyWithPalette(f.cells, null, { centerRing: f.centerRing });
    assert.equal(cls.source, 'reference');
    f.names.forEach((n, i) => { stickers++; if (cls.names[i] === n) right++; });
  }
  console.log(`  reference classify: ${right}/${stickers}`);
  assert.ok(right / stickers >= 0.95, `${right}/${stickers}`);
  // No ring: still works when the face shows a white sticker to balance on.
  const half = classifyWithPalette(Array.from({ length: 9 }, (_, i) => shoot(['white', 'green', 'red'][i % 3], LIGHTS.daylight, rand)), undefined);
  assert.equal(half.names[0], 'white');
  // Broken input never throws.
  assert.equal(classifyWithPalette([], null).names.length, 9);
  assert.equal(classifyWithPalette(undefined, { version: 9 }).confidence.length, 9);
});

test('end to end: palette classification of a step face feeds diagnose', () => {
  const rand = rng(909);
  let verdicts = { ok: 0, mistake: 0 }, n = 0;
  for (let t = 0; t < 40; t++) {
    const s = STEPS[t];
    const light = LIGHTS[Object.keys(LIGHTS)[t % 5]];
    const cube = s.before; // the cube in this step's starting state, scanned once
    const caps = scanCube(cube, light, rand);
    const res = buildCube(caps);
    if (!res.ok) continue;
    const pal = paletteFromScan(caps, res.names, res.confidence);
    const live = (state) => {
      const f = scanCube(state, { ...light, gain: light.gain * 0.9, noise: 4 }, rand, { logo: false })[2];
      return classifyWithPalette(f.cells, pal, { centerRing: f.centerRing });
    };
    n++;
    const good = live(s.after);
    const g = diagnose(s.before, s.moves, good.names, { confidence: good.confidence });
    if (g.verdict === 'ok') verdicts.ok++;
    const slip = s.moves.slice(0, -1).concat(invertMove(s.moves.at(-1)));
    const wrongState = applyMoves(s.before, slip);
    if (diffCount(front(wrongState), front(s.after)) >= 3 && moveInfo(s.moves.at(-1)).turns !== 2) {
      const bad = live(wrongState);
      const b = diagnose(s.before, s.moves, bad.names, { confidence: bad.confidence });
      if (b.verdict === 'mistake' && !b.ambiguous && applyMoves(wrongState, b.fixMoves) === s.after) verdicts.mistake++;
    }
  }
  console.log(`  e2e: ${verdicts.ok}/${n} ok, ${verdicts.mistake} mistakes fixed`);
  assert.ok(verdicts.ok / n >= 0.9);
  assert.ok(verdicts.mistake >= 5);
});
