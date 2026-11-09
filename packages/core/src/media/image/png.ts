import { crc32 } from 'node:zlib';
import { expectThat, type Cleaned } from './types.ts';

// PNG: chunks are copied through only when they decide what the picture looks like (header,
// palette, transparency, pixel data, APNG animation, and the colour chunks sRGB, gAMA, cHRM).
// Text (tEXt, zTXt, iTXt), Exif, time, resolution, ICC profiles, C2PA and every unknown chunk
// are dropped, and so is anything after IEND. The compressed pixel data is never decoded.
// A kept chunk must have exactly the length its fields define and a good checksum (`expectChunk`),
// so a marker cannot ride in the tail of a "known" chunk, in an IEND payload or in its checksum;
// only IDAT and fdAT stay opaque (the compressed stream cannot be judged without inflating it).

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEPT = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'acTL', 'fcTL', 'fdAT', 'sRGB', 'gAMA', 'cHRM']);
/** The payload size of the chunks that have exactly one. */
const FIXED_LENGTH: Record<string, number> = { IHDR: 13, acTL: 8, fcTL: 26, sRGB: 1, gAMA: 4, cHRM: 32, IEND: 0 };
/** The bit depths each colour type allows. */
const BIT_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

type Header = { width: number; height: number; colorType: number };

/** Throws unless a chunk's payload is as long as its fields say, and its fields are legal. */
function expectChunk(type: string, payload: Buffer, header: Header | null): void {
  const fixed = FIXED_LENGTH[type];
  if (fixed !== undefined) expectThat(payload.length === fixed, `PNG: ${type} must be ${fixed} bytes`);
  if (type === 'PLTE') {
    expectThat(payload.length >= 3 && payload.length <= 768 && payload.length % 3 === 0, 'PNG: bad palette');
  } else if (type === 'tRNS') {
    // One grey value, one RGB triple (16 bits each), or an alpha byte per palette entry.
    const allowed =
      header?.colorType === 3 ? payload.length >= 1 && payload.length <= 256 : payload.length === (header?.colorType === 0 ? 2 : 6);
    expectThat(header !== null && [0, 2, 3].includes(header.colorType) && allowed, 'PNG: bad transparency chunk');
  } else if (type === 'fdAT') {
    expectThat(payload.length >= 4, 'PNG: bad frame data chunk');
  } else if (type === 'sRGB') {
    expectThat((payload[0] ?? 9) <= 3, 'PNG: bad sRGB chunk');
  } else if (type === 'fcTL') {
    // The frame lies inside the canvas.
    const [width, height, left, top] = [
      payload.readUInt32BE(4),
      payload.readUInt32BE(8),
      payload.readUInt32BE(12),
      payload.readUInt32BE(16),
    ];
    const inside = header !== null && width > 0 && height > 0 && left + width <= header.width && top + height <= header.height;
    expectThat(inside && (payload[24] ?? 9) <= 2 && (payload[25] ?? 9) <= 1, 'PNG: an animation frame outside the image or with bad flags');
  }
}

/** The IHDR fields, or an error when the header is not one a decoder would take. */
function readHeader(payload: Buffer): Header {
  const header = { width: payload.readUInt32BE(0), height: payload.readUInt32BE(4), colorType: payload[9] ?? 9 };
  const [depth, compression, filter, interlace] = [payload[8] ?? 0, payload[10], payload[11], payload[12] ?? 9];
  expectThat(header.width > 0 && header.height > 0, 'PNG: empty image');
  expectThat(BIT_DEPTHS[header.colorType]?.includes(depth) === true, 'PNG: bad colour type or bit depth');
  expectThat(compression === 0 && filter === 0 && interlace <= 1, 'PNG: bad header chunk');
  return header;
}

export function cleanPng(input: Buffer): Cleaned {
  expectThat(input.length > 8 && input.subarray(0, 8).equals(SIGNATURE), 'not a PNG');
  const kept: Buffer[] = [SIGNATURE];
  let header: Header | null = null;
  let pixelChunks = 0;
  let pos = 8;
  for (let index = 0; ; index++) {
    expectThat(pos + 12 <= input.length, 'PNG: chunk cut short');
    const length = input.readUInt32BE(pos);
    const type = input.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    expectThat(length <= 0x7fffffff && end <= input.length, 'PNG: chunk length out of range');
    expectThat((index === 0) === (type === 'IHDR'), 'PNG: the header chunk must come first, once');
    if (type === 'IEND' || KEPT.has(type)) {
      expectThat(input.readUInt32BE(end - 4) === crc32(input.subarray(pos + 4, end - 4)), `PNG: bad checksum in ${type}`);
      const payload = input.subarray(pos + 8, end - 4);
      expectChunk(type, payload, header);
      if (type === 'IHDR') header = readHeader(payload);
      if (type === 'IDAT') pixelChunks++;
      kept.push(input.subarray(pos, end));
      if (type === 'IEND') {
        expectThat(header !== null && pixelChunks > 0, 'PNG: no header or no pixel data');
        return { bytes: Buffer.concat(kept), width: header.width, height: header.height };
      }
    }
    pos = end;
  }
}
