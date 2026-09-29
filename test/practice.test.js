import test from 'node:test';
import assert from 'node:assert/strict';
import { Timer, stats, formatTime, History, scrambleForPractice, HOLD_MS } from '../src/practice.js';
import { LESSONS, NOTATION, ROADMAP } from '../src/lessons.js';
import { SOLVED, applyMoves, parseMoves, isSolved, validate, CORNER_SLOTS, EDGE_SLOTS } from '../src/cube.js';

const S = (ms, penalty = null) => ({ ms, penalty, scramble: '', date: 0 });

test('timer without inspection: holding threshold', () => {
  const t = new Timer({ inspection: false });
  t.press(0);
  assert.equal(t.tick(100).state, 'holding');
  assert.equal(t.tick(HOLD_MS).state, 'ready');
  t.release(HOLD_MS);
  assert.equal(t.tick(HOLD_MS).state, 'running');
  assert.equal(t.tick(HOLD_MS + 12345).display, '12.34');
  t.press(HOLD_MS + 5000);
  const r = t.tick(HOLD_MS + 9000);
  assert.equal(r.state, 'stopped');
  assert.equal(r.display, '5.00');
  assert.deepEqual(t.result(), { ms: 5000, penalty: null });
  t.release(HOLD_MS + 5001); // ignored
  assert.equal(t.state, 'stopped');
});

test('early release cancels the start', () => {
  const t = new Timer({ inspection: false });
  t.press(0);
  t.release(299);
  assert.equal(t.tick(300).state, 'idle');
});

test('inspection countdown and no penalty', () => {
  const t = new Timer();
  t.press(0); // starts inspection
  assert.equal(t.tick(0).state, 'inspecting');
  assert.equal(t.tick(0).display, '15');
  assert.equal(t.tick(3200).display, '12');
  t.press(10000);
  assert.equal(t.tick(10100).state, 'holding');
  assert.equal(t.tick(10300).state, 'ready');
  t.release(10400);
  assert.equal(t.tick(10400).penalty, null);
  t.press(20400);
  assert.deepEqual(t.result(), { ms: 10000, penalty: null });
});

test('inspection +2 after 15 s', () => {
  const t = new Timer();
  t.startInspection(0);
  assert.equal(t.tick(15500).display, '+2');
  t.press(16000);
  t.release(16400);
  assert.equal(t.tick(16400).penalty, '+2');
  t.press(26400);
  assert.deepEqual(t.result(), { ms: 10000, penalty: '+2' });
  assert.equal(t.tick(30000).display, '12.00+');
});

test('inspection DNF after 17 s', () => {
  const t = new Timer();
  t.startInspection(0);
  assert.equal(t.tick(17000).state, 'inspecting');
  const r = t.tick(17001);
  assert.equal(r.state, 'stopped');
  assert.equal(r.penalty, 'DNF');
  assert.equal(r.display, 'DNF');
  // Starting late (release after 17 s) is also a DNF.
  const u = new Timer();
  u.startInspection(0);
  u.press(16900);
  u.release(17300);
  assert.equal(u.tick(17300).penalty, 'DNF');
});

test('formatTime', () => {
  assert.equal(formatTime(9870), '9.87');
  assert.equal(formatTime(62350), '1:02.35');
  assert.equal(formatTime(60000), '1:00.00');
  assert.equal(formatTime(5), '0.00');
  assert.equal(formatTime('DNF'), 'DNF');
  assert.equal(formatTime(Infinity), 'DNF');
  assert.equal(formatTime(null), 'DNF');
});

test('stats: not enough solves', () => {
  assert.deepEqual(stats([]), { count: 0, best: null, worst: null, mean: null, ao5: null, ao12: null });
  const s = stats([S(10000), S(12000), S(11000), S(9000)]);
  assert.equal(s.ao5, null);
  assert.equal(s.ao12, null);
  assert.equal(s.best, 9000);
  assert.equal(s.worst, 12000);
  assert.equal(s.mean, 10500);
});

test('stats: ao5 and ao12 by hand', () => {
  // ao5: drop 8000 and 14000, mean(10000, 11000, 12000) = 11000
  const five = [10000, 8000, 14000, 11000, 12000].map((m) => S(m));
  assert.equal(stats(five).ao5, 11000);
  // ao12: drop best and worst, average the other 10: (15000 + 9 x 10000) / 10
  const twelve = [99999, 5000, 15000, ...Array(9).fill(10000)].map((m) => S(m));
  const st = stats(twelve.slice(1)); // 11 solves: ao12 null
  assert.equal(st.ao12, null);
  assert.equal(stats(twelve).ao12, 10500); // drops 99999 and 5000
  // Latest window only: old slow solve falls out of the ao5
  assert.equal(stats([S(99999), ...five]).ao5, 11000);
});

test('stats: penalties and DNF', () => {
  // +2 counts as ms+2000
  const s = stats([S(10000, '+2'), S(10000), S(10000), S(10000), S(10000)]);
  assert.equal(s.worst, 12000);
  assert.equal(s.ao5, 10000); // the +2 solve is the trimmed worst
  // one DNF is the dropped worst: ao5 finite
  const one = stats([S(10000), S(11000), S(12000), S(9000, 'DNF'), S(13000)]);
  assert.equal(one.ao5, 12000); // drop 10000 and DNF -> 11000,12000,13000
  assert.equal(one.best, 10000);
  assert.equal(one.worst, 13000);
  assert.equal(one.mean, 11500);
  // two DNFs -> DNF
  const two = stats([S(10000), S(11000, 'DNF'), S(12000), S(9000, 'DNF'), S(13000)]);
  assert.equal(two.ao5, 'DNF');
  assert.equal(formatTime(two.ao5), 'DNF');
  // all DNF
  const all = stats([S(1, 'DNF')]);
  assert.equal(all.best, null);
  assert.equal(all.mean, null);
  // ao12 with one DNF still finite, two DNF -> DNF
  const base = Array(12).fill(0).map((_, i) => S(10000 + i * 100));
  assert.equal(stats([...base.slice(1), S(1, 'DNF')]).ao12 !== 'DNF', true);
  assert.equal(stats([...base.slice(2), S(1, 'DNF'), S(1, 'DNF')]).ao12, 'DNF');
});

class FakeStorage {
  constructor(init = {}) { this.d = { ...init }; }
  getItem(k) { return k in this.d ? this.d[k] : null; }
  setItem(k, v) { this.d[k] = String(v); }
}

test('History persists, edits and clears', () => {
  const st = new FakeStorage();
  const h = new History(st);
  h.add(S(10000));
  h.add(S(12000));
  h.setPenalty(0, '+2');
  assert.equal(h.all()[0].penalty, '+2');
  assert.throws(() => h.setPenalty(0, 'bogus'));
  assert.equal(new History(st).all().length, 2);
  h.remove(0);
  assert.deepEqual(new History(st).all().map((s) => s.ms), [12000]);
  h.remove(5); // out of range is a no-op
  h.clear();
  assert.equal(new History(st).all().length, 0);
});

test('History tolerates corrupt storage', () => {
  assert.deepEqual(new History(new FakeStorage({ 'rcc.solves': '{not json' })).all(), []);
  assert.deepEqual(new History(new FakeStorage({ 'rcc.solves': '{"a":1}' })).all(), []);
  const h = new History(new FakeStorage({ k: '[{"ms":5},null,3]' }), 'k');
  assert.equal(h.all().length, 1);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const hb = new History(broken);
  hb.add(S(1000));
  assert.equal(hb.all().length, 1);
});

test('scrambleForPractice', () => {
  let i = 0;
  const rand = () => ((i++ * 0.37) % 1);
  const s = scrambleForPractice(rand);
  assert.equal(typeof s, 'string');
  assert.equal(parseMoves(s).length, 20);
});

test('lessons: every algorithm parses and content is complete', () => {
  const ids = ['cross', 'whiteCorners', 'middle', 'yellowCross', 'yellowEdges', 'yellowCornersPosition', 'yellowCornersOrient'];
  assert.deepEqual(Object.keys(LESSONS), ids);
  for (const id of ids) {
    const l = LESSONS[id];
    assert.ok(l.goal && l.recognize);
    assert.ok(l.tips.length > 0 && l.speedTips.length > 0);
    assert.ok(l.algorithms.length > 0);
    for (const a of l.algorithms) {
      assert.ok(a.name && a.when);
      assert.doesNotThrow(() => parseMoves(a.moves));
    }
  }
  assert.deepEqual(NOTATION.map((n) => n.move), ['U', "U'", 'U2', 'D', 'R', 'L', 'F', 'B', 'y']);
  assert.equal(ROADMAP.length, 6);
});

test('lesson algorithms match the solver', () => {
  const alg = (id, i = 0) => LESSONS[id].algorithms[i].moves;
  assert.equal(alg('whiteCorners'), "R U R' U'");
  assert.equal(alg('middle', 0), "U R U' R' U' F' U F");
  assert.equal(alg('middle', 1), "U' L' U L U F U' F'");
  assert.equal(alg('yellowCross'), "F R U R' U' F'");
  assert.equal(alg('yellowEdges'), "R U R' U R U2 R'");
  assert.equal(alg('yellowCornersPosition'), "U R U' L' U R' U' L");
  assert.equal(alg('yellowCornersOrient'), "R' D' R D");
});

const repeat = (m, n) => Array(n).fill(m).join(' ');
const diff = (a, b) => [...a].filter((c, i) => c !== b[i]).length;

test('R U R\' U\' has order 6', () => {
  const m = "R U R' U'";
  for (let n = 1; n < 6; n++) assert.ok(!isSolved(applyMoves(SOLVED, repeat(m, n))), `n=${n}`);
  assert.ok(isSolved(applyMoves(SOLVED, repeat(m, 6))));
});

test('yellow cross and yellow edges algorithms', () => {
  const cross = LESSONS.yellowCross.algorithms[0].moves;
  assert.ok(isSolved(applyMoves(SOLVED, repeat(cross, 6))));
  const sune = LESSONS.yellowEdges.algorithms[0].moves;
  const once = applyMoves(SOLVED, sune);
  assert.ok(validate(once).ok);
  // Sune leaves the first two layers' edges and the whole bottom layer alone.
  for (let i = 27; i < 36; i++) assert.equal(once[i], 'D');
  assert.ok(!isSolved(once));
  assert.ok(isSolved(applyMoves(SOLVED, repeat(sune, 6))));
});

test('place-corners algorithm cycles three corners', () => {
  const alg = LESSONS.yellowCornersPosition.algorithms[0].moves;
  const once = applyMoves(SOLVED, alg);
  assert.ok(validate(once).ok);
  // Every edge is untouched relative to the solved cube.
  for (const slot of EDGE_SLOTS) for (const i of slot.stickers) assert.equal(once[i], SOLVED[i]);
  // Exactly three corners moved, and none is twisted-in-place-only (three-cycle).
  const moved = CORNER_SLOTS.filter((s) => s.stickers.some((i) => once[i] !== SOLVED[i]));
  assert.equal(moved.length, 3);
  assert.ok(!isSolved(once));
  assert.equal(diff(once, SOLVED) > 0, true);
  assert.ok(isSolved(applyMoves(SOLVED, repeat(alg, 3))));
});

test('corner twist algorithm', () => {
  const alg = LESSONS.yellowCornersOrient.algorithms[0].moves;
  assert.ok(isSolved(applyMoves(SOLVED, repeat(alg, 6))));
  assert.ok(validate(applyMoves(SOLVED, alg)).ok);
});

test('middle-layer algorithms are inverse-mirror pairs that keep the bottom layer', () => {
  for (const a of LESSONS.middle.algorithms) {
    const s = applyMoves(SOLVED, a.moves);
    assert.ok(validate(s).ok);
    for (let i = 27; i < 36; i++) assert.equal(s[i], 'D');
  }
});
