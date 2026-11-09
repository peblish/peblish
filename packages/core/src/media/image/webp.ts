import { expectThat, type Cleaned } from './types.ts';

// WebP (RIFF): the file is parsed against the container's grammar and written again from the
// parts that draw it, so what survives is exactly: a plain file (one VP8 or VP8L chunk), or an
// extended one (VP8X, then either [ALPH] and one VP8 or VP8L, or ANIM and ANMF frames, each
// with [ALPH] and one VP8 or VP8L). Chunks are rebuilt from their fields: the VP8X flags for
// ICC, Exif and XMP are cleared, its reserved bytes and each frame's reserved bits are zeroed,
// padding is rewritten, and ICCP, EXIF, XMP and unknown chunks (inside a frame too) are dropped.
// Canvas, frame and bitstream sizes have to agree and every frame has to carry its raster
// chunk, so an empty or oversized frame is refused. The bitstreams themselves (VP8, VP8L and the
// ALPH data) stay opaque: they cannot be judged without decoding the pixels.

type Chunk = { type: string; payload: Buffer };
type Size = { width: number; height: number };

const KEPT = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const ALPHA_FLAG = 0x10;
const ANIMATION_FLAG = 0x02;
const VP8X_PAYLOAD = 10;
const ANIM_PAYLOAD = 6;
const ANMF_HEADER = 16;

const u24 = (buffer: Buffer, at: number) => buffer.readUIntLE(at, 3);
const isBitstream = (chunk: Chunk | undefined): chunk is Chunk => chunk?.type === 'VP8 ' || chunk?.type === 'VP8L';

/** The chunks laid end to end in `buffer[start, end)`, each with its pad byte inside the range. */
function readChunks(buffer: Buffer, start: number, end: number): Chunk[] {
  const chunks: Chunk[] = [];
  let pos = start;
  while (pos < end) {
    expectThat(pos + 8 <= end, 'WebP: chunk cut short');
    const length = buffer.readUInt32LE(pos + 4);
    const next = pos + 8 + length + (length & 1);
    expectThat(next <= end, 'WebP: chunk length out of range');
    chunks.push({ type: buffer.toString('latin1', pos, pos + 4), payload: buffer.subarray(pos + 8, pos + 8 + length) });
    pos = next;
  }
  return chunks;
}

/** A chunk written from its payload, padded with a zero byte to an even length. */
function writeChunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, Buffer.alloc(payload.length & 1)]);
}

/** The size a VP8 or VP8L chunk declares, after checking its header. */
function bitstreamSize({ type, payload }: Chunk): Size {
  if (type === 'VP8L') {
    // 0x2f, 14 bits of width - 1, 14 of height - 1, an alpha hint, a 3-bit version that must be 0.
    expectThat(payload.length >= 5 && payload[0] === 0x2f, 'WebP: bad VP8L header');
    const bits = payload.readUInt32LE(1);
    expectThat(bits >>> 29 === 0, 'WebP: unknown VP8L version');
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // A key frame (bit 0 clear): 3-byte tag with the first partition's size in its top 19 bits, the start code, 14-bit sizes.
  const firstPartition = payload.length >= 3 ? payload.readUIntLE(0, 3) >>> 5 : 0;
  expectThat(
    payload.length >= 10 && (payload[0] ?? 1) % 2 === 0 && payload[3] === 0x9d && payload[4] === 0x01 && payload[5] === 0x2a,
    'WebP: bad VP8 header',
  );
  expectThat(10 + firstPartition <= payload.length, 'WebP: the VP8 first partition is longer than the chunk');
  const size = { width: payload.readUInt16LE(6) & 0x3fff, height: payload.readUInt16LE(8) & 0x3fff };
  expectThat(size.width > 0 && size.height > 0, 'WebP: empty VP8 frame');
  return size;
}

/**
 * [ALPH] and one VP8 or VP8L, the raster of one still image or one animation frame, as the
 * rebuilt chunks and the size the bitstream declares. A frame without a bitstream is refused.
 */
function readRaster(chunks: Chunk[]): { size: Size; rebuilt: Buffer[] } {
  const [alpha, image, ...extra] = chunks[0]?.type === 'ALPH' ? chunks : [undefined, ...chunks];
  expectThat(isBitstream(image) && extra.length === 0, 'WebP: a frame needs one image chunk');
  const size = bitstreamSize(image);
  if (!alpha) return { size, rebuilt: [writeChunk(image.type, image.payload)] };
  // Alpha belongs to lossy frames; its header says how it is stored and raw alpha is exactly one byte a pixel.
  const [compression, preprocessing] = [(alpha.payload[0] ?? 0) & 3, ((alpha.payload[0] ?? 0) >> 4) & 3];
  expectThat(image.type === 'VP8 ' && alpha.payload.length > 0 && compression <= 1 && preprocessing <= 1, 'WebP: bad alpha chunk');
  expectThat(compression === 1 || alpha.payload.length === 1 + size.width * size.height, 'WebP: raw alpha of the wrong size');
  const header = Buffer.from([(alpha.payload[0] ?? 0) & 0x3f]);
  return { size, rebuilt: [writeChunk('ALPH', Buffer.concat([header, alpha.payload.subarray(1)])), writeChunk(image.type, image.payload)] };
}

/** One ANMF frame rebuilt from its fields, after checking it against the canvas. */
function rebuildFrame(frame: Chunk, canvas: Size): Buffer {
  const { payload } = frame;
  expectThat(payload.length > ANMF_HEADER, 'WebP: an animation frame without image data');
  const [left, top, width, height] = [2 * u24(payload, 0), 2 * u24(payload, 3), u24(payload, 6) + 1, u24(payload, 9) + 1];
  const { size, rebuilt } = readRaster(readChunks(payload, ANMF_HEADER, payload.length).filter((chunk) => KEPT.has(chunk.type)));
  expectThat(width === size.width && height === size.height, 'WebP: a frame whose size differs from its image data');
  expectThat(left + width <= canvas.width && top + height <= canvas.height, 'WebP: a frame outside the canvas');
  // Duration is a free field; of the flag byte only dispose and blend are defined.
  const header = Buffer.from(payload.subarray(0, ANMF_HEADER));
  header[15] = (header[15] ?? 0) & 0x03;
  return writeChunk('ANMF', Buffer.concat([header, ...rebuilt]));
}

export function cleanWebp(input: Buffer): Cleaned {
  expectThat(input.length >= 20 && input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP', 'not a WebP');
  const riffEnd = 8 + input.readUInt32LE(4);
  expectThat(riffEnd <= input.length && riffEnd >= 20, 'WebP: RIFF size out of range');
  const [head, ...rest] = readChunks(input, 12, riffEnd).filter((chunk) => KEPT.has(chunk.type));
  expectThat(head !== undefined, 'WebP: no image data');

  let size: Size;
  const body: Buffer[] = [];
  if (head.type !== 'VP8X') {
    // A plain file is its one image chunk and nothing else.
    expectThat(isBitstream(head) && rest.length === 0, 'WebP: a plain file is one VP8 or VP8L chunk');
    size = bitstreamSize(head);
    body.push(writeChunk(head.type, head.payload));
  } else {
    expectThat(head.payload.length === VP8X_PAYLOAD, 'WebP: bad VP8X chunk');
    const flags = head.payload[0] ?? 0;
    size = { width: u24(head.payload, 4) + 1, height: u24(head.payload, 7) + 1 };
    // The flags for ICC, Exif and XMP are cleared with their chunks; the reserved bytes are zero.
    const vp8x = Buffer.alloc(VP8X_PAYLOAD);
    vp8x[0] = flags & (ALPHA_FLAG | ANIMATION_FLAG);
    vp8x.writeUIntLE(size.width - 1, 4, 3);
    vp8x.writeUIntLE(size.height - 1, 7, 3);
    body.push(writeChunk('VP8X', vp8x));
    if (flags & ANIMATION_FLAG) {
      const [anim, ...frames] = rest;
      expectThat(anim?.type === 'ANIM' && anim.payload.length === ANIM_PAYLOAD, 'WebP: an animation needs an ANIM chunk');
      expectThat(frames.length > 0 && frames.every((chunk) => chunk.type === 'ANMF'), 'WebP: an animation is ANIM then ANMF frames');
      body.push(writeChunk('ANIM', anim.payload), ...frames.map((frame) => rebuildFrame(frame, size)));
    } else {
      const { size: image, rebuilt } = readRaster(rest);
      expectThat(image.width === size.width && image.height === size.height, 'WebP: the image differs in size from the canvas');
      body.push(...rebuilt);
    }
  }
  const content = Buffer.concat(body);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + content.length, 4);
  riff.write('WEBP', 8, 'latin1');
  return { bytes: Buffer.concat([riff, content]), ...size };
}
