// Generates the PWA icons (PNG) with no dependencies: a tiny signed-distance rasteriser plus a PNG encoder.
//   npm run icons
//
// How it works: for every pixel we take 3×3 sub-samples and ask "is this point inside the shape?". The
// share of samples inside is the pixel's coverage, which gives smooth anti-aliased edges.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FOREST = [14, 59, 47];
const PAPER = [245, 242, 234];
const MINT = [155, 231, 192];

// The tally mark, in a 24-unit box (matches the in-app BrandMark).
const strokes = [
  { a: [6, 5], b: [6, 19], w: 2.4, c: PAPER },
  { a: [10.5, 5], b: [10.5, 19], w: 2.4, c: PAPER },
  { a: [15, 5], b: [15, 19], w: 2.4, c: PAPER },
  { a: [19.5, 5], b: [19.5, 19], w: 2.4, c: PAPER },
  { a: [3, 16.5], b: [21, 7.5], w: 2.2, c: MINT },
];

const distToSegment = (px, py, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
};
// Distance from a point to a rounded rectangle centred at (c,c) with half-size h and corner radius r.
const roundRect = (px, py, size, r) => {
  const c = size / 2;
  const qx = Math.abs(px - c) - (c - r), qy = Math.abs(py - c) - (c - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

function render(size, { maskable }) {
  const art = size * (maskable ? 0.5 : 0.58); // maskable icons keep the art inside the central safe zone
  const scale = art / 24;
  const off = (size - art) / 2;
  const radius = size * 0.22;
  const buf = Buffer.alloc(size * size * 4);
  const N = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const px = x + (sx + 0.5) / N, py = y + (sy + 0.5) / N;
          const inBg = maskable || roundRect(px, py, size, radius) <= 0;
          if (!inBg) continue;
          let col = FOREST;
          const ux = (px - off) / scale, uy = (py - off) / scale;
          for (const s of strokes) {
            if (distToSegment(ux, uy, s.a, s.b) <= s.w / 2) col = s.c;
          }
          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = N * N;
      const i = (y * size + x) * 4;
      const cov = a / 255; // number of covered samples
      if (cov > 0) {
        buf[i] = Math.round(r / cov); buf[i + 1] = Math.round(g / cov); buf[i + 2] = Math.round(b / cov);
        buf[i + 3] = Math.round((cov / n) * 255);
      }
    }
  }
  return buf;
}

// ---- minimal PNG encoder ------------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [file, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  fs.writeFileSync(path.join(OUT, file), png(size, render(size, { maskable })));
  console.log(`wrote public/${file}`);
}
