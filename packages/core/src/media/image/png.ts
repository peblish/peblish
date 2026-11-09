import { crc32 } from 'node:zlib';
import { expectThat, type Cleaned } from './types.ts';

// PNG: chunks are copied through only when they decide what the picture looks like (header,
// palette, transparency, pixel data, APNG animation, and the colour chunks sRGB, gAMA, cHRM).
// Text (tEXt, zTXt, iTXt), Exif, time, resolution, ICC profiles, C2PA and every unknown chunk
// are dropped, and so is anything after IEND. The compressed pixel data is never decoded.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEPT = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'acTL', 'fcTL', 'fdAT', 'sRGB', 'gAMA', 'cHRM']);

export function cleanPng(input: Buffer): Cleaned {
  expectThat(input.length > 8 && input.subarray(0, 8).equals(SIGNATURE), 'not a PNG');
  const kept: Buffer[] = [SIGNATURE];
  let size: { width: number; height: number } | null = null;
  let pixelChunks = 0;
  let pos = 8;
  for (let index = 0; ; index++) {
    expectThat(pos + 12 <= input.length, 'PNG: chunk cut short');
    const length = input.readUInt32BE(pos);
    const type = input.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    expectThat(length <= 0x7fffffff && end <= input.length, 'PNG: chunk length out of range');
    expectThat((index === 0) === (type === 'IHDR'), 'PNG: the header chunk must come first, once');
    if (type === 'IEND') {
      expectThat(size !== null && pixelChunks > 0, 'PNG: no header or no pixel data');
      kept.push(input.subarray(pos, end));
      return { bytes: Buffer.concat(kept), ...size };
    }
    if (KEPT.has(type)) {
      expectThat(input.readUInt32BE(end - 4) === crc32(input.subarray(pos + 4, end - 4)), `PNG: bad checksum in ${type}`);
      if (type === 'IHDR') {
        expectThat(length === 13, 'PNG: bad header chunk');
        size = { width: input.readUInt32BE(pos + 8), height: input.readUInt32BE(pos + 12) };
        expectThat(size.width > 0 && size.height > 0, 'PNG: empty image');
      }
      if (type === 'IDAT') pixelChunks++;
      kept.push(input.subarray(pos, end));
    }
    pos = end;
  }
}
