'use strict';
/**
 * The app's launcher/tab icons, derived from the ONE brand asset.
 *
 * Why this exists: the generated icons used to be hand-made files that had
 * drifted from the logo. The pastor's launcher icon was a bare "V" on a maroon
 * tile while the app itself showed the roundel, so an installed app and the
 * screen inside it disagreed about what the church looks like. Deriving every
 * icon from vrt-logo.png means there is exactly one place to change the brand,
 * and no icon can quietly fall behind it.
 *
 * Pure Node (zlib + hand-parsed PNG chunks, same approach as trim-png.js): no
 * image library, no new dependency, and nothing to install on the church's
 * machine to regenerate the icons.
 *
 * What it writes, for each client's public/ directory:
 *   icon-192.png, icon-512.png   launcher / manifest icons
 *   apple-touch-icon.png         iOS home screen (180px, the size iOS asks for)
 *   favicon.ico                  the tab icon (16/32/48), also what a browser
 *                                requests unprompted at /favicon.ico
 *
 * The roundel is laid on the app's own paper color, NOT transparency, so the
 * icon is legible whichever surface the launcher paints (a maskable icon must
 * survive being cropped to a circle, and an opaque tile is what makes that
 * safe): the artwork sits inside the central 76% that every launcher mask
 * keeps, and the resize is an area average of the source pixels, so fine
 * strokes of the wordmark never alias into noise on the way down.
 *
 * Usage: node scripts/make-app-icons.js [logo.png]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SOURCE = process.argv[2] || path.join(__dirname, '..', 'client-pastor', 'public', 'vrt-logo.png');
const TARGETS = [
  path.join(__dirname, '..', 'client-pastor', 'public'),
  path.join(__dirname, '..', 'client-admin', 'public'),
];
// Fraction of the tile the roundel's artwork fills. Launchers crop maskable
// icons to the inner 80%, iOS to a squircle inside the full square, so a
// little margin here is what keeps the ring whole on both.
const ARTWORK = 0.76;
const SIZES = [
  { file: 'icon-192.png', px: 192, fill: ARTWORK },
  { file: 'icon-512.png', px: 512, fill: ARTWORK },
  { file: 'apple-touch-icon.png', px: 180, fill: ARTWORK },
];
// The tab icon, in the sizes a browser and a Windows shortcut ask for. Nothing
// crops these and nothing is painted around them, so the artwork can fill
// almost the whole square: at 16px the ring is about two pixels wide, and every
// pixel of margin taken here is one taken from the logo.
const FAVICON_SIZES = [16, 32, 48];
const FAVICON_FILL = 0.95;
// --color-paper in both clients' index.css, and the PWA's background_color.
const PAPER = [0xfd, 0xfb, 0xf6];

// ---- decode -------------------------------------------------------------
/** Decode an 8-bit RGB/RGBA PNG into { width, height, rgba }. */
function decodePng(buf) {
  let pos = 8; // signature
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
  if (!ihdr || !idat.length) throw new Error('not a usable PNG');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} (need 8-bit RGB or RGBA)`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const lines = [];
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
    }
    lines.push(line);
    line.copy(prev);
  }
  // Normalize to RGBA: the math below is easier with one shape.
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = lines[y];
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      rgba[d] = line[s];
      rgba[d + 1] = line[s + 1];
      rgba[d + 2] = line[s + 2];
      rgba[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, rgba };
}

// ---- encode -------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(b) {
  let c = -1;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/**
 * Encode { width, height, rgba } as an 8-bit RGBA PNG.
 *
 * Rows are filtered adaptively (each row gets whichever of the five PNG
 * filters leaves the smallest values): the artwork is mostly smooth gradients,
 * where a fixed "no filter" row costs several times the bytes: an unfiltered
 * 512px icon lands near 150KB for what a filtered one stores in a fraction of
 * that, and this file is fetched over mobile data when the app is installed.
 */
function encodePng({ width, height, rgba }) {
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    rgba.copy(line, 0, y * stride, (y + 1) * stride);
    let best = -1;
    let bestScore = 0;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        switch (filter) {
          case 1: v = line[x] - a; break;
          case 2: v = line[x] - b; break;
          case 3: v = line[x] - ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = line[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: v = line[x];
        }
        v &= 0xff;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (best === -1 || score < bestScore) {
        best = filter;
        bestScore = score;
        candidate.copy(raw, y * (stride + 1) + 1);
      }
    }
    raw[y * (stride + 1)] = best;
    line.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- pixels -------------------------------------------------------------
/** The box of pixels that are not transparent: the logo's own artwork. */
function artworkBox({ width, height, rgba }) {
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < 16) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0) throw new Error('image is entirely transparent');
  return { left, top, right, bottom };
}

/**
 * Area-average resize of a source rectangle to dw x dh.
 *
 * Premultiplied by alpha before averaging: averaging straight color would drag
 * transparent pixels' (usually black) RGB into the edges and ring the artwork
 * with a dark halo.
 */
function resize(src, box, dw, dh) {
  const { width, rgba } = src;
  const sw = box.right - box.left + 1;
  const sh = box.bottom - box.top + 1;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = box.top + Math.floor((y * sh) / dh);
    const y1 = box.top + Math.max(y0 - box.top + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = box.left + Math.floor((x * sw) / dw);
      const x1 = box.left + Math.max(x0 - box.left + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * width + sx) * 4;
          const alpha = rgba[s + 3] / 255;
          r += rgba[s] * alpha;
          g += rgba[s + 1] * alpha;
          b += rgba[s + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const d = (y * dw + x) * 4;
      if (a > 0) {
        out[d] = Math.round(r / a);
        out[d + 1] = Math.round(g / a);
        out[d + 2] = Math.round(b / a);
      }
      out[d + 3] = Math.round((a / n) * 255);
    }
  }
  return { width: dw, height: dh, rgba: out };
}

/** The (already scaled) roundel, centered on a square of paper. */
function compose(art, size) {
  const tile = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    tile[i * 4] = PAPER[0];
    tile[i * 4 + 1] = PAPER[1];
    tile[i * 4 + 2] = PAPER[2];
    tile[i * 4 + 3] = 255;
  }
  const ox = Math.round((size - art.width) / 2);
  const oy = Math.round((size - art.height) / 2);
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const s = (y * art.width + x) * 4;
      const alpha = art.rgba[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((oy + y) * size + (ox + x)) * 4;
      tile[d] = Math.round(art.rgba[s] * alpha + tile[d] * (1 - alpha));
      tile[d + 1] = Math.round(art.rgba[s + 1] * alpha + tile[d + 1] * (1 - alpha));
      tile[d + 2] = Math.round(art.rgba[s + 2] * alpha + tile[d + 2] * (1 - alpha));
    }
  }
  return tile;
}

/**
 * Encode PNG images as an .ico: the container a tab and a Windows shortcut ask
 * for, in one file holding several sizes so the shell can pick its own.
 *
 * An ICO is a flat directory of images: a six-byte header, one 16-byte entry per
 * image, then the images. PNG-encoded entries are what every browser and every
 * Windows since Vista understands (the older BMP form is only needed for icons
 * older than that).
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  images.forEach(({ px, png }, i) => {
    const entry = i * 16;
    // A one-byte dimension, where 0 stands for 256 (and the only reason a
    // square icon is never written at 256 px here).
    const dimension = px >= 256 ? 0 : px;
    directory[entry] = dimension;
    directory[entry + 1] = dimension;
    directory[entry + 2] = 0; // palette size: 0 for a true-colour image
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

// ---- run ----------------------------------------------------------------
const source = decodePng(fs.readFileSync(SOURCE));
const box = artworkBox(source);
const artworkW = box.right - box.left + 1;
const artworkH = box.bottom - box.top + 1;

/**
 * The roundel rendered into a px-sized square, its artwork filling `fill` of it.
 *
 * Scaling the ARTWORK (not the padded canvas) is what makes every icon show the
 * roundel at the same visual size despite the source's margins.
 */
function renderIcon(px, fill) {
  const scale = (px * fill) / Math.max(artworkW, artworkH);
  const art = resize(
    source,
    box,
    Math.max(1, Math.round(artworkW * scale)),
    Math.max(1, Math.round(artworkH * scale))
  );
  return encodePng({ width: px, height: px, rgba: compose(art, px) });
}
console.log(
  `source ${path.relative(process.cwd(), SOURCE)} ${source.width}x${source.height}, artwork ` +
  `${artworkW}x${artworkH} at (${box.left},${box.top})`
);
/** A path relative to the shell's cwd, with forward slashes on every platform. */
function shown(file) {
  return path.relative(process.cwd(), file).replace(/\\/g, '/');
}

for (const dir of TARGETS) {
  if (!fs.existsSync(dir)) continue;
  for (const { file, px, fill } of SIZES) {
    const png = renderIcon(px, fill);
    const out = path.join(dir, file);
    fs.writeFileSync(out, png);
    console.log(`  ${shown(out)}  ${px}x${px}  ${(png.length / 1024).toFixed(1)}KB`);
  }
  const ico = encodeIco(FAVICON_SIZES.map((px) => ({ px, png: renderIcon(px, FAVICON_FILL) })));
  const icoFile = path.join(dir, 'favicon.ico');
  fs.writeFileSync(icoFile, ico);
  console.log(`  ${shown(icoFile)}  ${FAVICON_SIZES.join('/')}  ${(ico.length / 1024).toFixed(1)}KB`);
}
