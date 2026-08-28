#!/usr/bin/env node
/**
 * Generates the extension icons into public/icon/.
 *
 * The icons are original artwork drawn by this script — a rounded tile with
 * three field bars, the last one part-filled. C-010 requires that the icon share
 * nothing with Fake Filler, and a generator committed alongside the output is
 * the cheapest possible proof of that: the artwork's entire provenance is these
 * ~40 lines of geometry.
 *
 * **The geometry is laid out on the 16 px grid, not on a designer's canvas.**
 * 16 px is the size that matters — it is the toolbar, which is where a user sees
 * this mark all day, and it leaves about eleven pixels of usable interior once
 * the corner radius is paid for. So every horizontal edge below is an exact
 * sixteenth: the bars land on rows 3-5, 7-9 and 11-13 of a 16 px render, two
 * pixels each with two clear pixels between them and three of margin. Nothing
 * needs to be rounded into place, so nothing blurs. Sizes above 16 inherit the
 * proportions rather than the other way round, which is the opposite of how this
 * usually goes and the reason the small render survives.
 *
 * That constraint is also why there is nothing else in the frame. A mark with
 * four elements has one at 16 px and noise around it.
 *
 * Output is byte-deterministic (fixed palette, fixed geometry, fixed deflate
 * level, no timestamp chunk), so regenerating never dirties the tree and never
 * disturbs the reproducible-build digest (NFR-011). Run it by hand after editing
 * the geometry; it is deliberately not wired into the build, because generating
 * assets at build time is one of the ways bundlers stop being reproducible.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
const SIZES = [16, 32, 48, 64, 96, 128];

/** Supersampling factor per axis. 4× is enough to keep 16px edges from stepping. */
const SAMPLES = 4;

const TILE = { color: [0x2f, 0x6f, 0xed], inset: 0.03, radius: 0.22 };

/**
 * Every edge is a multiple of 1/16, so a 16 px render lands on whole pixels.
 * Bars occupy rows 3-5, 7-9 and 11-13; columns 3-13. Changing any number here to
 * something that is not n/16 costs the small render its crispness, which is the
 * only render this mark is actually judged on.
 */
const BARS = [
  { top: 3 / 16, bottom: 5 / 16, left: 3 / 16, right: 13 / 16, alpha: 1 },
  { top: 7 / 16, bottom: 9 / 16, left: 3 / 16, right: 13 / 16, alpha: 1 },

  // The third bar is the tool's whole subject: a field caught mid-fill. It is
  // drawn as a fill over its own track rather than as two abutting segments —
  // two pills meeting at a seam taper to a point on both sides of it and pinch
  // the bar in the middle, which at 16 px reads as a gap rather than a
  // boundary. `sample` returns on first match, so the fill must precede the
  // track it sits inside. The fill spans the first two fifths of the bar's
  // width (3/16 to 7/16 — columns 3-6 of a 16 px render), settled on
  // 2026-08-24 after trying a fifth and a third; the two full-width bars over
  // a shorter, left-aligned bottom bar evoke the initial more strongly the
  // longer it gets, without the mark being a letterform. 7/16 keeps the edge
  // on the grid.
  { top: 11 / 16, bottom: 13 / 16, left: 3 / 16, right: 7 / 16, alpha: 1 },
  { top: 11 / 16, bottom: 13 / 16, left: 3 / 16, right: 13 / 16, alpha: 0.34 },
];

/** Half the bar height, which makes every bar a pill rather than a rectangle. */
const BAR_RADIUS = 1 / 16;

/** Signed-distance test for a rounded rectangle, in unit coordinates. */
function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const r = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  if (x >= left + r && x <= right - r) return y >= top && y <= bottom;
  if (y >= top + r && y <= bottom - r) return x >= left && x <= right;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Returns the RGBA of one sample point in unit space, or null for transparent. */
function sample(x, y) {
  const { inset } = TILE;
  if (!insideRoundedRect(x, y, inset, inset, 1 - inset, 1 - inset, TILE.radius)) {
    return null;
  }
  for (const bar of BARS) {
    if (insideRoundedRect(x, y, bar.left, bar.top, bar.right, bar.bottom, BAR_RADIUS)) {
      // Bars are white over the tile; blend by the bar's own alpha so the
      // part-filled segment reads as a lighter tint rather than a hole.
      const a = bar.alpha;
      return [
        Math.round(0xff * a + TILE.color[0] * (1 - a)),
        Math.round(0xff * a + TILE.color[1] * (1 - a)),
        Math.round(0xff * a + TILE.color[2] * (1 - a)),
        255,
      ];
    }
  }
  return [...TILE.color, 255];
}

/** Renders one size to raw RGBA scanlines, each prefixed with PNG filter 0. */
function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let py = 0; py < size; py++) {
    raw[offset++] = 0; // filter type: none
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          const rgba = sample(x, y);
          if (rgba === null) continue;
          r += rgba[0];
          g += rgba[1];
          b += rgba[2];
          covered++;
        }
      }
      const total = SAMPLES * SAMPLES;
      if (covered === 0) {
        offset += 4;
        continue;
      }
      // Premultiplied averaging would darken the antialiased edge against a
      // light toolbar; average the covered samples' colour and put coverage in
      // alpha instead.
      raw[offset++] = Math.round(r / covered);
      raw[offset++] = Math.round(g / covered);
      raw[offset++] = Math.round(b / covered);
      raw[offset++] = Math.round((covered / total) * 255);
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function toPng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = toPng(size, render(size));
  const file = join(OUT_DIR, `${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
