#!/usr/bin/env node
/**
 * Generates the store promo tiles into docs/art/.
 *
 * Two assets, both specified in docs/art_brief.md §4 and §5:
 *   docs/art/promo-440x280.png   the small tile every Chrome Web Store search
 *                                result and browse row shows
 *   docs/art/promo-1400x560.png  the marquee, used only if Google considers the
 *                                extension for featuring
 *
 * The brief's own warning is that image models mangle short strings, and its
 * §7 remedy is the one make-icons.mjs already takes: the artwork is committed
 * geometry, not a downsampled raster. The lettering is set the same way a
 * layout tool would set it — in Inter (SIL Open Font License 1.1), whose
 * latin subsets are committed beside this script in scripts/fonts/ with the
 * licence text. Inter is the typeface of the developer tools the brief itself
 * name-checks (Linear, Vercel, Raycast). The script parses the WOFF files
 * itself — inflate the table directory, walk the glyf outlines, flatten the
 * quadratic béziers, fill by nonzero winding in the same supersampling
 * rasteriser that draws the mark — so there is no runtime dependency and no
 * generator: "FieldFiller" cannot be misspelled, the type matches across both
 * tiles by construction, and C-010's provenance argument stays intact, font
 * files included. The fonts are repo inputs only; they are not packaged.
 *
 * The mark itself mirrors scripts/make-icons.mjs — same tile, same bars on the
 * 16 px grid, the third field a fill over its own track, filled across the
 * first two fifths of its width (3/16 to 7/16). If make-icons.mjs changes,
 * change it here in the same commit. Promo tiles are store assets, not
 * package inputs: they live in docs/art/ (like docs/diagrams/) rather than
 * public/, so they never enter the zip and never disturb the
 * reproducible-build digest (NFR-011).
 *
 * Output is byte-deterministic (fixed geometry, fixed fonts, fixed palette,
 * fixed deflate level, no timestamp chunk), so regenerating never dirties the
 * tree. Run it by hand after editing the geometry, exactly like
 * make-icons.mjs.
 *
 * Usage: node scripts/make-promo.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, '..', 'docs', 'art');
const FONT_DIR = join(SCRIPT_DIR, 'fonts');

/** Supersampling per axis, as in make-icons.mjs. 4× keeps hairlines even. */
const SAMPLES = 4;

// ---------------------------------------------------------------------------
// Palette — docs/art_brief.md §2, verbatim.
// ---------------------------------------------------------------------------
const BLUE = [0x2f, 0x6f, 0xed];
const INK = [0x1b, 0x1c, 0x1e];
const MUTED = [0x55, 0x58, 0x5e];
const RULE = [0xd8, 0xda, 0xde];
const WHITE = [0xff, 0xff, 0xff];
const TINT = [0xe9, 0xf0, 0xfb]; // the pale blue the brief allows in corners/backgrounds

// ---------------------------------------------------------------------------
// The mark. Geometry mirrors scripts/make-icons.mjs exactly: tile inset 0.03,
// corner radius 0.22, bars on exact sixteenths (rows 3-5, 7-9, 11-13; columns
// 3-13; the third field a fill over its own track, filled to 7/16 — the first
// two fifths of the bar's width). If make-icons.mjs changes, change it here in
// the same commit.
// ---------------------------------------------------------------------------
const MARK_TILE = { inset: 0.03, radius: 0.22 };
const MARK_BARS = [
  { top: 3 / 16, bottom: 5 / 16, left: 3 / 16, right: 13 / 16, alpha: 1 },
  { top: 7 / 16, bottom: 9 / 16, left: 3 / 16, right: 13 / 16, alpha: 1 },
  { top: 11 / 16, bottom: 13 / 16, left: 3 / 16, right: 7 / 16, alpha: 1 },
  { top: 11 / 16, bottom: 13 / 16, left: 3 / 16, right: 13 / 16, alpha: 0.34 },
];

/** True signed distance to a rounded rectangle; <= 0 means inside. */
function roundedRectDistance(x, y, l, t, r, b, radius) {
  const rad = Math.min(radius, (r - l) / 2, (b - t) / 2);
  const hx = (r - l) / 2 - rad;
  const hy = (b - t) / 2 - rad;
  const qx = Math.abs(x - (l + r) / 2) - hx;
  const qy = Math.abs(y - (t + b) / 2) - hy;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - rad;
}

/** Returns a layer drawing the mark, `size` px tall and wide, at (x0, y0). */
function markLayer(x0, y0, size) {
  const bars = MARK_BARS.map((bar) => ({
    ...bar,
    l: x0 + bar.left * size,
    t: y0 + bar.top * size,
    r: x0 + bar.right * size,
    b: y0 + bar.bottom * size,
    rad: (1 / 16) * size,
  }));
  const inset = MARK_TILE.inset * size;
  return {
    bbox: [x0, y0, x0 + size, y0 + size],
    sample(x, y) {
      if (
        roundedRectDistance(
          x,
          y,
          x0 + inset,
          y0 + inset,
          x0 + size - inset,
          y0 + size - inset,
          MARK_TILE.radius * size,
        ) > 0
      ) {
        return null;
      }
      for (const bar of bars) {
        if (roundedRectDistance(x, y, bar.l, bar.t, bar.r, bar.b, bar.rad) <= 0) {
          const a = bar.alpha;
          return [
            Math.round(0xff * a + BLUE[0] * (1 - a)),
            Math.round(0xff * a + BLUE[1] * (1 - a)),
            Math.round(0xff * a + BLUE[2] * (1 - a)),
            255,
          ];
        }
      }
      return [...BLUE, 255];
    },
  };
}

// ---------------------------------------------------------------------------
// The type. Inter, from the WOFF files in scripts/fonts/ (SIL OFL 1.1, latin
// subsets from Fontsource; licence text beside them). Enough of a WOFF/TrueType
// reader to reach the outlines: inflate the table directory, decode cmap
// format 4, loca and glyf, including composite glyphs. The outlines are
// quadratic bézier contours in font units; each rendered instance is flattened
// to pixel-space polygons and filled by nonzero winding — TrueType's own fill
// rule — inside the shared supersampling compositor.
// ---------------------------------------------------------------------------

/** Letter-spacing in em. Inter is snug; a whisker of tracking at display size. */
const TRACKING = 0.01;

/** Inter's vertical proportions, used only to position baselines. */
const INTER_CAP = 0.727;

function parseWoffTables(buf) {
  if (buf.toString('ascii', 0, 4) !== 'wOFF') throw new Error('not a WOFF file');
  const numTables = buf.readUInt16BE(12);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = buf.toString('ascii', o, o + 4);
    const offset = buf.readUInt32BE(o + 4);
    const compLength = buf.readUInt32BE(o + 8);
    const origLength = buf.readUInt32BE(o + 12);
    const data = buf.subarray(offset, offset + compLength);
    // WOFF1 stores each table zlib-compressed when that makes it smaller;
    // otherwise it is the original bytes, and inflating raw deflate would
    // throw, so the lengths decide.
    tables[tag] = compLength < origLength ? inflateSync(data) : Buffer.from(data);
  }
  return tables;
}

/** cmap format 4 — the unicode BMP subtable every latin subset carries. */
function parseCmap(table) {
  const n = table.readUInt16BE(2);
  let sub = null;
  for (let i = 0; i < n; i++) {
    const platform = table.readUInt16BE(4 + i * 8);
    const encoding = table.readUInt16BE(6 + i * 8);
    const offset = table.readUInt32BE(8 + i * 8);
    if ((platform === 3 && encoding === 1) || platform === 0) {
      sub = table.subarray(offset);
      break;
    }
  }
  if (sub === null || sub.readUInt16BE(0) !== 4) throw new Error('no cmap format 4 subtable');
  const segCount = sub.readUInt16BE(6) / 2;
  const end = [];
  const start = [];
  const delta = [];
  const rangeOff = [];
  for (let i = 0; i < segCount; i++) end.push(sub.readUInt16BE(14 + i * 2));
  for (let i = 0; i < segCount; i++) start.push(sub.readUInt16BE(16 + segCount * 2 + i * 2));
  for (let i = 0; i < segCount; i++) delta.push(sub.readInt16BE(16 + segCount * 4 + i * 2));
  const rangeBase = 16 + segCount * 6;
  for (let i = 0; i < segCount; i++) rangeOff.push(sub.readUInt16BE(rangeBase + i * 2));
  return (code) => {
    const cp = typeof code === 'string' ? code.codePointAt(0) : code;
    for (let i = 0; i < segCount; i++) {
      if (cp <= end[i]) {
        if (cp < start[i]) return 0;
        if (rangeOff[i] === 0) return (cp + delta[i]) & 0xffff;
        const addr = rangeBase + i * 2 + rangeOff[i] + (cp - start[i]) * 2;
        const g = sub.readUInt16BE(addr);
        return g === 0 ? 0 : (g + delta[i]) & 0xffff;
      }
    }
    return 0;
  };
}

/** One glyf simple glyph: contours of {x, y, on} in font units. */
function parseSimpleGlyph(v, nContours) {
  const endPts = [];
  for (let i = 0; i < nContours; i++) endPts.push(v.readUInt16BE(10 + i * 2));
  const insLen = v.readUInt16BE(10 + nContours * 2);
  let p = 12 + nContours * 2 + insLen;
  const nPts = endPts[nContours - 1] + 1;
  const flags = [];
  while (flags.length < nPts) {
    const f = v.readUInt8(p++);
    flags.push(f);
    if (f & 0x08) {
      const repeat = v.readUInt8(p++);
      for (let r = 0; r < repeat; r++) flags.push(f);
    }
  }
  const xs = [];
  let x = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & 0x02) {
      const d = v.readUInt8(p++);
      x += f & 0x10 ? d : -d;
    } else if (!(f & 0x10)) {
      x += v.readInt16BE(p);
      p += 2;
    }
    xs.push(x);
  }
  const ys = [];
  let y = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i];
    if (f & 0x04) {
      const d = v.readUInt8(p++);
      y += f & 0x20 ? d : -d;
    } else if (!(f & 0x20)) {
      y += v.readInt16BE(p);
      p += 2;
    }
    ys.push(y);
  }
  const contours = [];
  let s = 0;
  for (const endPt of endPts) {
    const pts = [];
    for (let i = s; i <= endPt; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
    s = endPt + 1;
    contours.push(pts);
  }
  return contours;
}

/** Composite glyphs: offset (and optionally scaled) copies of other glyphs. */
function parseCompositeGlyph(v, contoursOf) {
  let p = 10;
  const contours = [];
  for (;;) {
    const flags = v.readUInt16BE(p);
    p += 2;
    const gid = v.readUInt16BE(p);
    p += 2;
    let dx;
    let dy;
    if (flags & 0x0001) {
      dx = v.readInt16BE(p);
      dy = v.readInt16BE(p + 2);
      p += 4;
    } else {
      dx = v.readInt8(p);
      dy = v.readInt8(p + 1);
      p += 2;
    }
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & 0x0008) {
      a = d = v.readInt16BE(p) / 16384;
      p += 2;
    } else if (flags & 0x0040) {
      a = v.readInt16BE(p) / 16384;
      d = v.readInt16BE(p + 2) / 16384;
      p += 4;
    } else if (flags & 0x0080) {
      a = v.readInt16BE(p) / 16384;
      b = v.readInt16BE(p + 2) / 16384;
      c = v.readInt16BE(p + 4) / 16384;
      d = v.readInt16BE(p + 6) / 16384;
      p += 8;
    }
    for (const contour of contoursOf(gid)) {
      contours.push(
        contour.map((pt) => ({
          x: dx + a * pt.x + c * pt.y,
          y: dy + b * pt.x + d * pt.y,
          on: pt.on,
        })),
      );
    }
    if (!(flags & 0x0020)) break; // MORE_COMPONENTS
  }
  return contours;
}

/**
 * Loads a WOFF face. Returns { upem, cmap, advance, contours } with contours
 * cached per glyph id — the same glyphs are set on both tiles.
 */
function loadFace(file) {
  const t = parseWoffTables(readFileSync(file));
  const upem = t.head.readUInt16BE(18);
  const longLoca = t.head.readInt16BE(50) === 1;
  const numGlyphs = t.maxp.readUInt16BE(4);
  const numH = t.hhea.readUInt16BE(34);
  const readLoca = (i) => (longLoca ? t.loca.readUInt32BE(i * 4) : t.loca.readUInt16BE(i * 2) * 2);
  const cache = new Map();
  const contoursOf = (gid) => {
    if (cache.has(gid)) return cache.get(gid);
    const start = readLoca(gid);
    const end = readLoca(gid + 1);
    let contours = [];
    if (end > start) {
      const v = t.glyf.subarray(start, end);
      const nContours = v.readInt16BE(0);
      contours =
        nContours >= 0 ? parseSimpleGlyph(v, nContours) : parseCompositeGlyph(v, contoursOf);
    }
    cache.set(gid, contours);
    return contours;
  };
  return {
    upem,
    cmap: parseCmap(t.cmap),
    contours: contoursOf,
    advance: (gid) =>
      gid < numH ? t.hmtx.readUInt16BE(gid * 4) : t.hmtx.readUInt16BE((numH - 1) * 4),
    glyphCount: numGlyphs,
  };
}

/**
 * Flattens one quadratic bézier into `poly` as pixel points, excluding p0 and
 * including p1. Segment count adapts to chord length so curves stay smooth at
 * any of the sizes the tiles set.
 */
function flattenQuad(poly, p0, c, p1) {
  const steps = Math.min(24, Math.max(2, Math.ceil((Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y)) / 1.25)));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    poly.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    });
  }
}

/**
 * One TrueType contour (on/off points in font units) to a flattened polygon in
 * pixel space. A run of off-curve points between on-curve points defines
 * consecutive quads whose junctions are implied on-curve midpoints — the
 * convention TrueType outlines are authored in. A contour that never lands on
 * a curve point at all starts and ends at the midpoint of its off run.
 */
function contourToPolygon(pts, px, baseline, scale) {
  if (pts.length < 3) return null;
  const P = (pt) => ({ x: px + pt.x * scale, y: baseline - pt.y * scale, on: pt.on });
  let firstOn = pts.findIndex((pt) => pt.on);
  let seq;
  if (firstOn === -1) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    seq = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...pts];
  } else {
    seq = [...pts.slice(firstOn), ...pts.slice(0, firstOn)];
  }
  const poly = [P(seq[0])];
  let cur = seq[0];
  let i = 1;
  while (i < seq.length) {
    if (seq[i].on) {
      poly.push(P(seq[i]));
      cur = seq[i];
      i++;
      continue;
    }
    const offs = [];
    while (i < seq.length && !seq[i].on) offs.push(seq[i++]);
    const nextOn = i < seq.length ? seq[i] : seq[0];
    if (offs.length === 1) {
      flattenQuad(poly, P(cur), P(offs[0]), P(nextOn));
    } else {
      for (let k = 0; k < offs.length; k++) {
        const implied =
          k + 1 < offs.length
            ? { x: (offs[k].x + offs[k + 1].x) / 2, y: (offs[k].y + offs[k + 1].y) / 2, on: true }
            : nextOn;
        flattenQuad(poly, P(cur), P(offs[k]), P(implied));
        cur = implied;
      }
    }
    cur = nextOn;
  }
  return poly;
}

/** TrueType's fill rule: inside is nonzero winding against a rightward ray. */
function windingInside(polys, x, y) {
  let wind = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      if ((a.y > y) !== (b.y > y)) {
        const xint = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (xint > x) wind += b.y > a.y ? 1 : -1;
      }
    }
  }
  return wind !== 0;
}

/** Width of a string in em at unit size, advances plus tracking. */
function measureEm(text, face) {
  let width = 0;
  let count = 0;
  for (const ch of text) {
    const gid = face.cmap(ch);
    if (gid === 0) throw new Error(`no glyph in ${face.name} for '${ch}'`);
    width += face.advance(gid);
    count++;
  }
  return width / face.upem + TRACKING * Math.max(0, count - 1);
}

/** Sets one line of type and returns it as a layer over the compositor. */
function textLayer(text, { face, x, baseline, em, color }) {
  const scale = em / face.upem;
  const tracking = TRACKING * em;
  const glyphs = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let pen = x;
  for (const ch of text) {
    const gid = face.cmap(ch);
    if (gid === 0) throw new Error(`no glyph in ${face.name} for '${ch}'`);
    const polys = [];
    for (const contour of face.contours(gid)) {
      const poly = contourToPolygon(contour, pen, baseline, scale);
      if (poly === null) continue;
      for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      polys.push(poly);
    }
    const adv = face.advance(gid) * scale;
    glyphs.push({ polys, x0: pen - 2, x1: pen + adv + 2 });
    pen += adv + tracking;
  }
  return {
    bbox: [minX - 1, minY - 1, maxX + 1, maxY + 1],
    sample(px, py) {
      for (const glyph of glyphs) {
        if (px < glyph.x0 || px > glyph.x1) continue;
        if (windingInside(glyph.polys, px, py)) return [...color, 255];
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Compositor. Opaque painted background plus ordered layers, supersampled.
// ---------------------------------------------------------------------------

function render(w, h, background, layers) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  let offset = 0;
  for (let py = 0; py < h; py++) {
    raw[offset++] = 0; // filter type: none
    for (let px = 0; px < w; px++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          let [r, g, b] = background(x, y);
          for (const layer of layers) {
            const bb = layer.bbox;
            if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
            const c = layer.sample(x, y);
            if (c === null) continue;
            const a = c[3] / 255;
            r = c[0] * a + r * (1 - a);
            g = c[1] * a + g * (1 - a);
            b = c[2] * a + b * (1 - a);
          }
          rSum += r;
          gSum += g;
          bSum += b;
        }
      }
      const total = SAMPLES * SAMPLES;
      raw[offset++] = Math.round(rSum / total);
      raw[offset++] = Math.round(gSum / total);
      raw[offset++] = Math.round(bSum / total);
      raw[offset++] = 255;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// PNG encoder — the make-icons.mjs encoder generalised to W×H.
// ---------------------------------------------------------------------------

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

function toPng(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeTile(name, w, h, background, layers) {
  const png = toPng(w, h, render(w, h, background, layers));
  const file = join(OUT_DIR, name);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}

const lerp = (a, b, t) => a + (b - a) * t;
const mixColor = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];

/**
 * A hairline rounded-rectangle outline — the "form field" ghost. Outlined, not
 * filled: the brief's grid must suggest field outlines and stay well behind
 * the foreground.
 */
function ghostFieldLayer(x0, y0, x1, y1, alpha) {
  return {
    bbox: [x0 - 2, y0 - 2, x1 + 2, y1 + 2],
    sample(x, y) {
      if (Math.abs(roundedRectDistance(x, y, x0, y0, x1, y1, 6)) <= 0.7) {
        return [...RULE, Math.round(alpha * 255)];
      }
      return null;
    },
  };
}

/** A filled abstract field bar for the marquee's form. */
function fieldBarLayer(x0, y0, x1, y1, color) {
  return {
    bbox: [x0, y0, x1, y1],
    sample(x, y) {
      return roundedRectDistance(x, y, x0, y0, x1, y1, 6) <= 0 ? [...color, 255] : null;
    },
  };
}

// ---------------------------------------------------------------------------
// §4 — small promo tile, 440×280.
// ---------------------------------------------------------------------------

function smallTile(regular, semibold) {
  const W = 440;
  const H = 280;

  // Icon: left third, about 45% of the tile height.
  const markSize = 126;
  const mark = markLayer(28, (H - markSize) / 2, markSize);

  // Text column: name semibold in ink, tagline regular in muted, fitted to the
  // remaining width with the brief's 20 px clear margin on the right.
  const textX = 180;
  const textRight = W - 22;
  const nameEm = Math.min(44, (textRight - textX) / measureEm('FieldFiller', semibold));
  const tagline = 'Fill every form on the page in one click.';
  const tagEm = Math.min(12, (textRight - textX) / measureEm(tagline, regular));
  const name = textLayer('FieldFiller', { face: semibold, x: textX, baseline: 148, em: nameEm, color: INK });
  const tag = textLayer(tagline, { face: regular, x: textX, baseline: 172, em: tagEm, color: MUTED });

  // Background: flat white, a very subtle pale blue tint into the lower right
  // corner, and two faint field-outline ghosts low and behind everything.
  const diag = Math.hypot(W, H);
  const background = (x, y) => {
    const d = Math.hypot(x - W, y - H) / (diag * 0.62);
    const a = Math.max(0, 1 - d) * 0.5;
    return mixColor(WHITE, TINT, a);
  };

  writeTile('promo-440x280.png', W, H, background, [
    ghostFieldLayer(190, 198, 404, 224, 0.5),
    ghostFieldLayer(190, 234, 310, 258, 0.5),
    mark,
    name,
    tag,
  ]);
}

// ---------------------------------------------------------------------------
// §5 — marquee promo tile, 1400×560.
// ---------------------------------------------------------------------------

function marqueeTile(regular, semibold) {
  const W = 1400;
  const H = 560;

  // Left 40%: the mark at about 30% of the banner height, name below it, one
  // grey supporting line under that.
  const markSize = 168;
  const markX = 120;
  const markY = 137;
  const nameEm = Math.min(66, (640 - 40 - markX) / measureEm('FieldFiller', semibold));
  const support = 'Plausible data for every field.';
  const supportEm = 25;
  const nameBaseline = markY + markSize + 34 + INTER_CAP * nameEm;
  const mark = markLayer(markX, markY, markSize);
  const name = textLayer('FieldFiller', { face: semibold, x: markX, baseline: nameBaseline, em: nameEm, color: INK });
  const tag = textLayer(support, {
    face: regular,
    x: markX,
    baseline: nameBaseline + 24 + INTER_CAP * supportEm,
    em: supportEm,
    color: MUTED,
  });

  // Right 60%: the abstract form — seven rounded bars of varying width, evenly
  // spaced, three filled solid in brand blue as though completed. No text in
  // them; they are bars, not a readable form.
  const formLeft = 640;
  const formRight = W - 60;
  const formWidth = formRight - formLeft;
  const widths = [0.92, 0.66, 0.84, 0.5, 0.88, 0.62, 0.38];
  const blueBars = new Set([1, 2, 5]);
  const barH = 26;
  const gap = 18;
  const formTop = (H - (widths.length * barH + (widths.length - 1) * gap)) / 2;
  const bars = widths.map((frac, i) =>
    fieldBarLayer(
      formLeft,
      formTop + i * (barH + gap),
      formLeft + formWidth * frac,
      formTop + i * (barH + gap) + barH,
      blueBars.has(i) ? BLUE : RULE,
    ),
  );

  // Background: flat near-white with an extremely subtle vertical tint toward
  // a pale blue-grey. Nothing else.
  const background = (x, y) => mixColor(WHITE, [0xf2, 0xf5, 0xfa], y / H);

  writeTile('promo-1400x560.png', W, H, background, [mark, name, tag, ...bars]);
}

mkdirSync(OUT_DIR, { recursive: true });
const regular = loadFace(join(FONT_DIR, 'inter-latin-400-normal.woff'));
regular.name = 'Inter Regular';
const semibold = loadFace(join(FONT_DIR, 'inter-latin-600-normal.woff'));
semibold.name = 'Inter SemiBold';
smallTile(regular, semibold);
marqueeTile(regular, semibold);
