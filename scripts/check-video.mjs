#!/usr/bin/env node
// Local-only check: replay the auto-scan over a folder of video frames (sorted by name).
//
//   node scripts/check-video.mjs <frames-folder> [--fps 12] [--expect <54-char facelets>] [--verbose]
//                                [--out <folder for annotated copies of captured frames>]
//
// For every frame it runs detectFace (tracking from the previous detection, as the app does),
// feeds FaceTracker/FaceTray to see which faces would be captured and when, then classifies and
// assembles the six captures with buildCube. The frames are never copied into the repo.
import { detectFace, gridPoint } from '../src/detect.js';
import { FaceTracker, FaceTray, buildCube } from '../src/autoscan.js';
import { validate } from '../src/cube.js';
import { decodeFolder } from './decode.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dir = args.find((a, i) => !a.startsWith('--') && !['--fps', '--expect', '--out'].includes(args[i - 1]));
if (!dir) { console.error('usage: node scripts/check-video.mjs <frames-folder> [--fps 12] [--expect FACELETS] [--verbose]'); process.exit(2); }
const fps = +opt('--fps', 12), expect = opt('--expect', null), verbose = args.includes('--verbose');
const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

const { images, cleanup } = decodeFolder(dir);
try {
  const tracker = new FaceTracker(), tray = new FaceTray();
  let prev = null, found = 0, totalMs = 0, maxMs = 0;
  const events = [];
  images.forEach((img, k) => {
    const t = (k / fps) * 1000;
    const t0 = performance.now();
    const det = detectFace(img, { prev });
    const ms = performance.now() - t0;
    totalMs += ms; maxMs = Math.max(maxMs, ms);
    prev = det.found ? det : null;
    if (det.found) found++;
    const r = tracker.update(det, t);
    let note = '';
    if (r.capture) {
      const e = tray.offer(r.capture);
      note = ` CAPTURE ${e.kind} slot ${e.index} (${e.name}) q=${r.capture.quality.toFixed(2)} jitter=${r.capture.jitter.toFixed(1)}`;
      events.push({ frame: img.name, t, ...e, quality: r.capture.quality });
    }
    if (verbose || note) {
      console.log(`${img.name} ${det.found ? `box ${det.x.toFixed(0)},${det.y.toFixed(0)} ${det.size.toFixed(0)}px ${det.angle.toFixed(0)}° score ${det.score.toFixed(2)} ring ${hex(det.centerRing)}` : `--    (best ${det.score.toFixed(2)})`} ${r.phase} ${(r.progress * 100).toFixed(0)}% ${ms.toFixed(0)}ms${note}`);
    }
  });
  console.log(`\n${images.length} frames, detected in ${found} (${(100 * found / images.length).toFixed(0)}%), mean ${(totalMs / images.length).toFixed(1)} ms, max ${maxMs.toFixed(1)} ms per frame`);
  console.log(`tray after the run: ${tray.count} faces [${tray.slots.map((s) => s.name).join(', ')}], still missing: ${tray.missing.join(', ') || 'none'}`);
  if (tray.count < 6) process.exitCode = 1;
  else {
    const res = buildCube(tray.captures());
    console.log(`assembled: ok=${res.ok} facelets=${res.facelets}`);
    console.log(`validate(): ${validate(res.facelets).ok}; ambiguous=${res.distinct > 1}; flagged stickers: [${res.flags.join(', ')}]`);
    if (res.errors.length) console.log('errors:', res.errors);
    if (expect) {
      const bad = [];
      for (let i = 0; i < 54; i++) if (res.facelets[i] !== expect[i]) bad.push(`${i}:${res.facelets[i]}≠${expect[i]}`);
      console.log(bad.length ? `MISMATCH vs expected (${bad.length}): ${bad.join(' ')}` : 'MATCHES the expected cube');
      if (bad.length) process.exitCode = 1;
    }
  }
} finally {
  cleanup();
}
