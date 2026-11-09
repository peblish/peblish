import { expectThat, type Cleaned } from './types.ts';

// WebP (RIFF): the image chunks are copied (VP8, VP8L, ALPH, ANIM, ANMF, and the VP8X header
// with its ICC, Exif and XMP flags cleared); ICCP, EXIF, XMP and unknown chunks are dropped,
// and the RIFF size is rewritten.

const KEPT = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const VP8X_METADATA_FLAGS = 0x20 | 0x08 | 0x04; // ICC profile, Exif, XMP

const u24 = (buffer: Buffer, at: number) => buffer.readUIntLE(at, 3);

/** The size a VP8, VP8L or VP8X chunk declares. */
function imageSize(type: string, payload: Buffer): { width: number; height: number } | null {
  if (type === 'VP8X' && payload.length >= 10) return { width: u24(payload, 4) + 1, height: u24(payload, 7) + 1 };
  if (type === 'VP8L' && payload.length >= 5 && payload[0] === 0x2f) {
    const bits = payload.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type === 'VP8 ' && payload.length >= 10 && payload[3] === 0x9d && payload[4] === 0x01 && payload[5] === 0x2a) {
    return { width: payload.readUInt16LE(6) & 0x3fff, height: payload.readUInt16LE(8) & 0x3fff };
  }
  return null;
}

export function cleanWebp(input: Buffer): Cleaned {
  expectThat(input.length >= 20 && input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP', 'not a WebP');
  const riffEnd = 8 + input.readUInt32LE(4);
  expectThat(riffEnd <= input.length && riffEnd >= 20, 'WebP: RIFF size out of range');
  const kept: Buffer[] = [];
  let canvas: { width: number; height: number } | null = null;
  let frame: { width: number; height: number } | null = null;
  let hasImage = false;
  let pos = 12;
  while (pos < riffEnd) {
    expectThat(pos + 8 <= riffEnd, 'WebP: chunk cut short');
    const type = input.toString('latin1', pos, pos + 4);
    const length = input.readUInt32LE(pos + 4);
    const end = pos + 8 + length + (length & 1);
    expectThat(end <= riffEnd, 'WebP: chunk length out of range');
    if (KEPT.has(type)) {
      // A copy: the VP8X flags are rewritten below.
      const chunk = Buffer.from(input.subarray(pos, end));
      const payload = chunk.subarray(8, 8 + length);
      if (type === 'VP8X') {
        expectThat(kept.length === 0 && length >= 10, 'WebP: bad VP8X chunk');
        payload[0] = (payload[0] ?? 0) & ~VP8X_METADATA_FLAGS;
        canvas = imageSize(type, payload);
      } else if (type === 'VP8 ' || type === 'VP8L') {
        frame ??= imageSize(type, payload);
      }
      if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') hasImage = true;
      kept.push(chunk);
    }
    pos = end;
  }
  const size = canvas ?? frame;
  expectThat(hasImage && size !== null && size.width > 0 && size.height > 0, 'WebP: no image data');
  const body = Buffer.concat(kept);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WEBP', 8, 'latin1');
  return { bytes: Buffer.concat([riff, body]), ...size };
}
