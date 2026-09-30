import test from 'node:test';
import assert from 'node:assert/strict';
import { STICKER_HEX, dimSticker, hexToRgb, DIM_DARKEN, DIM_DESAT } from '../src/viewer3d.js';

const to255 = (rgb) => rgb.map((v) => v * 255);
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
const hue = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
};

test('sticker palette is vivid and complete', () => {
  assert.deepEqual(Object.keys(STICKER_HEX).sort(), ['blue', 'green', 'orange', 'red', 'white', 'yellow']);
  for (const [name, hex] of Object.entries(STICKER_HEX)) {
    assert.match(hex, /^#[0-9a-f]{6}$/, name);
    if (name !== 'white') assert.ok(sat(hexToRgb(hex)) > 0.8, `${name} saturated`);
  }
});

test('dimming keeps hue and most saturation and only darkens a little', () => {
  assert.deepEqual(dimSticker([0.2, 0.5, 0.9], 0), [0.2, 0.5, 0.9]);
  for (const name of ['blue', 'red', 'green', 'orange', 'yellow']) {
    const base = hexToRgb(STICKER_HEX[name]);
    const dim = dimSticker(base, 1);
    assert.ok(Math.abs(hue(dim) - hue(base)) < 8, `${name} hue`);
    assert.ok(sat(dim) >= sat(base) * (1 - DIM_DESAT) - 1e-9, `${name} keeps saturation`);
    const ratio = Math.max(...dim) / Math.max(...base);
    assert.ok(ratio >= 0.6 && ratio <= 0.8, `${name} brightness ${ratio}`);
  }
  assert.ok(DIM_DARKEN <= 0.35 && DIM_DESAT <= 0.2);
});

test('dimmed blue, red and green stay clearly distinct', () => {
  const dim = Object.fromEntries(['blue', 'red', 'green', 'orange', 'yellow', 'white'].map((n) => [n, to255(dimSticker(hexToRgb(STICKER_HEX[n]), 1))]));
  for (const [a, b] of [['blue', 'red'], ['blue', 'green'], ['red', 'green']]) {
    assert.ok(dist(dim[a], dim[b]) > 90, `${a}/${b} ${dist(dim[a], dim[b]).toFixed(0)}`);
  }
  // Red and orange are the closest pair on any cube; keep them separable too.
  assert.ok(dist(dim.red, dim.orange) > 55, `red/orange ${dist(dim.red, dim.orange).toFixed(0)}`);
});
