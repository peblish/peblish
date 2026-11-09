import { describe, expect, test } from 'vitest';
import { pngChunk, riff, subBlocks, webpChunk } from './__fixtures__/containers.ts';
import { has, secret, SECRET, segment } from './__fixtures__/dirty.ts';
import { bytes } from './__fixtures__/images.ts';
import { cleanImage } from './clean.ts';

// Metadata hides in the corners of structures a cleaner keeps: the tail of a "known" segment,
// an IEND payload, a second loop sub-block, a VP8X suffix; and an image can lie about its
// frames. Each case below is a file that an earlier cleaner accepted unchanged.

const refused = (input: Uint8Array) => expect(() => cleanImage(input)).toThrow(expect.objectContaining({ code: 'invalid' }));
const tail = Buffer.from(SECRET);

describe('JPEG', () => {
  const original = bytes('jpeg');

  /** The fixture with `suffix` added to the payload of its first `marker` segment. */
  function withSuffix(marker: number, suffix: Buffer): Buffer {
    let at = 2;
    while (original[at + 1] !== marker) at += 2 + original.readUInt16BE(at + 2);
    const length = original.readUInt16BE(at + 2);
    const head = Buffer.from(original.subarray(at, at + 4));
    head.writeUInt16BE(length + suffix.length, 2);
    return Buffer.concat([
      original.subarray(0, at),
      head,
      original.subarray(at + 4, at + 2 + length),
      suffix,
      original.subarray(at + 2 + length),
    ]);
  }

  const adobe = Buffer.from('Adobe\0\x64\0\0\0\0\x01');

  test('an Adobe APP14 segment keeps its 12 defined bytes and loses what is appended to them', () => {
    const dirty = Buffer.concat([original.subarray(0, 2), segment(0xee, Buffer.concat([adobe, tail])), original.subarray(2)]);
    expect(has(dirty, secret)).toBe(true);
    const cleaned = Buffer.from(cleanImage(dirty).bytes);
    expect(has(cleaned, secret)).toBe(false);
    const at = cleaned.indexOf(Buffer.from([0xff, 0xee]));
    // Marker, length 14, the 12 bytes: the colour transform (1, YCbCr) is still there.
    expect([cleaned.readUInt16BE(at + 2), cleaned[at + 15]]).toEqual([14, 1]);
    // A plain one passes through as it is, and a short one is no Adobe segment.
    const plain = Buffer.concat([original.subarray(0, 2), segment(0xee, adobe), original.subarray(2)]);
    expect(Buffer.from(cleanImage(plain).bytes).includes(segment(0xee, adobe))).toBe(true);
    refused(Buffer.concat([original.subarray(0, 2), segment(0xee, adobe.subarray(0, 8)), original.subarray(2)]));
  });

  test.each([
    ['DQT', 0xdb],
    ['DHT', 0xc4],
    ['DRI', 0xdd],
    ['SOF', 0xc0],
    ['SOS', 0xda],
  ])('%s with bytes after its fields is refused', (_name, marker) => {
    expect(has(withSuffix(marker, tail), secret)).toBe(true);
    refused(withSuffix(marker, tail));
    refused(withSuffix(marker, Buffer.from([0])));
  });

  test('a DAC segment of whole pairs passes and an odd one is refused', () => {
    const plant = (payload: Buffer) => Buffer.concat([original.subarray(0, 2), segment(0xcc, payload), original.subarray(2)]);
    expect(cleanImage(plant(Buffer.from([0x00, 0x10, 0x11, 0x05]))).width).toBe(24);
    refused(plant(Buffer.from([0x00, 0x10, 0x11])));
  });
});

describe('PNG', () => {
  const original = bytes('png');
  const idat = original.indexOf('IDAT') - 4;
  const iend = original.length - 12;
  const ihdr = original.subarray(16, 29);

  test('an IEND with a payload or with a wrong checksum is refused', () => {
    const planted = Buffer.concat([original.subarray(0, iend), pngChunk('IEND', tail)]);
    expect(has(planted, secret)).toBe(true);
    refused(planted);
    const broken = Buffer.from(original);
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0xff;
    expect(() => cleanImage(broken)).toThrow(/checksum/);
  });

  test.each([
    ['gAMA', 4],
    ['sRGB', 1],
    ['cHRM', 32],
    ['acTL', 8],
  ])('%s with bytes after its fields is refused', (type, length) => {
    const chunk = (extra: Buffer) =>
      Buffer.concat([original.subarray(0, idat), pngChunk(type, Buffer.concat([Buffer.alloc(length), extra])), original.subarray(idat)]);
    expect(cleanImage(chunk(Buffer.alloc(0))).width).toBe(24);
    refused(chunk(tail));
    refused(chunk(Buffer.from([0])));
  });

  test('a header or palette that is not one a decoder would take is refused', () => {
    const withHeader = (edit: (header: Buffer) => void) => {
      const header = Buffer.from(ihdr);
      edit(header);
      return Buffer.concat([original.subarray(0, 8), pngChunk('IHDR', header), original.subarray(idat)]);
    };
    refused(withHeader((header) => (header[10] = 1))); // compression method
    refused(withHeader((header) => (header[11] = 1))); // filter method
    refused(withHeader((header) => (header[12] = 2))); // interlace method
    refused(withHeader((header) => (header[8] = 5))); // bit depth
    refused(withHeader((header) => (header[9] = 5))); // colour type
    refused(Buffer.concat([original.subarray(0, idat), pngChunk('PLTE', Buffer.alloc(4)), original.subarray(idat)]));
    refused(Buffer.concat([original.subarray(0, idat), pngChunk('tRNS', Buffer.alloc(3)), original.subarray(idat)]));
  });

  describe('animation', () => {
    const data = original.subarray(idat + 8, idat + 8 + original.readUInt32BE(idat));
    const control = (sequence: number, [width, height, left, top]: number[]) => {
      const payload = Buffer.alloc(26);
      payload.writeUInt32BE(sequence, 0);
      [width, height, left, top].forEach((value, i) => payload.writeUInt32BE(value ?? 0, 4 + 4 * i));
      payload.writeUInt16LE(1, 20);
      payload.writeUInt16LE(10, 22);
      return pngChunk('fcTL', payload);
    };
    const apng = (second: number[]) => {
      const frames = Buffer.alloc(8);
      frames.writeUInt32BE(2, 0);
      const next = Buffer.concat([Buffer.from([0, 0, 0, 2]), data]);
      return Buffer.concat([
        original.subarray(0, idat),
        pngChunk('acTL', frames),
        control(0, [24, 16, 0, 0]),
        original.subarray(idat, iend),
        control(1, second),
        pngChunk('fdAT', next),
        original.subarray(iend),
      ]);
    };

    test('frames inside the canvas pass unchanged', () => {
      const file = apng([24, 16, 0, 0]);
      expect(Buffer.from(cleanImage(file).bytes).equals(file)).toBe(true);
    });

    test('a frame outside the canvas or empty is refused', () => {
      refused(apng([24, 16, 1, 0]));
      refused(apng([65535, 65535, 0, 0]));
      refused(apng([0, 16, 0, 0]));
    });
  });
});

describe('GIF', () => {
  const original = bytes('gif');
  const at = 13 + 3 * 2 ** ((original[10]! & 7) + 1);
  const trailer = Buffer.from([0x3b]);
  /** The first frame's blocks (graphic control and image) up to the trailer. */
  const frame = original.subarray(at, original.length - 1);
  /** Where the first image descriptor starts. */
  const descriptor = (gif: Buffer, from = at) => {
    let pos = from;
    while (gif[pos] === 0x21) {
      pos += 2;
      while (gif[pos]) pos += 1 + gif[pos]!;
      pos++;
    }
    return pos;
  };
  const patched = (gif: Buffer, pos: number, ...values: [offset: number, value: number][]) => {
    const copy = Buffer.from(gif);
    for (const [offset, value] of values) copy.writeUInt16LE(value, pos + offset);
    return copy;
  };
  const loop = (name: string, extra: Buffer) =>
    Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from(name), Buffer.from([3, 1, 0, 0]), extra]);
  const withBlock = (block: Buffer) => Buffer.concat([original.subarray(0, at), block, frame, trailer]);

  test.each(['NETSCAPE2.0', 'ANIMEXTS1.0'])(
    'a %s loop count with a second sub-block is refused, one with just the count passes',
    (name) => {
      const dirty = withBlock(loop(name, subBlocks(tail)));
      expect(has(dirty, secret)).toBe(true);
      refused(dirty);
      const clean = withBlock(loop(name, Buffer.from([0])));
      expect(Buffer.from(cleanImage(clean).bytes).includes(loop(name, Buffer.from([0])))).toBe(true);
      // A count that is not one 3-byte sub-block is no loop count.
      refused(withBlock(Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from(name), subBlocks(Buffer.from([1, 0, 0, 0]))])));
    },
  );

  test('a graphic control block with a second sub-block, or the wrong size, is refused', () => {
    const control = (...sub: Buffer[]) => Buffer.concat([Buffer.from([0x21, 0xf9]), ...sub, Buffer.from([0])]);
    const image = frame.subarray(descriptor(frame, 0));
    const withControl = (block: Buffer) => Buffer.concat([original.subarray(0, at), block, image, trailer]);
    expect(cleanImage(withControl(control(Buffer.from([4, 0, 10, 0, 0])))).width).toBe(24);
    refused(withControl(control(Buffer.from([4, 0, 10, 0, 0]), Buffer.from([tail.length, ...tail]))));
    refused(withControl(control(Buffer.from([5, 0, 10, 0, 0, 0]))));
  });

  test('every frame is checked against the screen: oversized, outside it or empty frames are refused', () => {
    const image = at + descriptor(frame, 0);
    // The reported case: the screen says 24x16, the frame says 65,535 by 65,535.
    refused(patched(original, image, [5, 65535], [7, 65535]));
    refused(patched(original, image, [5, 24], [7, 17]));
    refused(patched(original, image, [1, 1]));
    refused(patched(original, image, [3, 1]));
    refused(patched(original, image, [5, 0]));
    refused(patched(original, image, [7, 0]));
    // The same in a later frame.
    const twice = Buffer.concat([original.subarray(0, original.length - 1), frame, trailer]);
    expect(cleanImage(twice).bytes).toEqual(twice);
    refused(patched(twice, at + frame.length + descriptor(frame, 0), [5, 65535], [7, 65535]));
  });

  test('a code size the format does not allow is refused', () => {
    const image = at + descriptor(frame, 0);
    for (const size of [0, 9, 255]) {
      const copy = Buffer.from(original);
      copy[image + 10] = size;
      refused(copy);
    }
  });
});

describe('WebP', () => {
  const lossy = bytes('webpLossy').subarray(12);
  const lossless = bytes('webpLossless').subarray(12);
  const u24 = (value: number) => Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
  const vp8x = (flags: number, width = 24, height = 16, extra = Buffer.alloc(0)) =>
    webpChunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24(width - 1), u24(height - 1), extra]));
  const anim = webpChunk('ANIM', Buffer.alloc(6));
  const anmf = ({ x = 0, y = 0, width = 24, height = 16, flags = 0 } = {}, ...chunks: Buffer[]) =>
    webpChunk('ANMF', Buffer.concat([u24(x / 2), u24(y / 2), u24(width - 1), u24(height - 1), u24(100), Buffer.from([flags]), ...chunks]));
  const junk = webpChunk('EXIF', Buffer.from(`Exif\0\0${SECRET}`));

  test('a VP8X chunk with bytes after its ten is refused, and its reserved bytes are written as zero', () => {
    const dirty = riff([vp8x(0x10, 24, 16, tail), lossy]);
    expect(has(dirty, secret)).toBe(true);
    refused(dirty);
    refused(riff([vp8x(0x10, 24, 16, Buffer.from([0])), lossy]));
    const reserved = riff([webpChunk('VP8X', Buffer.from([0x11, 0x61, 0x62, 0x63, ...u24(23), ...u24(15)])), lossy]);
    const cleaned = Buffer.from(cleanImage(reserved).bytes);
    expect([...cleaned.subarray(20, 24)]).toEqual([0x10, 0, 0, 0]);
  });

  test('an animation is rebuilt from its frames: unknown chunks inside a frame go, its reserved flag bits are cleared', () => {
    const file = riff([vp8x(0x02 | 0x20 | 0x08 | 0x04), anim, anmf({ flags: 0xff }, lossy, junk), anmf({}, lossless)]);
    expect(has(file, secret)).toBe(true);
    const cleaned = cleanImage(file);
    const out = Buffer.from(cleaned.bytes);
    expect([cleaned.mimeType, cleaned.width, cleaned.height]).toEqual(['image/webp', 24, 16]);
    expect(has(out, secret)).toBe(false);
    expect(out[20]).toBe(0x02);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    // The first frame's flag byte: dispose and blend only.
    const first = out.indexOf('ANMF');
    expect(out[first + 8 + 15]).toBe(0x03);
    expect(cleanImage(out).bytes).toEqual(out);
  });

  test('a frame without image data is refused: empty, unknown chunks only, or two images', () => {
    refused(riff([vp8x(0x02), anim, anmf()]));
    refused(riff([vp8x(0x02), anim, anmf({}, junk)]));
    refused(riff([vp8x(0x02), anim, anmf({}, lossy, lossless)]));
    refused(riff([vp8x(0x02), anim, anmf({}, lossy), anmf()]));
    refused(riff([vp8x(0x02), anim, webpChunk('ANMF', Buffer.alloc(8))]));
  });

  test('a frame has to fit the canvas and match its image data', () => {
    expect(cleanImage(riff([vp8x(0x02, 26, 18), anim, anmf({ x: 2, y: 2 }, lossy)])).width).toBe(26);
    refused(riff([vp8x(0x02), anim, anmf({ x: 2 }, lossy)]));
    refused(riff([vp8x(0x02), anim, anmf({ y: 2 }, lossy)]));
    refused(riff([vp8x(0x02), anim, anmf({ width: 25 }, lossy)]));
    refused(riff([vp8x(0x02), anim, anmf({ width: 10 }, lossy)]));
    refused(riff([vp8x(0x02), anim, anmf({ width: 1 << 24, height: 1 << 24 }, lossy)]));
    // A frame inside a canvas past the limits is judged by the canvas.
    expect(() => cleanImage(riff([vp8x(0x02, 100_000, 100_000), anim, anmf({}, lossy)]))).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  test('the animation flag, the ANIM chunk and the frames have to agree', () => {
    refused(riff([vp8x(0x02), lossy]));
    refused(riff([vp8x(0x02), anim]));
    refused(riff([vp8x(0x02), anmf({}, lossy)]));
    refused(riff([vp8x(0x02), anim, lossy, anmf({}, lossy)]));
    refused(riff([vp8x(0x00), anim, anmf({}, lossy)]));
    refused(riff([vp8x(0x02), webpChunk('ANIM', Buffer.alloc(7)), anmf({}, lossy)]));
  });

  test('a still image has one bitstream of the canvas size; a plain file is nothing but that', () => {
    refused(riff([vp8x(0x00, 25, 16), lossy]));
    refused(riff([vp8x(0x00), lossy, lossless]));
    refused(riff([vp8x(0x00)]));
    refused(riff([lossy, lossless]));
    refused(riff([webpChunk('ALPH', Buffer.alloc(385)), lossy]));
    refused(riff([webpChunk('JUNK', tail)]));
    expect(has(cleanImage(riff([webpChunk('JUNK', tail), lossy, junk])).bytes, secret)).toBe(false);
  });

  test('alpha belongs to a lossy image, and raw alpha is a byte a pixel', () => {
    const alpha = (size: number, header = 0) => webpChunk('ALPH', Buffer.concat([Buffer.from([header]), Buffer.alloc(size)]));
    expect(cleanImage(riff([vp8x(0x10), alpha(24 * 16), lossy])).height).toBe(16);
    expect(cleanImage(riff([vp8x(0x10), alpha(10, 1), lossy])).height).toBe(16);
    refused(riff([vp8x(0x10), alpha(24 * 16 + 8), lossy]));
    refused(riff([vp8x(0x10), alpha(24 * 16 - 1), lossy]));
    refused(riff([vp8x(0x10), alpha(24 * 16, 2), lossy]));
    refused(riff([vp8x(0x10), alpha(24 * 16, 0x20), lossy]));
    refused(riff([vp8x(0x10), alpha(24 * 16), lossless]));
    // Reserved header bits are written as zero.
    const out = Buffer.from(cleanImage(riff([vp8x(0x10), alpha(24 * 16, 0xc0), lossy])).bytes);
    expect(out[out.indexOf('ALPH') + 8]).toBe(0);
  });

  test('a bitstream header that is not one is refused', () => {
    const damaged = (chunk: Buffer, at: number, value: number) => {
      const copy = Buffer.from(chunk);
      copy[8 + at] = value;
      return copy;
    };
    refused(riff([damaged(lossy, 3, 0x00)])); // start code
    refused(riff([damaged(lossy, 0, 0x01)])); // not a key frame
    refused(riff([damaged(lossless, 0, 0x00)])); // signature
    refused(riff([damaged(lossless, 4, 0xe0)])); // version bits
  });
});
