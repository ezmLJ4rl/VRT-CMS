'use strict';
/**
 * Trim a PNG's uniform white margins down to a small even padding.
 *
 * Pure Node: PNG chunks are parsed by hand, IDAT is inflated with zlib, the
 * scanlines are unfiltered, the bounding box of non-white pixels is measured,
 * and the crop is re-encoded with filter 0 rows. No image library, no new
 * dependency — the server's logo endpoint takes it from here.
 *
 * Usage: node scripts/trim-png.js <in.png> <out.png> [padding]
 */
const fs = require('fs');
const zlib = require('zlib');

const [, , inPath, outPath, padArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/trim-png.js <in.png> <out.png> [padding=8]');
  process.exit(1);
}
const PAD = Number(padArg) || 8;

const buf = fs.readFileSync(inPath);

// ---- parse chunks -------------------------------------------------------
let pos = 8; // skip signature
let ihdr = null;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') ihdr = data;
  else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  pos += 12 + len;
}
if (!ihdr || !idat.length) {
  console.error('not a usable PNG');
  process.exit(1);
}

const width = ihdr.readUInt32BE(0);
const height = ihdr.readUInt32BE(4);
const bitDepth = ihdr[8];
const colorType = ihdr[9];
if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
  console.error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} (need 8-bit RGB or RGBA)`);
  process.exit(1);
}
const channels = colorType === 6 ? 4 : 3;
const bpp = channels; // bytes per pixel
const stride = width * bpp;

// ---- inflate + unfilter -------------------------------------------------
const raw = zlib.inflateSync(Buffer.concat(idat));
const lines = [];
const prev = Buffer.alloc(stride);
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? line[x - bpp] : 0;
    const b = prev[x];
    const c = x >= bpp ? prev[x - bpp] : 0;
    switch (filter) {
      case 1: line[x] = (line[x] + a) & 0xff; break; // Sub
      case 2: line[x] = (line[x] + b) & 0xff; break; // Up
      case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break; // Average
      case 4: { // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[x] = (line[x] + pr) & 0xff;
        break;
      }
    }
  }
  lines.push(line);
  line.copy(prev);
}

// ---- bounding box of non-white pixels -----------------------------------
// "White" is anything with every channel ≥ 250 (JPEG-ish ring near white);
// alpha < 8 also counts as background.
let top = height, bottom = -1, left = width, right = -1;
for (let y = 0; y < height; y++) {
  const line = lines[y];
  for (let x = 0; x < width; x++) {
    const o = x * bpp;
    const alpha = colorType === 6 ? line[o + 3] : 255;
    const isBg =
      (alpha < 8) ||
      (line[o] >= 250 && line[o + 1] >= 250 && line[o + 2] >= 250 && (colorType !== 6 || alpha >= 248));
    if (!isBg) {
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
}
if (bottom < 0) {
  console.error('image is entirely background');
  process.exit(1);
}

// Even padding, clamped to the image.
const cx0 = Math.max(0, left - PAD);
const cy0 = Math.max(0, top - PAD);
const cx1 = Math.min(width - 1, right + PAD);
const cy1 = Math.min(height - 1, bottom + PAD);
const newW = cx1 - cx0 + 1;
const newH = cy1 - cy0 + 1;

// ---- re-encode (filter 0 rows) ------------------------------------------
const out = Buffer.alloc(newH * (newW * bpp + 1));
for (let y = 0; y < newH; y++) {
  const src = lines[cy0 + y];
  out[y * (newW * bpp + 1)] = 0;
  src.copy(out, y * (newW * bpp + 1) + 1, cx0 * bpp, (cx1 + 1) * bpp);
}

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
const crc32 = (b) => {
  let c = -1;
  for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
};

const outIhdr = Buffer.alloc(13);
outIhdr.writeUInt32BE(newW, 0);
outIhdr.writeUInt32BE(newH, 4);
outIhdr[8] = 8;
outIhdr[9] = colorType;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', outIhdr),
  chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(outPath, png);
console.log(`original ${width}x${height} → content box (${left},${top})..(${right},${bottom}) → ${newW}x${newH} with ${PAD}px pad, ${(png.length / 1024).toFixed(0)}KB`);
