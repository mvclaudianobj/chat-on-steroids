import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

const read = (path: string): Buffer => readFileSync(new URL(`../${path}`, import.meta.url));
const pngSize = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

it('uses the supplied transparent Marks artwork as the only icon generation source', () => {
  const source = read('icon_marks.png');
  expect(source.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(source[25]).toBe(6); // PNG RGBA: transparent details must be retained.
  expect(pngSize(source)).toEqual([732, 729]);
  const generator = read('scripts/make-icon.mjs').toString('utf8');
  expect(generator).toContain("'icon_marks.png'");
  expect(generator).not.toContain("'app-icon-source.png'");
});

it('uses the same Marks logo for the browser card and the packaged Chrome extension', () => {
  const card = read('src/renderer/browser-icons/cos.png');
  const extension = read('extension/icons/icon128.png');
  expect(hash(card)).toBe(hash(extension));
  for (const size of [16, 32, 48, 128]) {
    const png = read(`extension/icons/icon${size}.png`);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(pngSize(png)).toEqual([size, size]);
  }
});
