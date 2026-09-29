#!/usr/bin/env node
// Headless-Chromium check of the auto-capture scan (local tool, not part of `npm test`).
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM_PATH=/path/to/chrome \
//     node scripts/e2e-autoscan.mjs [--shot out.png]
//
// It serves the repo on a random port and replaces getUserMedia with a canvas stream that plays
// synthetic frames (test/facesynth.js): the six faces of a scrambled cube, one after another in
// random order and turn, each held for about 1.6 s, one of them shown twice, with an empty
// pause between them. It then checks that the tray fills, the review screen opens with the
// right cube, and that the page logged no errors. Needs playwright-core and a Chromium
// (PLAYWRIGHT_BROWSERS_PATH), neither of which is a dependency of the app.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLVED, FACES, COLOR_OF, applyMoves, randomScramble } from '../src/cube.js';
import { rotateFace } from '../src/assemble.js';
import { mulberry32 } from '../test/facesynth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const shot = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
import { createRequire } from 'node:module';
const { chromium } = process.env.PLAYWRIGHT_CORE ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE) : await import('playwright-core');

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

// The scenario: a scrambled cube; faces in random order (one repeated), each turned by 0-3 quarter-turns.
const rand = mulberry32(20240607);
const cube = applyMoves(SOLVED, randomScramble(25, rand));
const order = [...FACES.keys()].sort(() => rand() - 0.5);
const sequence = [order[0], order[1], order[2], order[2], order[3], order[4], order[5]];
const shown = sequence.map((fi) => {
  const cells = [...cube.slice(fi * 9, fi * 9 + 9)].map((l) => COLOR_OF[l]);
  return { face: fi, turns: (rand() * 4) | 0, names: rotateFace(cells, 0) };
});
shown.forEach((s) => { s.names = rotateFace(s.names, (4 - s.turns) % 4); });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

// Mock camera: draw pre-rendered synthetic frames onto a canvas and stream it.
await page.addInitScript(({ shown }) => {
  const W = 360, H = 480, HOLD = 1600, GAP = 500;
  navigator.mediaDevices.getUserMedia = async () => {
    const { renderFrame } = await import('/test/facesynth.js');
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx2 = canvas.getContext('2d');
    const variants = shown.map((s, i) => Array.from({ length: 6 }, (_, k) => {
      const t = k / 6 * Math.PI * 2;
      return renderFrame({
        width: W, height: H, seed: 100 + i * 10 + k, bg: 'couch', noise: 3,
        cube: { cx: 175 + Math.sin(t) * 3, cy: 250 + Math.cos(t) * 3, size: 210, angle: -8 + Math.sin(t) * 2 + i * 3, names: s.names, gapFrac: 0.06, logo: true, hand: true, gain: 0.95, cast: [1.02, 1, 0.96] },
      }).img;
    }));
    const empty = renderFrame({ width: W, height: H, seed: 9, bg: 'couch', noise: 3, cube: null }).img;
    const t0 = performance.now();
    const draw = () => {
      const t = performance.now() - t0, slot = HOLD + GAP, i = Math.floor(t / slot);
      const inHold = t % slot < HOLD && i < shown.length;
      const img = inHold ? variants[i][Math.floor(t / 90) % 6] : empty;
      ctx2.putImageData(new ImageData(img.data, W, H), 0, 0);
      window.__cam = { i, inHold, t };
    };
    draw();
    setInterval(draw, 66);
    return canvas.captureStream(15);
  };
}, { shown });

await page.goto(`${url}#scan`);
await page.click('#cam-start');
await page.waitForSelector('#scan-camera:not([hidden])');

// Mid-scan screenshot: three sides in, the fourth being held.
let shotTaken = false;
const deadline = Date.now() + 60000;
let phase = '';
while (Date.now() < deadline) {
  const filled = await page.locator('button.tray-slot').count();
  phase = await page.locator('#cam-hint').innerText();
  if (!shotTaken && shot && filled === 3 && /Hold steady/.test(phase)) {
    await page.screenshot({ path: shot });
    shotTaken = true;
    console.log(`screenshot: ${shot} (3 of 6 sides, hint "${phase}")`);
  }
  if (await page.locator('#scan-review:not([hidden])').count()) break;
  await page.waitForTimeout(100);
}
if (shot && !shotTaken) { await page.screenshot({ path: shot }); console.log(`screenshot: ${shot} (fallback moment)`); }

const reviewOpen = await page.locator('#scan-review:not([hidden])').count();
console.log('review screen reached:', !!reviewOpen);
let ok = !!reviewOpen;
if (reviewOpen) {
  const labels = await page.$$eval('#net .ne-st', (bs) => bs.map((b) => b.getAttribute('aria-label')));
  const letterOf = Object.fromEntries(Object.entries(COLOR_OF).map(([l, c]) => [c, l]));
  const got = labels.map((t) => letterOf[t.split(', ').pop()]).join('');
  const status = await page.locator('#review-status').innerText();
  const canGo = await page.locator('#coach-go').isEnabled();
  console.log('status:', status, '| coach button enabled:', canGo);
  console.log('expected:', cube);
  console.log('read    :', got);
  ok = ok && canGo && got === cube;
  await page.screenshot({ path: shot ? shot.replace(/\.png$/, '-review.png') : '/dev/null' }).catch(() => {});
}
const still = await page.evaluate(() => !!document.querySelector('#cam-video')?.srcObject);
console.log('camera stream stopped after the scan:', !still);
ok = ok && !still;
console.log(problems.length ? `problems:\n${problems.join('\n')}` : 'no console errors');
ok = ok && !problems.length;
await browser.close();
server.close();
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
