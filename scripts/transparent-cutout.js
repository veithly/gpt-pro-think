#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function usage() {
  process.stderr.write(`transparent-cutout.js - remove a high-contrast solid background from a PNG

Usage:
  node scripts/transparent-cutout.js input.png [output.png] [--threshold N] [--padding N] [--bg R,G,B] [--no-crop]

Defaults:
  threshold: 36
  padding:   16
  bg:        average of the four corners

The algorithm only removes background pixels connected to an image edge, so
same-colored details inside the subject are preserved.
`);
}

function parseArgs(argv) {
  const opts = { threshold: 36, padding: 16, crop: true, bg: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--threshold') opts.threshold = Number(argv[++i]);
    else if (arg === '--padding') opts.padding = Number(argv[++i]);
    else if (arg === '--bg') opts.bg = parseColor(argv[++i]);
    else if (arg === '--no-crop') opts.crop = false;
    else positional.push(arg);
  }
  opts.input = positional[0] || '';
  opts.output = positional[1] || defaultOutputPath(opts.input);
  if (!Number.isFinite(opts.threshold)) opts.threshold = 36;
  if (!Number.isFinite(opts.padding)) opts.padding = 16;
  opts.threshold = Math.max(0, opts.threshold);
  opts.padding = Math.max(0, Math.floor(opts.padding));
  return opts;
}

function defaultOutputPath(input) {
  if (!input) return '';
  const parsed = path.parse(input);
  return path.join(parsed.dir, `${parsed.name}-transparent.png`);
}

function parseColor(value) {
  const raw = String(value || '').trim();
  const hex = raw.match(/^#?([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = raw.split(',').map((part) => Number(part.trim()));
  if (rgb.length === 3 && rgb.every((n) => Number.isFinite(n))) {
    return rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))));
  }
  throw new Error(`invalid --bg color: ${value}`);
}

function readPng(filePath) {
  const buf = fs.readFileSync(filePath);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!ihdr) throw new Error('missing IHDR');
  if (ihdr.bitDepth !== 8 || ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) {
    throw new Error('unsupported PNG: only 8-bit non-interlaced PNGs are supported');
  }
  if (![2, 6].includes(ihdr.colorType)) {
    throw new Error('unsupported PNG color type: expected RGB or RGBA');
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = ihdr.colorType === 6 ? 4 : 3;
  const rows = unfilter(raw, ihdr.width, ihdr.height, channels);
  return { ...ihdr, rgba: toRgba(rows, ihdr.width, ihdr.height, channels) };
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      const value = raw[src++];
      let recon;
      if (filter === 0) recon = value;
      else if (filter === 1) recon = value + left;
      else if (filter === 2) recon = value + up;
      else if (filter === 3) recon = value + Math.floor((left + up) / 2);
      else if (filter === 4) recon = value + paeth(left, up, upLeft);
      else throw new Error(`unsupported PNG filter: ${filter}`);
      out[rowStart + x] = recon & 255;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function toRgba(rows, width, height, channels) {
  if (channels === 4) return Buffer.from(rows);
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    rgba[j] = rows[i];
    rgba[j + 1] = rows[i + 1];
    rgba[j + 2] = rows[i + 2];
    rgba[j + 3] = 255;
  }
  return rgba;
}

function inferBackground(rgba, width, height) {
  const points = [
    pixel(rgba, width, 0, 0),
    pixel(rgba, width, width - 1, 0),
    pixel(rgba, width, 0, height - 1),
    pixel(rgba, width, width - 1, height - 1),
  ];
  return [0, 1, 2].map((channel) => Math.round(points.reduce((sum, p) => sum + p[channel], 0) / points.length));
}

function pixel(rgba, width, x, y) {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

function colorDistanceSq(rgba, offset, bg) {
  const dr = rgba[offset] - bg[0];
  const dg = rgba[offset + 1] - bg[1];
  const db = rgba[offset + 2] - bg[2];
  return dr * dr + dg * dg + db * db;
}

function removeConnectedBackground(rgba, width, height, bg, threshold) {
  const thresholdSq = threshold * threshold;
  const seen = new Uint8Array(width * height);
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (seen[idx]) return;
    const off = idx * 4;
    if (rgba[off + 3] === 0 || colorDistanceSq(rgba, off, bg) <= thresholdSq) {
      seen[idx] = 1;
      queue.push(idx);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  let removed = 0;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % width;
    const y = Math.floor(idx / width);
    const off = idx * 4;
    if (rgba[off + 3] !== 0) removed++;
    rgba[off + 3] = 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return removed;
}

function alphaBounds(rgba, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function crop(rgba, width, height, bounds, padding) {
  const minX = Math.max(0, bounds.minX - padding);
  const minY = Math.max(0, bounds.minY - padding);
  const maxX = Math.min(width - 1, bounds.maxX + padding);
  const maxY = Math.min(height - 1, bounds.maxY + padding);
  const outWidth = maxX - minX + 1;
  const outHeight = maxY - minY + 1;
  const out = Buffer.alloc(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    const dstStart = y * outWidth * 4;
    rgba.copy(out, dstStart, srcStart, srcStart + outWidth * 4);
  }
  return { width: outWidth, height: outHeight, rgba: out };
}

function writePng(filePath, width, height, rgba) {
  const scanline = width * 4 + 1;
  const raw = Buffer.alloc(scanline * height);
  for (let y = 0; y < height; y++) {
    raw[y * scanline] = 0;
    rgba.copy(raw, y * scanline + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunks = [
    chunk('IHDR', ihdr(width, height)),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ];
  fs.writeFileSync(filePath, Buffer.concat([PNG_SIG, ...chunks]));
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    usage();
    process.exit(opts.help ? 0 : 2);
  }
  const png = readPng(opts.input);
  const bg = opts.bg || inferBackground(png.rgba, png.width, png.height);
  const removed = removeConnectedBackground(png.rgba, png.width, png.height, bg, opts.threshold);
  let out = { width: png.width, height: png.height, rgba: png.rgba };
  const bounds = alphaBounds(png.rgba, png.width, png.height);
  if (opts.crop && bounds) out = crop(png.rgba, png.width, png.height, bounds, opts.padding);
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  writePng(opts.output, out.width, out.height, out.rgba);
  process.stdout.write(JSON.stringify({
    ok: true,
    input: path.resolve(opts.input),
    output: path.resolve(opts.output),
    width: out.width,
    height: out.height,
    background: bg,
    threshold: opts.threshold,
    removedPixels: removed,
  }, null, 2) + '\n');
}

main();
