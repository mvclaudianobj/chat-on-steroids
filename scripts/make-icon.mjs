/**
 * Generates Marks application icons from the original transparent colour artwork,
 * with no image dependencies.
 *
 *   build/icon.ico            the Windows app icon (6 sizes in one file)
 *   build/icon.png            1024px source for macOS/Linux packaging (Retina-ready ICNS input)
 *   build/icon-preview.png    256px preview, for looking at what changed
 *   build/runtime-icon.png    256px Linux/Windows BrowserWindow icon, packaged as a real resource
 *   build/icons/NxN.png       Linux hicolor set: menus, launchers and the taskbar look the icon up
 *                             by size, and themes list no 1024px folder (only 1024px was blank)
 *   extension/icons/*.png     16/32/48/128 for the Chrome extension
 *   src/renderer/browser-icons/cos.png  in-app browser and brand logo
 *
 *   icon_marks.png           user's original transparent full-colour artwork
 *
 * Preserve the original colours, transparency and fine details at every resolution.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const EXTENSION_SIZES = [128, 48, 32, 16];
const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512];
const SOURCE_PATH = path.join(root, 'icon_marks.png');

// ------------------------------------------------------------- source png

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

/** Decode the one controlled RGBA source PNG without adding a native image dependency. */
function decodeSourcePng(encoded) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (encoded.length < signature.length || !encoded.subarray(0, 8).equals(signature)) {
    throw new Error('icon_marks.png is not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  for (let offset = 8; offset + 12 <= encoded.length; ) {
    const length = encoded.readUInt32BE(offset);
    const type = encoded.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > encoded.length) throw new Error('truncated app icon PNG');
    if (type === 'IHDR') {
      width = encoded.readUInt32BE(start);
      height = encoded.readUInt32BE(start + 4);
      bitDepth = encoded[start + 8];
      colourType = encoded[start + 9];
      interlace = encoded[start + 12];
    } else if (type === 'IDAT') {
      idat.push(encoded.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (width < 1 || height < 1 || bitDepth !== 8 || colourType !== 6 || interlace !== 0 || idat.length === 0) {
    throw new Error('app icon source must be a non-interlaced 8-bit RGBA PNG');
  }

  const stride = width * 4;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error('unexpected app icon PNG data length');
  const pixels = Buffer.alloc(width * height * 4);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[input++];
    if (filter > 4) throw new Error(`unsupported app icon PNG filter ${filter}`);
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[row + x - 4] : 0;
      const up = y > 0 ? pixels[row + x - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[row + x - stride - 4] : 0;
      let value = inflated[input++];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upperLeft);
      pixels[row + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

const source = decodeSourcePng(readFileSync(SOURCE_PATH));

// Keep disconnected whiskers and highlights as well as the main silhouette.
const visibleSource = new Uint8Array(source.width * source.height);
for (let index = 0; index < visibleSource.length; index++) {
  visibleSource[index] = source.pixels[index * 4 + 3] >= 8 ? 1 : 0;
}

/** Tight square crop with deliberate breathing room, derived from visible source alpha. */
function sourceCrop() {
  let left = source.width;
  let top = source.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (visibleSource[y * source.width + x] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('app icon source contains no visible pixels');
  const visible = Math.max(right - left + 1, bottom - top + 1);
  const side = visible / 0.92; // 4% transparent padding on every side.
  return {
    left: (left + right + 1 - side) / 2,
    top: (top + bottom + 1 - side) / 2,
    side
  };
}

const crop = sourceCrop();

/**
 * Area-resample the source in its original RGB palette. Premultiplied accumulation
 * keeps transparent edges clean when downsizing the wolf and its fine whiskers.
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    const y0 = crop.top + (py * crop.side) / size;
    const y1 = crop.top + ((py + 1) * crop.side) / size;
    for (let px = 0; px < size; px++) {
      const x0 = crop.left + (px * crop.side) / size;
      const x1 = crop.left + ((px + 1) * crop.side) / size;
      let alphaWeight = 0;
      let totalWeight = 0;
      const premultiplied = [0, 0, 0];
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        if (sy < 0 || sy >= source.height) continue;
        const yWeight = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          if (sx < 0 || sx >= source.width) continue;
          const xWeight = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const weight = Math.max(0, xWeight) * Math.max(0, yWeight);
          if (weight === 0) continue;
          const sourceIndex = sy * source.width + sx;
          if (visibleSource[sourceIndex] === 0) continue;
          const at = sourceIndex * 4;
          const alpha = source.pixels[at + 3] / 255;
          for (let channel = 0; channel < 3; channel++) {
            premultiplied[channel] += source.pixels[at + channel] * alpha * weight;
          }
          alphaWeight += alpha * weight;
          totalWeight += weight;
        }
      }
      const output = (py * size + px) * 4;
      if (alphaWeight > 0) {
        for (let channel = 0; channel < 3; channel++) {
          pixels[output + channel] = Math.round(premultiplied[channel] / alphaWeight);
        }
      }
      pixels[output + 3] = Math.round((alphaWeight / Math.max(totalWeight, Number.EPSILON)) * 255);
    }
  }
  return pixels;
}

// -------------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// -------------------------------------------------------------------- ico

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// -------------------------------------------------------- installer images

/** A 24-bit bottom-up BMP: the format NSIS draws in its header and on its welcome/finish pages. */
function encodeBmp(width, height, rgb) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + stride * height, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(stride * height, 34);
  const body = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      body[row + x * 3] = rgb[at + 2];
      body[row + x * 3 + 1] = rgb[at + 1];
      body[row + x * 3 + 2] = rgb[at];
    }
  }
  return Buffer.concat([header, body]);
}

/** The app icon at `size`, laid over a flat background at (left, top). */
function iconOn(width, height, background, size, left, top) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(background, i * 3);
  const icon = render(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = left + x, ty = top + y;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      const from = (y * size + x) * 4, to = (ty * width + tx) * 3, alpha = icon[from + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        rgb[to + channel] = Math.round(icon[from + channel] * alpha + background[channel] * (1 - alpha));
      }
    }
  }
  return rgb;
}

// ------------------------------------------------------------------- main

const cache = new Map();
const pngFor = (size) => {
  if (!cache.has(size)) cache.set(size, encodePng(size, render(size)));
  return cache.get(size);
};

mkdirSync(path.join(root, 'build'), { recursive: true });
const icoImages = ICO_SIZES.map((size) => ({ size, png: pngFor(size) }));
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(icoImages));
writeFileSync(path.join(root, 'build', 'icon.png'), pngFor(1024));
writeFileSync(path.join(root, 'build', 'icon-preview.png'), pngFor(256));
writeFileSync(path.join(root, 'build', 'runtime-icon.png'), pngFor(256));
// The installer an update shows (2.1.38): header on the window's white, sidebar in the app's ink.
writeFileSync(path.join(root, 'build', 'installerHeader.bmp'), encodeBmp(150, 57, iconOn(150, 57, [255, 255, 255], 45, 150 - 45 - 6, 6)));
writeFileSync(path.join(root, 'build', 'installerSidebar.bmp'), encodeBmp(164, 314, iconOn(164, 314, [21, 28, 42], 96, 34, 56)));
console.log(
  `Wrote build/icon.ico (${ICO_SIZES.join(', ')}), build/icon.png, build/icon-preview.png, build/runtime-icon.png, build/installerHeader.bmp and build/installerSidebar.bmp`
);

const linuxDir = path.join(root, 'build', 'icons');
mkdirSync(linuxDir, { recursive: true });
for (const size of LINUX_SIZES) writeFileSync(path.join(linuxDir, `${size}x${size}.png`), pngFor(size));
console.log(`Wrote build/icons/{${LINUX_SIZES.map((size) => `${size}x${size}`).join(',')}}.png`);

const iconsDir = path.join(root, 'extension', 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const size of EXTENSION_SIZES) {
  writeFileSync(path.join(iconsDir, `icon${size}.png`), pngFor(size));
}
console.log(`Wrote extension/icons/icon{${EXTENSION_SIZES.join(',')}}.png`);

writeFileSync(path.join(root, 'src', 'renderer', 'browser-icons', 'cos.png'), pngFor(128));
console.log('Wrote src/renderer/browser-icons/cos.png');
