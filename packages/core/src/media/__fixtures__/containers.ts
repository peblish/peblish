import { crc32 } from 'node:zlib';

// Builders for the container formats the cleaning tests assemble by hand (PNG chunks, RIFF/WebP
// chunks, GIF sub-blocks).

/** A PNG chunk with its length and checksum. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A RIFF chunk: type, length, payload, a pad byte when the length is odd. */
export function webpChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

/** A WebP file around chunks. */
export function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** GIF data as one sub-block (at most 255 bytes) and the zero terminator. */
export const subBlocks = (data: Buffer) => Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0])]);
