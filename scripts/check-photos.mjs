#!/usr/bin/env node
// Local-only check: run the face detector on real photos in a folder.
//
//   node scripts/check-photos.mjs <folder-with-jpegs> [--out <folder-for-annotated-copies>]
//
// The photos are never copied into the repo (they can show people). Node has no JPEG decoder,
// so python3 + Pillow decodes each image to raw RGBA in a temp dir that is removed afterwards.
// Timing is per detectFace() call on the full-size image (the app itself feeds ~200 px frames).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFace, sampleFace, WORK_SIZE } from '../src/detect.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
if (!dir) { console.error('usage: node scripts/check-photos.mjs <folder> [--out <folder>]'); process.exit(2); }

const tmp = mkdtempSync(join(tmpdir(), 'cube-photos-'));
const py = `
import sys, os
from PIL import Image, ImageOps
src, dst = sys.argv[1], sys.argv[2]
for n in sorted(os.listdir(src)):
    if n.lower().endswith(('.jpg', '.jpeg', '.png')):
        im = ImageOps.exif_transpose(Image.open(os.path.join(src, n))).convert('RGBA')
        open(os.path.join(dst, n + '.rgba'), 'wb').write(im.tobytes())
        open(os.path.join(dst, n + '.size'), 'w').write('%d %d' % im.size)
`;
const r = spawnSync('python3', ['-c', py, dir, tmp], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr || 'python3/Pillow decode failed'); rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const marks = [];
try {
  for (const f of readdirSync(tmp).filter((n) => n.endsWith('.size')).sort()) {
    const name = f.slice(0, -5);
    const [width, height] = readFileSync(join(tmp, f), 'utf8').split(' ').map(Number);
    const buf = readFileSync(join(tmp, `${name}.rgba`));
    const img = { width, height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length) };
    detectFace(img); // warm up the JIT
    const t0 = performance.now();
    const N = 5;
    let det;
    for (let i = 0; i < N; i++) det = detectFace(img);
    const ms = (performance.now() - t0) / N;
    console.log(`${name}  ${width}x${height}  (search image ~${WORK_SIZE}px)  ${ms.toFixed(1)} ms/call`);
    if (!det.found) { console.log(`  not found (best score ${det.score.toFixed(2)})`); marks.push({ name, found: false }); continue; }
    console.log(`  found  x ${det.x.toFixed(0)}..${(det.x + det.size).toFixed(0)}  y ${det.y.toFixed(0)}..${(det.y + det.size).toFixed(0)}  size ${det.size.toFixed(0)}  angle ${det.angle.toFixed(1)}°  score ${det.score.toFixed(2)}`);
    console.log(`  cells ${det.cells.map(hex).join(' ')}`);
    console.log(`  centerRing ${hex(det.centerRing)}`);
    marks.push({ name, found: true, det });
  }
  if (outDir) {
    const draw = `
import sys, json, os, math
from PIL import Image, ImageDraw, ImageOps
src, out, marks = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
os.makedirs(out, exist_ok=True)
for m in marks:
    im = ImageOps.exif_transpose(Image.open(os.path.join(src, m['name']))).convert('RGB')
    if m['found']:
        d = m['det']; dr = ImageDraw.Draw(im)
        a = math.radians(d['angle']); cs, sn = math.cos(a), math.sin(a)
        cx, cy, s = d['x'] + d['size'] / 2, d['y'] + d['size'] / 2, d['size']
        def pt(u, v):
            dx, dy = (u - .5) * s, (v - .5) * s
            return (cx + cs * dx - sn * dy, cy + sn * dx + cs * dy)
        for i in range(4):
            dr.line([pt(i / 3, 0), pt(i / 3, 1)], fill=(255, 0, 255), width=5)
            dr.line([pt(0, i / 3), pt(1, i / 3)], fill=(255, 0, 255), width=5)
        for i, c in enumerate(d['cells']):
            x, y = pt((i % 3 + .5) / 3, (i // 3 + .5) / 3)
            dr.ellipse([x - 22, y - 22, x + 22, y + 22], fill=(c['r'], c['g'], c['b']), outline=(0, 0, 0), width=4)
    im.thumbnail((900, 1200)); im.save(os.path.join(out, m['name'] + '.annotated.jpg'))
`;
    const rr = spawnSync('python3', ['-c', draw, dir, outDir, JSON.stringify(marks)], { encoding: 'utf8' });
    if (rr.status !== 0) console.error(rr.stderr);
    else console.log(`annotated copies written to ${outDir}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
