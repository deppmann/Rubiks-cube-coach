// Cube Coach app: wires Scan → Coach → Practice. Only DOM glue lives here; cube logic comes
// from cube.js and the solver, so nothing below knows a sticker permutation.
import { SOLVED, COLOR_OF, applyMoves, applyMove, parseMoves, randomScramble, validate } from './cube.js';
import { STAGES, solveBeginner } from './solver.js';
import { LESSONS, NOTATION, ROADMAP } from './lessons.js';
import { AutoCamera } from './autocam.js';
import { FaceTray, buildCube } from './autoscan.js';
import { COLOR_NAMES } from './colors.js';
import { NetEditor, NET_HEX } from './netEditor.js';
import { Timer, History, stats, formatTime, scrambleForPractice } from './practice.js';

// ---- Small helpers ------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((c) => c != null && c !== false));
  return e;
}

// localStorage can be missing or throw (private mode, sandboxed frames): fall back to memory.
const storage = (() => {
  try {
    const s = window.localStorage;
    s.setItem('rcc.probe', '1');
    s.removeItem('rcc.probe');
    return s;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
})();
const load = (k, fallback) => { try { const v = storage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const save = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: keep going */ } };

const live = $('#live');
function announce(text) {
  // Clear first so repeating the same text (e.g. "R" twice) is still read out.
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Text entry keeps its keys; a focused checkbox or button does not own the space bar.
const isTyping = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName)
  || (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range)$/.test(t.type)));
const isControl = (t) => t instanceof HTMLElement && (isTyping(t) || /^(BUTTON|A|SUMMARY)$/.test(t.tagName));

const FACE_WORD = { U: 'top', D: 'bottom', R: 'right', L: 'left', F: 'front', B: 'back' };
function describeMove(m) {
  const mod = m.slice(1);
  if (m[0] === 'y') {
    if (mod === '2') return 'turn the whole cube half way round';
    return mod === "'" ? 'turn the whole cube so the left side comes to the front'
      : 'turn the whole cube so the right side comes to the front';
  }
  const dir = mod === '2' ? 'half turn' : mod === "'" ? 'counter-clockwise' : 'clockwise';
  return `${FACE_WORD[m[0]]} face ${dir}`;
}

// Isometric cube drawing (yellow top, green front, orange right) for the logo and hints.
function isoCubeSvg() {
  const faces = [
    [[14, 29], [36, -21], [36, 21], NET_HEX.yellow],
    [[14, 29], [36, 21], [0, 42], NET_HEX.green],
    [[50, 50], [36, -21], [0, 42], NET_HEX.orange],
  ];
  let cells = '';
  for (const [o, a, b, fill] of faces) {
    const p = (u, v) => `${(o[0] + (a[0] * u + b[0] * v) / 3).toFixed(1)},${(o[1] + (a[1] * u + b[1] * v) / 3).toFixed(1)}`;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const g = 0.1;
      cells += `<polygon points="${p(i + g, j + g)} ${p(i + 1 - g, j + g)} ${p(i + 1 - g, j + 1 - g)} ${p(i + g, j + 1 - g)}" fill="${fill}"/>`;
    }
  }
  return `<svg viewBox="0 0 100 100" style="stroke:none"><polygon points="50,4.5 89.5,27.5 89.5,72.5 50,95.5 10.5,72.5 10.5,27.5" fill="#14161b" stroke="#14161b" stroke-width="3" stroke-linejoin="round"/>${cells}</svg>`;
}
document.querySelectorAll('[data-iso-cube]').forEach((n) => { n.innerHTML = isoCubeSvg(); });

// ---- Tabs ---------------------------------------------------------------------------

const TABS = ['scan', 'coach', 'practice'];
let currentTab = null;
let cube = load('rcc.cube', null); // { facelets, source, scramble }
if (!cube || !validate(cube.facelets).ok) cube = null;

function go(name) {
  if (location.hash !== `#${name}`) location.hash = name; // hashchange → showTab, and Back works
  else showTab(name);
}

function showTab(name) {
  if (!TABS.includes(name)) name = cube ? 'coach' : 'scan';
  if (name === currentTab) return;
  const prev = currentTab;
  currentTab = name;
  for (const t of TABS) {
    const on = t === name;
    const tab = $(`#tab-${t}`);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#panel-${t}`).hidden = !on;
  }
  if (prev === 'scan') scanLeave();
  if (prev === 'coach') coachLeave();
  if (prev === 'practice') practiceLeave();
  if (name === 'scan') scanEnter();
  if (name === 'coach') coachEnter();
  if (name === 'practice') practiceEnter();
  document.title = `${name[0].toUpperCase()}${name.slice(1)} · Cube Coach`;
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
// Arrow keys move between tabs, as in the ARIA tabs pattern.
$('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  e.stopPropagation();
  const i = (TABS.indexOf(currentTab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
  go(TABS[i]);
  $(`#tab-${TABS[i]}`).focus();
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

function setCube(info) {
  cube = info;
  save('rcc.cube', info);
  coachLoad(info.facelets, null);
}

function scrambledCube() {
  const moves = randomScramble(20);
  return { facelets: applyMoves(SOLVED, moves), scramble: moves.join(' ') };
}

// ---- Scan ---------------------------------------------------------------------------

const scan = { cam: null, tray: new FaceTray(), mode: null, scramble: null, running: false, starting: false, errors: [], hintUntil: 0 };
const net = new NetEditor($('#net'), { colorOf: COLOR_OF, editable: true });
net.onChange(() => { scan.errors = []; updateReview(); }); // a manual fix makes the scan's own messages stale

function scanView(v) {
  for (const n of ['intro', 'camera', 'review']) $(`#scan-${n}`).hidden = n !== v;
  if (v !== 'camera') stopCamera();
}

function scanEnter() {
  $('#resume-coach').hidden = !cube;
  // Left mid-scan (the camera was stopped): turn it back on and keep the faces captured so far.
  if (!$('#scan-camera').hidden && !scan.running && !scan.starting) startCamera({ fresh: false });
}
function scanLeave() { stopCamera(); }

// Stops the stream and the detection loop (AutoCamera.stop cancels its animation frame).
function stopCamera() {
  if (scan.running) scan.cam.stop();
  scan.running = false;
}

async function startCamera({ fresh = true } = {}) {
  $('#cam-error').hidden = true;
  if (fresh) scan.tray.clear();
  scanView('camera');
  renderTray();
  setHint('Looking for a cube face…');
  if (scan.starting) return; // a start is still pending; it picks this view up when it resolves
  scan.cam ??= new AutoCamera({
    video: $('#cam-video'),
    overlay: $('#cam-overlay'),
    hooks: { onStatus: onScanStatus, onCapture },
  });
  scan.cam.tracker.reset();
  const btn = $('#cam-capture');
  btn.disabled = true;
  btn.textContent = 'Starting camera…';
  scan.starting = true;
  try {
    await scan.cam.start();
    scan.starting = false;
    if ($('#scan-camera').hidden || currentTab !== 'scan') { scan.cam.stop(); return; } // cancelled or left while starting
    scan.running = true;
    btn.disabled = false;
    btn.textContent = 'Capture now';
  } catch (e) {
    scan.starting = false;
    scan.cam.stop();
    scanView('intro');
    const box = $('#cam-error');
    box.textContent = e.message;
    box.hidden = false;
  }
}

// ---- Scan: hint line, color dots and the tray of captured sides

const titleCase = (name) => name[0].toUpperCase() + name.slice(1);

function setHint(text) { $('#cam-hint').textContent = text; }

function onScanStatus({ phase, progress }) {
  if (performance.now() < scan.hintUntil) return; // a capture message is still showing
  if (phase === 'holding' && progress > 0) setHint('Hold steady…');
  else if (phase === 'held') setHint('Got it. Show another side.');
  else setHint(scan.tray.count === 6 ? 'All six sides captured.' : 'Looking for a cube face…');
}

function renderTray() {
  const { tray } = scan;
  const have = tray.slots.map((s) => s.name);
  $('#scan-dots').replaceChildren(...COLOR_NAMES.map((name) => {
    const got = have.includes(name);
    const dot = el('li', { class: got ? 'done' : '', 'aria-label': `${titleCase(name)} ${got ? 'captured' : 'not captured yet'}` });
    dot.style.setProperty('--dot', NET_HEX[name]);
    return dot;
  }));
  $('#scan-instr').textContent = tray.count === 6
    ? 'All six sides captured.'
    : tray.count === 0 ? 'Any order. Keep white on the bottom when you can.'
      : `${tray.count} of 6 sides. Any order, white on the bottom if you can.`;
  const items = tray.slots.map((slot, i) => {
    const b = el('button', {
      type: 'button',
      class: 'tray-slot',
      'aria-label': `${titleCase(slot.name)} side captured. Tap to retake it.`,
      onclick: () => retakeFace(i),
    }, el('img', { src: slot.capture.thumb || '', alt: '' }), el('span', { class: 'tray-dot' }));
    b.style.setProperty('--dot', NET_HEX[slot.name]);
    return el('li', {}, b);
  });
  while (items.length < 6) items.push(el('li', {}, el('span', { class: 'tray-slot empty', 'aria-hidden': 'true' })));
  $('#tray').replaceChildren(...items);
}

function retakeFace(i) {
  const name = scan.tray.slots[i]?.name;
  if (!name) return;
  scan.tray.remove(i);
  scan.cam?.tracker.reset(); // so a side still in view can be captured again straight away
  renderTray();
  setHint(`Show the ${name} side again.`);
  announce(`${titleCase(name)} side removed. Show it to the camera again.`);
}

function flash() {
  const f = $('#cam-flash');
  f.classList.remove('go');
  void f.offsetWidth; // restart the animation
  f.classList.add('go');
}

// A face was captured, automatically or by the Capture now button.
function onCapture(capture, { manual = false } = {}) {
  const e = scan.tray.offer(capture, { force: manual });
  const title = titleCase(e.name);
  const msg = e.kind === 'kept' ? `Already have the ${e.name} side. Show a different one.`
    : e.kind === 'replaced' ? `${title} side updated.`
      : `${title} side captured (${scan.tray.count} of 6).`;
  if (e.kind !== 'kept') flash();
  setHint(msg);
  scan.hintUntil = performance.now() + 1200;
  announce(msg);
  renderTray();
  if (scan.tray.count === 6) setTimeout(finishScan, 700); // let the last capture register
}

// Six faces are in: read the colors, work out which is which and how each is turned, then hand
// the result to the review net (with doubtful stickers flagged and any problems spelled out).
function finishScan() {
  if (scan.tray.count < 6 || $('#scan-camera').hidden) return;
  stopCamera();
  const res = buildCube(scan.tray.captures());
  scan.errors = res.ok ? [] : res.errors;
  openReview('camera', res.facelets, res.flags);
}

const REVIEW_COPY = {
  camera: ['Check the colors', 'Compare the net with your cube and tap any sticker that is wrong to change it. Pink outlines mark stickers the camera was unsure about.'],
  manual: ['Enter your colors', 'Hold your cube with white on the bottom and green facing you. Tap each sticker to cycle its color (white, yellow, green, blue, red, orange) until the net matches your cube.'],
  scramble: ['Scramble your cube', 'Start from a solved cube held white bottom, green front, and make these moves. The net shows how it should look afterwards.'],
};

function openReview(mode, facelets, flags = []) {
  scan.mode = mode;
  const [title, lead] = REVIEW_COPY[mode];
  $('#review-title').textContent = title;
  $('#review-lead').textContent = lead;
  $('#review-scramble').hidden = mode !== 'scramble';
  if (mode === 'scramble') $('#review-scramble-text').textContent = scan.scramble;
  net.setState(facelets);
  net.setFlags(flags);
  scanView('review');
  updateReview();
  window.scrollTo(0, 0);
}

function newScrambleReview() {
  const s = scrambledCube();
  scan.scramble = s.scramble;
  openReview('scramble', s.facelets);
}

// Turn validate()'s messages into something a beginner can act on.
const COLOR_WORD = (letter) => COLOR_OF[letter] ?? letter;
function posWords(p) {
  const [x, y, z] = p.split(',').map(Number);
  return [y > 0 ? 'top' : y < 0 ? 'bottom' : '', z > 0 ? 'front' : z < 0 ? 'back' : '', x > 0 ? 'right' : x < 0 ? 'left' : '']
    .filter(Boolean).join('-');
}
function humanize(msg) {
  let m = /Color of the (\w) center appears (\d+) times/.exec(msg);
  if (m) return `There are ${m[2]} ${COLOR_WORD(m[1])} stickers, but a cube has exactly 9 of each color.`;
  m = /Corner at ([-\d,]+) has colors (\w+)/.exec(msg);
  if (m) return `The ${posWords(m[1])} corner reads as ${[...m[2]].map(COLOR_WORD).join('-')}, and no real corner has those colors. Check its stickers.`;
  m = /Edge at ([-\d,]+) has colors (\w+)/.exec(msg);
  if (m) return `The ${posWords(m[1])} edge reads as ${[...m[2]].map(COLOR_WORD).join('-')}, and no real edge has those colors. Check its stickers.`;
  return msg;
}

function updateReview() {
  const v = validate(net.getState());
  const status = $('#review-status');
  status.className = `status ${v.ok ? 'ok' : 'bad'}`;
  status.textContent = v.ok ? 'This is a valid cube. Ready when you are.' : 'This cube can’t exist yet. Here is what to check:';
  // Problems the scan itself found (missing or repeated colors, faces that don't fit) come first.
  const scanErrors = scan.mode === 'camera' && !v.ok ? scan.errors : [];
  $('#review-errors').replaceChildren(...(v.ok ? [] : [...scanErrors, ...v.errors.map(humanize)].map((e) => el('li', {}, e))));
  $('#coach-go').disabled = !v.ok;
}

$('#cam-start').addEventListener('click', () => startCamera());
$('#cam-capture').addEventListener('click', () => {
  try { scan.cam.captureNow(); } catch (e) { announce(e.message); }
});
$('#cam-cancel').addEventListener('click', () => scanView('intro'));
$('#manual-start').addEventListener('click', () => openReview('manual', SOLVED));
$('#scramble-start').addEventListener('click', newScrambleReview);
$('#review-new-scramble').addEventListener('click', newScrambleReview);
$('#review-back').addEventListener('click', () => scanView('intro'));
$('#resume-coach').addEventListener('click', () => go('coach'));
$('#coach-go').addEventListener('click', () => {
  const facelets = net.getState();
  if (!validate(facelets).ok) return;
  setCube({ facelets, source: scan.mode, scramble: scan.mode === 'scramble' ? scan.scramble : null });
  go('coach');
});
$('#empty-scramble').addEventListener('click', () => { go('scan'); newScrambleReview(); });

// ---- Coach --------------------------------------------------------------------------

const SPEEDS = [0.5, 1, 2];
const coach = {
  start: null, res: null, flat: [], pos: 0, applied: 0,
  playing: false, token: 0, shownStage: -1, wasDone: false,
  viewer: null, viewerP: null, speed: load('rcc.speed', 1),
};
if (!SPEEDS.includes(coach.speed)) coach.speed = 1;

// Unique labels let us follow stickers through moves with cube.js alone.
const LABELS = Array.from({ length: 54 }, (_, i) => String.fromCharCode(0x100 + i)).join('');

function coachLoad(facelets, restore) {
  const res = solveBeginner(facelets);
  coach.token++;
  coach.playing = false;
  coach.start = res.ok ? facelets : null;
  coach.res = res.ok ? res : null;
  coach.flat = [];
  let before = facelets;
  if (res.ok) {
    res.stages.forEach((stage, si) => stage.steps.forEach((step, ti) => {
      coach.flat.push({ si, ti, stage, step, before });
      before = step.after;
    }));
  }
  coach.end = before;
  const pos = restore?.start === facelets ? restore.pos : 0;
  coach.pos = Number.isInteger(pos) && pos >= 0 && pos <= coach.flat.length ? pos : 0;
  const n = coach.flat[coach.pos]?.step.moves.length ?? 0;
  coach.applied = restore?.start === facelets && restore.applied >= 0 && restore.applied <= n ? restore.applied : 0;
  coach.shownStage = -1;
  coach.wasDone = coach.pos >= coach.flat.length;
  if (res.ok) saveCoach();
  else console.warn('Could not coach this cube:', res.error);
  syncViewer();
  if (currentTab === 'coach') renderCoach();
}

const saveCoach = () => save('rcc.coach', { start: coach.start, pos: coach.pos, applied: coach.applied });
const entry = () => coach.flat[coach.pos];
const isDone = () => coach.pos >= coach.flat.length;

function stateNow() {
  const e = entry();
  return e ? applyMoves(e.before, e.step.moves.slice(0, coach.applied)) : coach.end;
}

// The solver highlights pieces where they end up; map them back to where they are now.
function highlightNow() {
  const e = entry();
  if (!e?.step.highlight?.length) return null;
  const { moves, highlight } = e.step;
  const end = applyMoves(LABELS, moves);
  const now = applyMoves(LABELS, moves.slice(0, coach.applied));
  return highlight.map((j) => now.indexOf(end[j]));
}

// Fallback when WebGL is unavailable: the flat net, flagged stickers instead of dimming.
class FlatViewer {
  constructor(container) {
    container.classList.add('flat-viewer');
    this.net = new NetEditor(container, { colorOf: COLOR_OF, editable: false });
    this.state = SOLVED;
    this.gen = 0;
  }
  setState(f) { this.stop(); this.state = f; this.net.setState(f); }
  async play(moves, { speed = 1, onMove } = {}) {
    const gen = this.gen;
    for (const [i, m] of parseMoves(moves).entries()) {
      await wait(250 / speed);
      if (gen !== this.gen) return;
      this.state = applyMove(this.state, m);
      this.net.setState(this.state);
      onMove?.(m, i, this.state);
    }
  }
  stop() { this.gen++; }
  setHint() {}
  setHighlight(ix) { this.net.setFlags(ix || []); }
  resetView() {}
}

async function makeViewer(container, opts) {
  try {
    const { CubeViewer } = await import('./viewer3d.js');
    return new CubeViewer(container, opts);
  } catch (err) {
    console.warn('3D view unavailable, using the flat net instead:', err);
    container.replaceChildren();
    return new FlatViewer(container);
  }
}

function ensureViewer() {
  coach.viewerP ??= makeViewer($('#viewer'), { colorOf: COLOR_OF }).then((v) => {
    coach.viewer = v;
    syncViewer();
    return v;
  });
  return coach.viewerP;
}

function syncViewer() {
  const v = coach.viewer;
  if (!v || !coach.start) return;
  v.setState(stateNow());
  v.setHint(null);
  v.setHighlight(isDone() ? null : highlightNow());
}

function coachEnter() {
  if (!coach.start && cube) coachLoad(cube.facelets, load('rcc.coach', null));
  ensureViewer();
  renderCoach();
}
function coachLeave() { cancelPlay(); }

// Stop whatever is animating and snap the view to the logical position.
function cancelPlay() {
  coach.token++;
  if (coach.playing) {
    coach.playing = false;
    coach.viewer?.stop();
  }
  coach.viewer?.setHint(null);
}

function goStep(pos) {
  cancelPlay();
  coach.pos = Math.max(0, Math.min(coach.flat.length, pos));
  coach.applied = 0;
  saveCoach();
  syncViewer();
  renderCoach();
  const e = entry();
  if (e) announce(`${e.stage.title}, step ${e.ti + 1} of ${e.stage.steps.length}.`);
}

const next = () => { if (coach.start && !isDone()) goStep(coach.pos + 1); };
const back = () => { if (coach.start && coach.pos > 0) goStep(coach.pos - 1); };

// Animate moves [from, to) of the current step: arrow first, then the turn.
async function playRange(from, to) {
  const e = entry();
  if (!e) return;
  const viewer = await ensureViewer();
  cancelPlay();
  const token = coach.token;
  const moves = e.step.moves;
  coach.applied = from;
  syncViewer(); // also undoes a turn that stop() may have just finished
  coach.playing = true;
  renderControls();
  while (coach.applied < to && token === coach.token) {
    const k = coach.applied;
    const mv = moves[k];
    viewer.setHint(mv);
    renderChips();
    announce(`Move ${k + 1} of ${moves.length}: ${mv}, ${describeMove(mv)}.`);
    await wait(reducedMotion() ? 700 / coach.speed : 450 / coach.speed);
    if (token !== coach.token) return;
    await viewer.play([mv], { speed: coach.speed });
    if (token !== coach.token) return;
    coach.applied = k + 1;
    viewer.setHighlight(highlightNow());
    saveCoach();
    if (reducedMotion()) await wait(250 / coach.speed);
  }
  if (token !== coach.token) return;
  coach.playing = false;
  viewer.setHint(null);
  renderChips();
  renderControls();
}

function togglePlay() {
  const e = entry();
  if (!e || !e.step.moves.length) return;
  if (coach.playing) {
    cancelPlay();
    syncViewer(); // drop the half-finished turn; the chips show where we are
    renderChips();
    renderControls();
    return;
  }
  const n = e.step.moves.length;
  playRange(coach.applied >= n ? 0 : coach.applied, n);
}

function renderCoach() {
  const has = !!coach.start;
  $('#coach-empty').hidden = has;
  $('#coach-main').hidden = !has;
  if (!has) return;
  const done = isDone();
  const e = entry();
  const si = done ? STAGES.length : e.si;

  $('#stage-strip').replaceChildren(...STAGES.map((s, i) => {
    const state = i < si ? 'done' : i === si ? 'current' : '';
    return el('li', {}, el('button', {
      type: 'button', class: state,
      'aria-label': `Stage ${i + 1}: ${s.title}${i < si ? ', done' : i === si ? ', current' : ''}`,
      'aria-current': i === si ? 'step' : null,
      onclick: () => goStep(coach.flat.findIndex((f) => f.si === i)),
    }, el('span', { class: 'n' }, i < si ? '✓' : String(i + 1)), el('span', { class: 't' }, s.title)));
  }));

  $('#step-card').hidden = done;
  $('#lesson').hidden = done;
  $('#celebrate').hidden = !done;
  if (done) {
    renderCelebrate(!coach.wasDone);
    coach.wasDone = true;
    coach.viewer?.setHighlight(null);
    return;
  }
  coach.wasDone = false;

  const stage = coach.res.stages[si];
  if (si !== coach.shownStage) {
    renderLesson(stage);
    $('#lesson').open = true; // a new stage opens its lesson; the user may fold it away
    coach.shownStage = si;
  }
  $('#step-eyebrow').textContent = `Stage ${si + 1} of ${STAGES.length} · Step ${e.ti + 1} of ${stage.steps.length}`;
  $('#stage-title').textContent = stage.title;
  const stageEmpty = stage.steps.every((s) => !s.moves.length);
  const badge = $('#step-badge');
  badge.hidden = e.step.moves.length > 0;
  badge.textContent = stageEmpty ? 'Already done — nice!' : 'Already in place — nice!';
  $('#step-explain').textContent = e.step.explain;
  renderChips();
  renderControls();
}

function renderChips() {
  const e = entry();
  if (!e) return;
  const { moves } = e.step;
  const box = $('#chips');
  box.hidden = !moves.length;
  box.replaceChildren(...moves.map((m, k) => el('button', {
    type: 'button',
    class: `chip${k < coach.applied ? ' done' : ''}${k === coach.applied ? ' current' : ''}${m[0] === 'y' ? ' whole' : ''}`,
    'aria-label': `Move ${k + 1}: ${m}, ${describeMove(m)}${k < coach.applied ? ', done' : ''}`,
    'aria-current': k === coach.applied ? 'step' : null,
    title: 'Play this move',
    onclick: () => playRange(k, k + 1),
  }, m)));
  const cap = $('#move-caption');
  if (!moves.length) cap.textContent = 'Nothing to turn here. Tap Next step.';
  else if (coach.applied >= moves.length) cap.textContent = 'Step done. Your cube should match the 3D view. Tap Next step.';
  else {
    const m = moves[coach.applied];
    cap.replaceChildren(coach.playing ? 'Now: ' : 'Next: ', el('b', {}, m), ` — ${describeMove(m)}`);
  }
}

function renderControls() {
  const e = entry();
  if (!e) return;
  const n = e.step.moves.length;
  $('#btn-back').disabled = coach.pos === 0;
  const play = $('#btn-play');
  play.disabled = n === 0;
  $('#play-label').textContent = coach.playing ? 'Pause' : coach.applied >= n && n ? 'Replay' : coach.applied > 0 ? 'Resume' : 'Play step';
  $('#play-icon').innerHTML = coach.playing ? '<path d="M8 5v14M16 5v14"/>' : '<path d="M7 5v14l12-7L7 5Z"/>';
  $('#next-label').textContent = coach.pos === coach.flat.length - 1 ? 'Finish' : 'Next step';
  // After a step has played (or there is nothing to play), Next is the obvious action.
  $('#btn-next').classList.toggle('primary', n === 0 || coach.applied >= n);
  play.classList.toggle('primary', !(n === 0 || coach.applied >= n));
}

function renderLesson(stage) {
  const l = LESSONS[stage.id];
  $('#lesson-summary').textContent = `How “${stage.title}” works`;
  if (!l) { $('#lesson-body').replaceChildren(); return; }
  $('#lesson-body').replaceChildren(
    el('p', {}, el('strong', {}, 'Goal: '), l.goal),
    el('p', {}, el('strong', {}, 'Look for: '), l.recognize),
    ...l.algorithms.map((a) => el('div', { class: 'alg' },
      el('span', { class: 'alg-name' }, a.name),
      el('span', { class: 'alg-moves' }, a.moves),
      el('span', { class: 'alg-when' }, a.when))),
    l.tips?.[1] ? el('p', { class: 'small' }, l.tips[1]) : null,
  );
}

function renderCelebrate(burst) {
  const total = coach.res.moves.length;
  const turns = coach.res.moves.filter((m) => m[0] !== 'y').length;
  $('#celebrate-text').textContent = !turns ? 'This cube was already solved. Scramble it and let the coach walk you back!'
    : `That was ${turns} face turns (plus ${total - turns} whole-cube turns) across seven stages. `
      + 'Beginners usually take a few minutes. With practice the same method gets under a minute.';
  const box = $('#confetti');
  box.replaceChildren();
  if (!burst || reducedMotion()) return;
  const colors = Object.values(NET_HEX);
  for (let i = 0; i < 36; i++) {
    const c = el('i', {});
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
    c.style.animationDelay = `${Math.random() * 0.4}s`;
    box.append(c);
  }
  announce('Solved! Nice work.');
}

$('#speed').replaceChildren(...SPEEDS.map((s) => el('button', {
  type: 'button', 'aria-pressed': String(s === coach.speed), 'data-speed': s,
  onclick: () => {
    coach.speed = s;
    save('rcc.speed', s);
    document.querySelectorAll('#speed button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s)));
  },
}, `${s}×`)));
$('#btn-next').addEventListener('click', next);
$('#btn-back').addEventListener('click', back);
$('#btn-play').addEventListener('click', togglePlay);
$('#view-reset').addEventListener('click', () => coach.viewer?.resetView?.());
$('#celebrate-restart').addEventListener('click', () => goStep(0));

function coachKey(e) {
  if (!coach.start || isTyping(e.target)) return;
  if (e.key === 'ArrowRight' || (e.key === ' ' && !isControl(e.target))) { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePlay(); }
}

// ---- Practice -----------------------------------------------------------------------

const practice = {
  timer: new Timer({ inspection: load('rcc.inspection', true) !== false }),
  history: new History(storage),
  scramble: scrambleForPractice(),
  raf: 0,
  last: 'idle',
  swallowClick: false,
};
const LIVE_STATES = new Set(['inspecting', 'holding', 'ready', 'running']);
const timerArea = $('#timer-area');

function practiceEnter() {
  renderScramble();
  renderTimer();
  renderHistory();
}
function practiceLeave() {
  const t = practice.timer;
  if (t.state === 'running') { t.press(); renderTimer(); } // leaving mid-solve still records it
  else if (LIVE_STATES.has(t.state)) { t.reset(); renderTimer(); }
}

function renderScramble() { $('#scramble-text').textContent = practice.scramble; }
function newScramble() { practice.scramble = scrambleForPractice(); renderScramble(); }

const HINTS = {
  idle: (insp) => (insp ? 'Tap here or press space to start inspection.' : 'Hold space, or touch and hold here. Release to start.'),
  inspecting: () => 'Inspect the cube. Then hold space, or touch and hold, until the time turns green.',
  holding: () => 'Keep holding…',
  ready: () => 'Release to start!',
  running: () => 'Tap anywhere or press any key to stop.',
  stopped: (insp) => (insp ? 'Tap or press space for the next solve.' : 'Hold space, or touch and hold, for the next solve.'),
};

function renderTimer() {
  const t = practice.timer;
  const r = t.tick();
  $('#timer-display').textContent = r.display;
  timerArea.dataset.state = r.state;
  $('#timer-penalty').textContent = r.state === 'stopped' ? (r.penalty === '+2' ? '+2 penalty (over 15 s inspection)' : r.penalty === 'DNF' ? 'Inspection over 17 s' : '')
    : r.penalty === '+2' ? (r.state === 'running' ? '+2 penalty (over 15 s inspection)' : '+2 if you start now') : '';
  $('#timer-hint').textContent = HINTS[r.state](t.inspection);
  document.body.classList.toggle('timing', LIVE_STATES.has(r.state));
  if (r.state === 'stopped' && practice.last !== 'stopped') record(r.display);
  practice.last = r.state;
  if (LIVE_STATES.has(r.state) && !practice.raf) practice.raf = requestAnimationFrame(() => { practice.raf = 0; renderTimer(); });
}

function record(display) {
  const res = practice.timer.result();
  if (!res) return;
  practice.history.add({ ms: Math.round(res.ms), penalty: res.penalty, scramble: practice.scramble });
  announce(`Time: ${display === 'DNF' ? 'DNF' : display}.`);
  newScramble();
  renderHistory();
}

const fmt = (v) => (v === null || v === undefined ? '—' : formatTime(v));

function renderHistory() {
  const all = practice.history.all();
  const s = stats(all);
  $('#stats').replaceChildren(...[['Best', fmt(s.best)], ['ao5', fmt(s.ao5)], ['ao12', fmt(s.ao12)], ['Solves', String(s.count)]]
    .map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
  $('#history-empty').hidden = all.length > 0;
  $('#history-clear').hidden = all.length === 0;
  const items = all.map((solve, i) => {
    const time = solve.penalty === 'DNF' ? 'DNF' : formatTime(solve.ms + (solve.penalty === '+2' ? 2000 : 0)) + (solve.penalty === '+2' ? '+' : '');
    const toggle = (p) => { practice.history.setPenalty(i, solve.penalty === p ? null : p); renderHistory(); };
    return el('li', {},
      el('span', { class: 'h-n' }, `${i + 1}.`),
      el('span', { class: 'h-main' }, el('span', { class: 'h-time' }, time), el('span', { class: 'h-scr', title: solve.scramble || '' }, solve.scramble || '')),
      el('span', { class: 'h-actions' },
        el('button', { type: 'button', 'aria-pressed': String(solve.penalty === '+2'), 'aria-label': `Plus 2 penalty on solve ${i + 1}`, onclick: () => toggle('+2') }, '+2'),
        el('button', { type: 'button', 'aria-pressed': String(solve.penalty === 'DNF'), 'aria-label': `Did not finish, solve ${i + 1}`, onclick: () => toggle('DNF') }, 'DNF'),
        el('button', {
          type: 'button', 'aria-label': `Delete solve ${i + 1}`,
          onclick: () => { practice.history.remove(i); renderHistory(); announce(`Solve ${i + 1} deleted.`); },
        }, svgIcon('M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3'))));
  });
  $('#history').replaceChildren(...items.reverse()); // newest first
}

function svgIcon(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="${d}"/>`;
  return s;
}

function press() { practice.timer.press(); renderTimer(); }
function release() {
  const s = practice.timer.state;
  if (s === 'holding' || s === 'ready') { practice.timer.release(); renderTimer(); }
}

function practiceKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || $('#notation').open) return;
  const t = practice.timer;
  if (t.state === 'running') { // any key stops
    e.preventDefault();
    if (!e.repeat) press();
    return;
  }
  if (e.key === ' ') {
    e.preventDefault(); // space is the timer key here, not "click the focused button"
    if (!e.repeat) press();
  } else if (e.key === 'Escape' && LIVE_STATES.has(t.state)) {
    t.reset();
    renderTimer();
  }
}

timerArea.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault();
  press();
});
// A live attempt owns the whole screen: the first tap anywhere stops a running timer.
document.addEventListener('pointerdown', (e) => {
  if (currentTab !== 'practice' || practice.timer.state !== 'running') return;
  e.preventDefault();
  e.stopPropagation();
  practice.swallowClick = true;
  setTimeout(() => { practice.swallowClick = false; }, 800); // in case no click follows
  press();
}, true);
document.addEventListener('click', (e) => {
  if (!practice.swallowClick) return;
  practice.swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);
window.addEventListener('pointerup', () => { if (currentTab === 'practice') release(); });
window.addEventListener('pointercancel', () => { if (currentTab === 'practice') release(); });
timerArea.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu on phones

const insp = $('#inspection-toggle');
insp.checked = practice.timer.inspection;
insp.addEventListener('change', () => {
  practice.timer.inspection = insp.checked;
  practice.timer.reset();
  save('rcc.inspection', insp.checked);
  renderTimer();
});
$('#new-scramble').addEventListener('click', newScramble);
$('#scramble-coach').addEventListener('click', () => {
  setCube({ facelets: applyMoves(SOLVED, practice.scramble), source: 'scramble', scramble: practice.scramble });
  go('coach');
});
$('#history-clear').addEventListener('click', () => {
  if (confirm('Delete all your saved solves?')) { practice.history.clear(); renderHistory(); }
});

$('#roadmap').replaceChildren(...ROADMAP.map((r) => el('li', {}, el('div', {}, el('b', {}, r.milestone), el('span', {}, r.how)))));
$('#speed-tips').replaceChildren(...STAGES.filter((s) => LESSONS[s.id]?.speedTips?.length).map((s) => el('details', { class: 'tips' },
  el('summary', {}, s.title),
  el('ul', {}, LESSONS[s.id].speedTips.map((t) => el('li', {}, t))))));

// ---- Global keys --------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if ($('#notation').open) return;
  if (currentTab === 'coach') coachKey(e);
  else if (currentTab === 'practice') practiceKeyDown(e);
});
document.addEventListener('keyup', (e) => {
  if (currentTab !== 'practice' || e.key !== ' ' || isTyping(e.target)) return;
  e.preventDefault(); // keeps space from also "clicking" a focused button
  release();
});

// ---- Notation sheet -----------------------------------------------------------------

const sheet = $('#notation');
const demo = { viewer: null, token: 0, loading: false };

$('#notation-list').replaceChildren(...NOTATION.map((n) => el('li', {},
  el('button', { type: 'button', class: 'chip', 'aria-label': `Show ${n.move}`, onclick: () => showDemo(n.move) }, n.move),
  el('p', {}, n.description))));

async function showDemo(move) {
  const token = ++demo.token;
  const v = demo.viewer;
  if (!v) return;
  v.setState(SOLVED);
  v.setHint(move);
  announce(`${move}: ${describeMove(move)}.`);
  await wait(500);
  if (token !== demo.token || demo.viewer !== v) return;
  await v.play([move], { speed: 0.6 });
  if (token === demo.token) v.setHint(null);
}

$('#notation-open').addEventListener('click', async () => {
  cancelPlay();
  sheet.showModal();
  if (demo.viewer || demo.loading) return;
  demo.loading = true;
  const v = await makeViewer($('#demo-viewer'), { colorOf: COLOR_OF });
  demo.loading = false;
  if (sheet.open) demo.viewer = v;
  else { v.dispose?.(); $('#demo-viewer').replaceChildren(); } // closed while loading
});
function closeSheet() { sheet.close(); }
sheet.addEventListener('close', () => {
  demo.token++;
  demo.viewer?.dispose?.(); // free the second WebGL context
  demo.viewer = null;
  $('#demo-viewer').replaceChildren();
});
$('#notation-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => { // a tap on the backdrop (outside the sheet's box) closes it
  if (e.target !== sheet) return;
  const r = sheet.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet();
});

// ---- Start ---------------------------------------------------------------------------

showTab(location.hash.slice(1));
