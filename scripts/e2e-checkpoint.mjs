#!/usr/bin/env node
// Headless-Chromium check of the coach's camera checkpoints (local tool, not part of `npm test`).
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM_PATH=/path/to/chrome \
//     node scripts/e2e-checkpoint.mjs [--shots dir]
//
// It serves the repo on a random port, opens the Coach on a scrambled cube, and replaces getUserMedia
// with a canvas stream that draws whatever face the script sets (test/facesynth.js renders it as a
// camera would see it). Then it walks through the flow a beginner would see:
//   ok banner  ->  Next step  ->  a single mistake (wrong last move)  ->  Show fix  ->  Auto-check
//   ->  camera off when leaving the tab / hiding the page  ->  one camera at a time  ->  no console errors.
// Screenshots (390x844): check-ok.png and check-mistake.png in --shots (default ./shots).
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SOLVED, COLOR_OF, applyMoves, invertMove, moveInfo } from '../src/cube.js';
import { solveBeginner } from '../src/solver.js';
import { diagnose, expectedFront, expectedTop } from '../src/checkpoint.js';
import { mulberry32 } from '../test/facesynth.js';
import { randomScramble } from '../src/cube.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : 'shots';
const { chromium } = process.env.PLAYWRIGHT_CORE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE) : await import('playwright-core');
await mkdir(shotsDir, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) throw new Error('outside root');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// ---- The scenario: a scrambled cube, a coach step with several moves, one slip to try -----------------

const rand = mulberry32(8675309);
const front = (f) => expectedFront(f);
let scenario = null;
for (let tries = 0; tries < 60 && !scenario; tries++) {
  const facelets = applyMoves(SOLVED, randomScramble(22, rand));
  const res = solveBeginner(facelets);
  let before = facelets, pos = 0;
  const flat = [];
  for (const st of res.stages) for (const step of st.steps) { flat.push({ before, step }); before = step.after; }
  flat.forEach((f, i) => {
    if (scenario || i < 2 || i + 2 >= flat.length || f.step.moves.length < 3 || f.step.moves.some((m) => m[0] === 'y')) return;
    const { moves, after } = f.step;
    // The slip: the last move turned the wrong way. It must be recognisable from the front, unambiguously.
    const last = moves[moves.length - 1];
    if (moveInfo(last).turns === 2) return;
    const wrong = applyMoves(f.before, [...moves.slice(0, -1), invertMove(last)]);
    const d = diagnose(f.before, moves, front(wrong));
    if (d.verdict !== 'mistake' || d.ambiguous || applyMoves(wrong, d.fixMoves) !== after) return;
    // and the very next step must also be checkable, for the Auto-check part
    const nx = flat[i + 1];
    if (!nx.step.moves.length || nx.step.moves.some((m) => m[0] === 'y')) return;
    scenario = { facelets, pos: i, moves, before: f.before, after, wrong, fix: d.fixMoves, next: nx, message: d.message };
  });
}
if (!scenario) throw new Error('no suitable coach step found');
console.log(`scenario: step ${scenario.pos + 1}, moves ${scenario.moves.join(' ')}, slip -> "${scenario.message}"`);

// ---- Browser --------------------------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

// Mock camera: a canvas stream drawing the face the script sets (or an empty scene). Counts live streams.
await page.addInitScript(() => {
  const W = 360, H = 480;
  window.__streams = [];
  window.__maxLive = 0;
  window.__face = null;
  let variants = [], empty = null, renderFrame = null;
  window.__setFace = async (names) => {
    renderFrame ??= (await import('/test/facesynth.js')).renderFrame;
    empty ??= renderFrame({ width: W, height: H, seed: 9, bg: 'couch', noise: 3, cube: null }).img;
    variants = names ? Array.from({ length: 4 }, (_, k) => renderFrame({
      width: W, height: H, seed: 300 + k, bg: 'couch', noise: 3,
      cube: { cx: 178 + k, cy: 240 - k, size: 230, angle: -4 + k, names, gapFrac: 0.06, logo: true, hand: true, gain: 0.95, cast: [1.02, 1, 0.97] },
    }).img) : [];
    window.__face = names;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const live = window.__streams.filter((s) => s.getTracks().some((t) => t.readyState === 'live')).length;
    window.__maxLive = Math.max(window.__maxLive, live + 1);
    await window.__setFace(window.__face ?? null);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const c2 = canvas.getContext('2d');
    const draw = () => {
      const img = variants.length ? variants[Math.floor(performance.now() / 90) % variants.length] : empty;
      c2.putImageData(new ImageData(img.data, W, H), 0, 0);
    };
    draw();
    setInterval(draw, 66);
    const stream = canvas.captureStream(15);
    window.__streams.push(stream);
    return stream;
  };
});

const setFace = (names) => page.evaluate((n) => window.__setFace(n), names);
const verdict = () => page.evaluate(() => ({ kind: document.querySelector('#check-verdict').dataset.kind, title: document.querySelector('#v-title').textContent, text: document.querySelector('#v-text').textContent, stale: document.querySelector('#check-verdict').dataset.stale }));
const waitVerdict = async (kind, timeout = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await verdict();
    if (v.kind === kind && v.stale !== 'true') return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for a "${kind}" verdict (last: ${JSON.stringify(v)})`);
    await page.waitForTimeout(100);
  }
};
const liveStreams = () => page.evaluate(() => window.__streams.filter((s) => s.getTracks().some((t) => t.readyState === 'live')).length);
const camOn = () => page.evaluate(() => !!document.querySelector('#check-video')?.srcObject);
const eyebrow = () => page.evaluate(() => document.querySelector('#step-eyebrow').textContent);
const results = [];
const expect = (name, cond, extra = '') => { results.push(cond); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };

await page.goto(url);
await page.evaluate(({ s }) => {
  localStorage.setItem('rcc.cube', JSON.stringify({ facelets: s.facelets, source: 'scramble', scramble: 'x' }));
  localStorage.setItem('rcc.coach', JSON.stringify({ start: s.facelets, pos: s.pos, applied: 0 }));
}, { s: scenario });
await page.goto(`${url}#coach`);
await page.reload();
await page.waitForSelector('#coach-main:not([hidden])');
await setFace(null);

const startEyebrow = await eyebrow();
console.log('coach step:', startEyebrow);
expect('camera stays off until asked', !(await camOn()));

// 1. Matches
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('#check-open');
await page.waitForSelector('#check-panel:not([hidden])');
await page.waitForTimeout(400);
console.log('after opening: scrollY', await page.evaluate(() => Math.round(window.scrollY)));
expect('panel is compact (about 40% of the dock)', await page.evaluate(() => {
  const cam = document.querySelector('.check-cam').getBoundingClientRect(), dock = document.querySelector('#dock').getBoundingClientRect();
  return cam.width / dock.width > 0.3 && cam.width / dock.width < 0.46;
}));
await setFace(front(scenario.after));
let v = await waitVerdict('ok');
expect('ok banner: "Matches — nice!"', v.title === 'Matches — nice!', v.title);
expect('ok offers Next step', (await page.locator('#check-actions button', { hasText: 'Next step' }).count()) === 1);
expect('verdict region is aria-live', (await page.getAttribute('#check-verdict', 'aria-live')) === 'polite');
await page.waitForTimeout(300);
await page.screenshot({ path: join(shotsDir, 'check-ok.png') });
console.log('screenshot', join(shotsDir, 'check-ok.png'));

// layout: no horizontal scroll, chips not covered by the dock, tap targets 44px+
const layout = await page.evaluate(() => {
  const dock = document.querySelector('#dock').getBoundingClientRect();
  const chips = document.querySelector('#chips').getBoundingClientRect();
  const small = [...document.querySelectorAll('#check-panel button, #check-open, #auto-switch, .controls .btn')].filter((b) => b.offsetParent).filter((b) => { const r = b.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map((b) => b.id || b.textContent.trim());
  const vw = document.querySelector('#viewer').getBoundingClientRect();
  return { scrollY: Math.round(window.scrollY), viewer: [Math.round(vw.top), Math.round(vw.bottom)], dock: [Math.round(dock.top), Math.round(dock.bottom)], scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, chipsBottom: chips.bottom, dockTop: dock.top, small };
});
expect('no horizontal scroll at 390px', layout.scrollW <= layout.innerW, `${layout.scrollW} <= ${layout.innerW}`);
expect('dock does not cover the move chips', layout.chipsBottom <= layout.dockTop + 1, `chips end ${Math.round(layout.chipsBottom)}, dock starts ${Math.round(layout.dockTop)}`);
expect('buttons are at least 44px', layout.small.length === 0, layout.small.join(', '));
console.log('layout', JSON.stringify(layout));

await page.click('#check-actions button:has-text("Next step")');
expect('Next step advances', (await eyebrow()) !== startEyebrow);
expect('camera stays on across steps', (await camOn()) && (await liveStreams()) === 1);

// 2. A mistake, and its fix
await setFace(null); // hands away: nothing on camera while we go back
await page.click('#btn-back');
expect('Back returns to the step', (await eyebrow()) === startEyebrow, await eyebrow());
await page.waitForTimeout(700);
await setFace(front(scenario.wrong));
v = await waitVerdict('mistake');
expect('mistake banner names the slip', /wrong way/.test(v.text) && v.title === 'Not quite', v.text);
expect('mistake message matches diagnose()', v.text === scenario.message);
expect('mistake offers Show fix', (await page.locator('#check-actions button', { hasText: 'Show fix' }).count()) === 1);
await page.waitForTimeout(300);
await page.screenshot({ path: join(shotsDir, 'check-mistake.png') });
console.log('screenshot', join(shotsDir, 'check-mistake.png'));
const chipsBefore = await page.locator('#chips').innerText();
await page.click('#check-actions button:has-text("Show fix")');
v = await waitVerdict('mistake', 3000);
expect('Show fix says what to turn', /Here.s the fix/.test(v.title) && v.text.includes(scenario.fix.join(' ')), v.text);
await page.waitForFunction(() => document.querySelector('#v-title').textContent === 'Back on the plan', null, { timeout: 20000 });
expect('after the fix the 3D cube snaps back to the plan', (await page.locator('#chips').innerText()) === chipsBefore);
expect('a partial 3D view canvas exists', (await page.locator('#viewer canvas, #viewer .ne-net').count()) > 0);

// 3. Partial: the first moves done
await setFace(null); // hands away, then read again
await page.waitForTimeout(700);
await page.click('#check-actions button:has-text("Check again")');
const k = 1;
await setFace(front(applyMoves(scenario.before, scenario.moves.slice(0, k))));
v = await waitVerdict('partial');
expect('partial banner says how far you are', new RegExp(`You're ${k} move in — next: ${scenario.moves.slice(k).join(' ')}`).test(v.text), v.text);

// 4. Auto-check: back to the right state, moves on by itself
await setFace(null);
await page.waitForTimeout(700);
await page.evaluate(() => { const b = document.querySelector('#check-auto'); b.click(); });
expect('Auto-check keeps the camera on', await camOn());
await setFace(front(scenario.after));
await page.waitForFunction((was) => document.querySelector('#step-eyebrow').textContent !== was, startEyebrow, { timeout: 25000 });
expect('Auto-check advanced to the next step by itself', (await eyebrow()) !== startEyebrow);
await setFace(front(scenario.next.step.after));
await page.waitForFunction((was) => document.querySelector('#step-eyebrow').textContent !== was, await eyebrow(), { timeout: 25000 }).catch(() => {});
await page.evaluate(() => { document.querySelector('#check-auto').click(); }); // auto off again

// 5. Camera lifecycle
await page.evaluate(() => { document.body.dataset.probe = ''; });
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(300);
expect('camera stops when the page is hidden', !(await camOn()) && (await liveStreams()) === 0);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForFunction(() => !!document.querySelector('#check-video')?.srcObject, null, { timeout: 5000 });
expect('camera comes back when the page is visible again', await camOn());
await page.click('#tab-practice');
await page.waitForTimeout(300);
expect('camera stops when leaving the Coach tab', !(await camOn()) && (await liveStreams()) === 0);
await page.click('#tab-coach');
expect('camera is off after coming back (only starts on a tap)', !(await camOn()));
await page.click('#check-open');
await page.waitForFunction(() => !!document.querySelector('#check-video')?.srcObject);
await page.click('#check-close');
await page.waitForTimeout(200);
expect('camera stops when the panel is closed', !(await camOn()) && (await liveStreams()) === 0 && (await page.locator('#check-panel').isHidden()));
// The Scan tab takes the camera cleanly after a check
await page.click('#check-open');
await page.waitForFunction(() => !!document.querySelector('#check-video')?.srcObject);
await page.click('#tab-scan');
await page.click('#cam-start');
await page.waitForSelector('#scan-camera:not([hidden])');
await page.waitForFunction(() => !!document.querySelector('#cam-video')?.srcObject);
expect('the Scan tab gets the camera and the check camera is off', !(await camOn()) && (await liveStreams()) === 1);
await page.click('#cam-cancel');
const maxLive = await page.evaluate(() => window.__maxLive);
expect('never more than one camera at a time', maxLive <= 1, `max ${maxLive}`);

// 6. Hands / grip pieces of the other agent's API: present or cleanly absent
const opt = await page.evaluate(async () => {
  const lessons = await import('/src/lessons.js');
  const viewer = await import('/src/viewer3d.js');
  return { gripFor: typeof lessons.gripFor, setHands: typeof viewer.CubeViewer.prototype.setHands };
});
await page.click('#tab-coach');
await page.waitForTimeout(500);
const handsShown = await page.locator('#hands-toggle').isVisible();
const gripShown = await page.locator('#grip').isVisible();
console.log(`optional API: gripFor=${opt.gripFor}, setHands=${opt.setHands}; Hands toggle visible=${handsShown}, grip line visible=${gripShown}`);
expect('Hands toggle appears exactly when the viewer supports it', handsShown === (opt.setHands === 'function'));
expect('grip line appears when gripFor exists', opt.gripFor !== 'function' || gripShown);

expect('no console errors', problems.length === 0, problems.join(' | '));
await browser.close();
server.close();
const pass = results.every(Boolean);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
