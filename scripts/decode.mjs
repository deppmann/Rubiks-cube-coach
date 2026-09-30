// Local helper for the check-* scripts: decode a folder of JPEG/PNG images to ImageData-like
// objects. Node has no JPEG/PNG decoder, so python3 + Pillow (EXIF-aware) writes raw RGBA to a
// temp dir, which cleanup() removes. Nothing is ever copied into the repo.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PY = `
import sys, os
from PIL import Image, ImageOps
src, dst = sys.argv[1], sys.argv[2]
for n in sorted(os.listdir(src)):
    if n.lower().endswith(('.jpg', '.jpeg', '.png')):
        im = ImageOps.exif_transpose(Image.open(os.path.join(src, n))).convert('RGBA')
        open(os.path.join(dst, n + '.rgba'), 'wb').write(im.tobytes())
        open(os.path.join(dst, n + '.size'), 'w').write('%d %d' % im.size)
`;

// → { images: [{ name, width, height, data }], cleanup() }
export function decodeFolder(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'cube-decode-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync('python3', ['-c', PY, dir, tmp], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) { cleanup(); throw new Error(r.stderr || 'python3/Pillow decode failed'); }
  const images = readdirSync(tmp).filter((n) => n.endsWith('.size')).sort().map((f) => {
    const name = f.slice(0, -5);
    const [width, height] = readFileSync(join(tmp, f), 'utf8').split(' ').map(Number);
    const buf = readFileSync(join(tmp, `${name}.rgba`));
    return { name, width, height, data: new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)) };
  });
  return { images, cleanup };
}
