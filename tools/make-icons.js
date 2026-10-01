#!/usr/bin/env node
/**
 * FUSION FLIX — icon generator (zero dependencies)
 * -----------------------------------------------------------------------------
 * Draws the Fusion Flix app icon procedurally and writes:
 *
 *   icons/icon.ico          multi-size Windows icon (16,24,32,48,64,128,256)
 *   icons/icon.png          512 px master
 *   icons/icon-256.png      256 px
 *   assets/icon-data.js     base64 PNG used by the renderer (welcome/About)
 *
 * The mark: a rounded "film slate" tile in Fusion Flix red-orange, a dark
 * inner band, a stylised aperture/film "FF" cut-out and a lens ring.
 * Entirely original geometry — no third-party logos involved.
 *
 * Run:  npm run icons
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'icons');
const ASSETS = path.join(ROOT, 'assets');

// ---------------------------------------------------------------------------
// Drawing canvas (RGBA, straight alpha)
// ---------------------------------------------------------------------------
class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Float32Array(size * size * 4); // premultiplied-ish accumulation
  }
  static sdfRoundedRect(px, py, cx, cy, hw, hh, r) {
    const dx = Math.abs(px - cx) - (hw - r);
    const dy = Math.abs(py - cy) - (hh - r);
    const ax = Math.max(dx, 0);
    const ay = Math.max(dy, 0);
    const inside = Math.min(Math.max(dx, dy), 0);
    return Math.sqrt(ax * ax + ay * ay) + inside - r;
  }
  static sdfCircle(px, py, cx, cy, r) {
    const dx = px - cx;
    const dy = py - cy;
    return Math.sqrt(dx * dx + dy * dy) - r;
  }
  // Rounded square-ish polygon helper: distance to line segment
  static distSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx * vx + vy * vy || 1e-6;
    let t = (wx * vx + wy * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = wx - t * vx;
    const dy = wy - t * vy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  /** Thick line with round caps: distance field -> coverage. */
  static sdfThickLine(px, py, ax, ay, bx, by, halfWidth) {
    return Canvas.distSeg(px, py, ax, ay, bx, by) - halfWidth;
  }

  /** Anti-aliased fill using a signed distance value. */
  fillSDF(sdf, r, g, b, a) {
    const s = this.size;
    const data = this.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        let cov = 0.5 - d; // 1px AA ramp
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        if (a !== undefined) cov *= a;
        const i = (y * s + x) * 4;
        data[i] = data[i] * (1 - cov) + r * cov;
        data[i + 1] = data[i + 1] * (1 - cov) + g * cov;
        data[i + 2] = data[i + 2] * (1 - cov) + b * cov;
        data[i + 3] = Math.min(1, data[i + 3] + cov);
      }
    }
  }

  /** Vertical (or angled) linear gradient fill inside an SDF mask. */
  fillGradient(sdf, c1, c2, angleDeg) {
    const s = this.size;
    const rad = (angleDeg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    let min = Infinity;
    let max = -Infinity;
    const corners = [
      [0, 0],
      [s, 0],
      [0, s],
      [s, s],
    ];
    for (const [x, y] of corners) {
      const p = x * ux + y * uy;
      if (p < min) min = p;
      if (p > max) max = p;
    }
    const span = max - min || 1;
    const data = this.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        let cov = 0.5 - d;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        let t = ((x + 0.5) * ux + (y + 0.5) * uy - min) / span;
        t = Math.max(0, Math.min(1, t));
        // smoothstep for a cleaner ramp
        t = t * t * (3 - 2 * t);
        const r = c1[0] + (c2[0] - c1[0]) * t;
        const g = c1[1] + (c2[1] - c1[1]) * t;
        const b = c1[2] + (c2[2] - c1[2]) * t;
        const i = (y * s + x) * 4;
        data[i] = data[i] * (1 - cov) + r * cov;
        data[i + 1] = data[i + 1] * (1 - cov) + g * cov;
        data[i + 2] = data[i + 2] * (1 - cov) + b * cov;
        data[i + 3] = Math.min(1, data[i + 3] + cov);
      }
    }
  }

  /** Punch a hole (reduces alpha) using an SDF. */
  cutSDF(sdf) {
    const s = this.size;
    const data = this.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        let cov = 0.5 - d;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        const i = (y * s + x) * 4;
        data[i + 3] *= 1 - cov;
      }
    }
  }

  /** Per-pixel colour modulation inside a mask (used for shading). */
  shade(sdf, fn) {
    const s = this.size;
    const data = this.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        let cov = 0.5 - d;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        const i = (y * s + x) * 4;
        const res = fn(x + 0.5, y + 0.5, cov);
        if (!res) continue;
        // res[3] (0..1) scales the mask coverage so shading is soft.
        const k = cov * (res.length > 3 ? Math.max(0, Math.min(1, res[3])) : 1);
        if (k <= 0) continue;
        data[i] = data[i] * (1 - k) + res[0] * k;
        data[i + 1] = data[i + 1] * (1 - k) + res[1] * k;
        data[i + 2] = data[i + 2] * (1 - k) + res[2] * k;
      }
    }
  }

  /** Downsample (box filter) for supersampled anti-aliasing. */
  downsample(factor) {
    const out = new Canvas(this.size / factor);
    const s = this.size;
    const f = factor;
    const data = this.data;
    const od = out.data;
    const os = out.size;
    for (let y = 0; y < os; y++) {
      for (let x = 0; x < os; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let j = 0; j < f; j++) {
          for (let i = 0; i < f; i++) {
            const idx = ((y * f + j) * s + (x * f + i)) * 4;
            const al = data[idx + 3];
            r += data[idx] * al;
            g += data[idx + 1] * al;
            b += data[idx + 2] * al;
            a += al;
          }
        }
        const n = f * f;
        const o = (y * os + x) * 4;
        if (a > 0) {
          od[o] = r / a;
          od[o + 1] = g / a;
          od[o + 2] = b / a;
        }
        od[o + 3] = a / n;
      }
    }
    return out;
  }

  /** Composite another canvas over this one (source-over), scaled by `alpha`. */
  drawOver(other, alpha = 1) {
    if (other.size !== this.size) throw new Error('size mismatch');
    const data = this.data;
    const od = other.data;
    for (let i = 0; i < data.length; i += 4) {
      const sa = od[i + 3] * alpha;
      if (sa <= 0) continue;
      const da = data[i + 3];
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      data[i] = (od[i] * sa + data[i] * da * (1 - sa)) / oa;
      data[i + 1] = (od[i + 1] * sa + data[i + 1] * da * (1 - sa)) / oa;
      data[i + 2] = (od[i + 2] * sa + data[i + 2] * da * (1 - sa)) / oa;
      data[i + 3] = oa;
    }
  }
}

// ---------------------------------------------------------------------------
// The artwork
// ---------------------------------------------------------------------------
const S = 1024; // working resolution
const SS = 2; // supersample factor
const W = S * SS;

/** Draws the icon at supersampled resolution. */
function drawIcon(px = W) {
  const c = new Canvas(px);
  const u = px / 1024; // unit scale (all coordinates below are in 1024-space)

  const BRAND_TOP = [0.949, 0.337, 0.184]; // #F25630 fusion orange
  const BRAND_BOTTOM = [0.812, 0.169, 0.106]; // #CF2B1B deep red

  // --- Tile: rounded square, soft brand gradient ----------------------------
  const tileR = 238 * u;
  const tile = (x, y) => Canvas.sdfRoundedRect(x, y, 512 * u, 512 * u, 512 * u, 512 * u, tileR);
  c.fillGradient(tile, BRAND_TOP, BRAND_BOTTOM, 88);

  // --- Minimal "FF" monogram -------------------------------------------------
  // Flat, geometric letterforms built from three bars each — the same
  // discipline as the Adobe product marks: no film gate, no sprockets, no
  // decoration. Reads instantly at 16 px and at 512 px.
  const bone = [1, 1, 1];
  const bar = (cx, cy, hw, hh, r) => (x, y) =>
    Canvas.sdfRoundedRect(x, y, cx * u, cy * u, hw * u, hh * u, r * u);
  const drawF = (x0) => {
    c.fillSDF(bar(x0 + 40, 516, 40, 192, 18), bone[0], bone[1], bone[2], 1); // stem
    c.fillSDF(bar(x0 + 134, 362, 134, 40, 18), bone[0], bone[1], bone[2], 1); // top arm
    c.fillSDF(bar(x0 + 104, 498, 104, 36, 16), bone[0], bone[1], bone[2], 1); // middle arm
  };
  drawF(224);
  drawF(528);

  return c;
}

// ---------------------------------------------------------------------------
// PNG writer
// ---------------------------------------------------------------------------
function crc32Table() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_TABLE = crc32Table();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function toRGBA8(canvas) {
  const out = Buffer.alloc(canvas.size * canvas.size * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = canvas.data[i + 3];
    if (a <= 0.0001) continue;
    const r = Math.round(Math.min(1, Math.max(0, canvas.data[i])) * 255);
    const g = Math.round(Math.min(1, Math.max(0, canvas.data[i + 1])) * 255);
    const b = Math.round(Math.min(1, Math.max(0, canvas.data[i + 2])) * 255);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return out;
}
function encodePNG(canvas) {
  const size = canvas.size;
  const rgba = toRGBA8(canvas);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// ICO writer (BMP/DIB for small sizes, PNG for large sizes — max compatibility)
// ---------------------------------------------------------------------------
function encodeBMPEntry(canvas) {
  const size = canvas.size;
  const rgba = toRGBA8(canvas);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);
  header.writeInt32LE(0, 24);
  header.writeInt32LE(0, 28);
  header.writeUInt32LE(0, 32);
  header.writeUInt32LE(0, 36);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      const a = rgba[s + 3] / 255;
      // Premultiply for the XOR bitmap (required for 32bpp ICO)
      xor[d] = Math.round(rgba[s + 2] * a);
      xor[d + 1] = Math.round(rgba[s + 1] * a);
      xor[d + 2] = Math.round(rgba[s] * a);
      xor[d + 3] = rgba[s + 3];
    }
  }
  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size, 0); // fully opaque mask (alpha used)
  return Buffer.concat([header, xor, and]);
}

function encodeICO(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach((e, i) => {
    const p = i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size;
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir[p + 2] = 0;
    dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(e.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
    blobs.push(e.data);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function render(size) {
  const base = drawIcon(S * SS);
  // apply lighting in supersampled space
  const u = (S * SS) / 1024;
  const px = S * SS;
  const tileSdf = (x, y) => Canvas.sdfRoundedRect(x, y, 512 * u, 512 * u, 512 * u, 512 * u, 232 * u);
  // Soft directional sheen: bright near the top-left, fading out smoothly.
  base.shade(tileSdf, (x, y, cov) => {
    const g = (x / px) * 0.6 + (y / px) * 0.4; // 0 at top-left -> 1 at bottom-right
    const strength = Math.pow(Math.max(0, 1 - g / 0.62), 2.1) * 0.20;
    if (strength < 0.004) return null;
    return [1, 0.93, 0.88, strength];
  });
  // Gentle vignette toward the bottom-right for depth.
  base.shade(tileSdf, (x, y, cov) => {
    const g = (x / px) * 0.6 + (y / px) * 0.4;
    const strength = Math.pow(Math.max(0, (g - 0.55) / 0.45), 1.8) * 0.16;
    if (strength < 0.004) return null;
    return [0.18, 0.05, 0.03, strength];
  });
  const small = base.downsample(SS); // 1024
  if (size === 1024) return small;
  // simple box-filter downscale to requested size
  const ratio = 1024 / size;
  if (!Number.isInteger(ratio)) {
    // fall back to nearest-neighbour for odd sizes
    const out = new Canvas(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sx = Math.min(1023, Math.floor((x + 0.5) * ratio));
        const sy = Math.min(1023, Math.floor((y + 0.5) * ratio));
        const s = (sy * 1024 + sx) * 4;
        const d = (y * size + x) * 4;
        for (let k = 0; k < 4; k++) out.data[d + k] = small.data[s + k];
      }
    }
    return out;
  }
  const out = new Canvas(size);
  const f = ratio;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
          const s = ((y * f + j) * 1024 + (x * f + i)) * 4;
          const al = small.data[s + 3];
          r += small.data[s] * al;
          g += small.data[s + 1] * al;
          b += small.data[s + 2] * al;
          a += al;
        }
      }
      const o = (y * size + x) * 4;
      const n = f * f;
      if (a > 0) {
        out.data[o] = r / a;
        out.data[o + 1] = g / a;
        out.data[o + 2] = b / a;
      }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

function main() {
  fs.mkdirSync(ICONS, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => {
    const canvas = render(size);
    // PNG for big sizes (better quality/size), DIB for small shell sizes
    const data = size >= 128 ? encodePNG(canvas) : encodeBMPEntry(canvas);
    return { size, data };
  });

  const ico = encodeICO(entries);
  fs.writeFileSync(path.join(ICONS, 'icon.ico'), ico);

  const png512 = encodePNG(render(512));
  fs.writeFileSync(path.join(ICONS, 'icon.png'), png512);
  fs.writeFileSync(path.join(ICONS, 'icon-256.png'), encodePNG(render(256)));
  fs.writeFileSync(path.join(ICONS, 'icon-512.png'), png512);

  // Inline copy for the renderer (works with the strict CSP / offline).
  fs.writeFileSync(
    path.join(ASSETS, 'icon-data.js'),
    '/* Auto-generated by tools/make-icons.js — Fusion Flix app mark. */\n' +
      "'use strict';\n" +
      'window.FUSION_FLIX_ICON = "data:image/png;base64,' +
      png512.toString('base64') +
      '";\n'
  );

  process.stdout.write(
    `Fusion Flix icons written:\n  icons/icon.ico (${sizes.join(', ')} px)\n  icons/icon.png, icon-256.png, icon-512.png\n  assets/icon-data.js\n`
  );
}

main();
