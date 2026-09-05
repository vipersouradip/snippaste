/* Generates the extension icons as PNGs — no image deps, just zlib.
   Run with: node tools/gen-icons.js                                  */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor per axis

/* ---- shape helpers, all in 0..1 normalized space ---- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/* Crop-mark brackets around a solid chip — the selection, and what comes out of
   it. Matches the mark drawn in site/index.html and the extension's own button.

   Proportions are tuned for the 16px icon, where the brackets are only ~1.6px
   wide: any thinner and they grey out into the tile once antialiased. */
function inGlyph(x, y) {
  const t = 0.092;          // stroke thickness
  const i = 0.15;           // inset from the edge
  const a = 0.27;           // arm length, corner included
  const r = t / 2;          // round caps, to match the SVG mark's stroke-linecap
  const j = i + a;
  const k = 1 - i - a;      // mirrored arm start
  const arm = (x0, y0, x1, y1) => inRoundedRect(x, y, x0, y0, x1, y1, r);
  if (arm(i, i, j, i + t) || arm(i, i, i + t, j)) return true;                       // top-left
  if (arm(k, i, 1 - i, i + t) || arm(1 - i - t, i, 1 - i, j)) return true;           // top-right
  if (arm(i, 1 - i - t, j, 1 - i) || arm(i, k, i + t, 1 - i)) return true;           // bottom-left
  if (arm(k, 1 - i - t, 1 - i, 1 - i) || arm(1 - i - t, k, 1 - i, 1 - i)) return true;
  return inRoundedRect(x, y, 0.385, 0.385, 0.615, 0.615, 0.062);   // the chip
}

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.23)) continue;
          bgHits++;
          if (inGlyph(x, y)) fgHits++;
        }
      }
      const total = SS * SS;
      const alpha = bgHits / total;
      const fg = fgHits / total;
      // A quiet vertical gradient, #6366F1 -> #4338CA. The old diagonal
      // indigo-to-violet fought with the glyph at small sizes.
      const g = clamp01(py / size);
      const bgR = 99 + (67 - 99) * g;
      const bgG = 102 + (56 - 102) * g;
      const bgB = 241 + (202 - 241) * g;
      const mix = alpha > 0 ? fg / alpha : 0;
      const o = (py * size + px) * 4;
      buf[o] = Math.round(bgR + (255 - bgR) * mix);
      buf[o + 1] = Math.round(bgG + (255 - bgG) * mix);
      buf[o + 2] = Math.round(bgB + (255 - bgB) * mix);
      buf[o + 3] = Math.round(alpha * 255);
    }
  }
  void step;
  return buf;
}

/* ---- minimal PNG writer ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, encodePNG(renderRGBA(size), size));
  console.log('wrote', path.relative(path.join(__dirname, '..'), file));
}
