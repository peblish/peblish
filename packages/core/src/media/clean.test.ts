import { crc32 } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { dirtyJpeg, exifSegment, has, secret, SECRET } from './__fixtures__/dirty.ts';
import { bytes } from './__fixtures__/images.ts';
import { cleanImage, ImageError } from './clean.ts';

/** Markers of a JPEG in order, with entropy-coded data skipped. */
function markers(jpeg: Uint8Array): number[] {
  const buffer = Buffer.from(jpeg);
  const found: number[] = [];
  let at = 2;
  while (at < buffer.length) {
    const marker = buffer[at + 1] ?? 0;
    found.push(marker);
    if (marker === 0xd9) break;
    at += 2 + buffer.readUInt16BE(at + 2);
    if (marker === 0xda)
      while (!(buffer[at] === 0xff && buffer[at + 1] !== 0 && !(buffer[at + 1]! >= 0xd0 && buffer[at + 1]! <= 0xd7))) at++;
  }
  return found;
}

describe('JPEG', () => {
  test('GPS, camera, XMP, Photoshop, comments, JFIF and trailing bytes are gone; size and the picture stay', () => {
    const dirty = dirtyJpeg(1);
    expect(has(dirty, secret)).toBe(true);
    const cleaned = cleanImage(dirty);
    expect(has(cleaned.bytes, secret)).toBe(false);
    expect(has(cleaned.bytes, 'Exif')).toBe(false);
    expect(has(cleaned.bytes, 'JFIF')).toBe(false);
    expect([cleaned.mimeType, cleaned.width, cleaned.height]).toEqual(['image/jpeg', 24, 16]);
    // Frame, tables and scan are the original's, byte for byte.
    const original = bytes('jpeg');
    const scan = original.subarray(original.indexOf(Buffer.from([0xff, 0xdb])), original.length);
    expect(Buffer.from(cleaned.bytes).includes(scan)).toBe(true);
    expect(markers(cleaned.bytes)[0]).not.toBe(0xe1);
    // The converter's own JFIF and Exif go too.
    expect(has(cleanImage(original).bytes, 'Exif')).toBe(false);
  });

  test('the Exif orientation of a phone photo survives as the only Exif data', () => {
    const cleaned = cleanImage(dirtyJpeg(6));
    expect(has(cleaned.bytes, secret)).toBe(false);
    expect([...cleaned.bytes.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe1]);
    const exif = Buffer.from(cleaned.bytes).subarray(2, 2 + 2 + 34);
    expect(exif.toString('latin1', 4, 8)).toBe('Exif');
    expect(exif.readUInt16BE(2)).toBe(34);
    // One entry after the TIFF header: tag 0x0112, SHORT, count 1, value 6.
    expect([...exif.subarray(20, 32)]).toEqual([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 6, 0x00, 0x00]);
  });

  test('cleaning twice changes nothing', () => {
    const once = cleanImage(dirtyJpeg(3)).bytes;
    expect(cleanImage(once).bytes).toEqual(once);
  });

  test('a truncated or spliced file is refused', () => {
    const original = bytes('jpeg');
    expect(() => cleanImage(original.subarray(0, original.length - 2))).toThrow(ImageError);
    expect(() => cleanImage(original.subarray(0, 100))).toThrow(ImageError);
    expect(() => cleanImage(Buffer.concat([original.subarray(0, 2), Buffer.from([0xff, 0xda, 0x00, 0x02])]))).toThrow(ImageError);
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

describe('PNG', () => {
  const original = bytes('png');
  /** Splits the fixture before IDAT to plant chunks there. */
  const idat = original.indexOf('IDAT') - 4;

  test('text, Exif, time, ICC, unknown chunks and bytes after IEND are gone', () => {
    const dirty = Buffer.concat([
      original.subarray(0, idat),
      chunk('tEXt', Buffer.from(`Comment\0${SECRET}`)),
      chunk('zTXt', Buffer.from(`Comment\0\0${SECRET}`)),
      chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`)),
      chunk('eXIf', exifSegment(1).subarray(4)),
      chunk('iCCP', Buffer.from(`icc\0\0${SECRET}`)),
      chunk('tIME', Buffer.alloc(7)),
      chunk('caBX', Buffer.from(SECRET)),
      original.subarray(idat),
      Buffer.from(`trailing ${SECRET}`),
    ]);
    expect(has(dirty, secret)).toBe(true);
    const cleaned = cleanImage(dirty);
    expect([cleaned.mimeType, cleaned.width, cleaned.height]).toEqual(['image/png', 24, 16]);
    expect(has(cleaned.bytes, secret)).toBe(false);
    // The fixture has only the kept chunks, so cleaning it is the identity.
    expect(Buffer.from(cleaned.bytes).equals(original)).toBe(true);
  });

  test('a damaged chunk, a missing IEND and a missing header are refused', () => {
    const flipped = Buffer.from(original);
    flipped[idat + 12] = (flipped[idat + 12] ?? 0) ^ 0xff;
    expect(() => cleanImage(flipped)).toThrow(/checksum/);
    expect(() => cleanImage(original.subarray(0, original.length - 12))).toThrow(ImageError);
    expect(() => cleanImage(Buffer.concat([original.subarray(0, 8), original.subarray(idat)]))).toThrow(ImageError);
  });

  test('an image past the size limits is refused before anything is allocated for it', () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(9000, 0);
    header.writeUInt32BE(10, 4);
    header[8] = 8;
    header[9] = 2;
    const wide = Buffer.concat([original.subarray(0, 8), chunk('IHDR', header), original.subarray(idat)]);
    expect(() => cleanImage(wide)).toThrow(expect.objectContaining({ code: 'too_large' }));
    header.writeUInt32BE(7000, 0);
    header.writeUInt32BE(7000, 4);
    const many = Buffer.concat([original.subarray(0, 8), chunk('IHDR', header), original.subarray(idat)]);
    expect(() => cleanImage(many)).toThrow(expect.objectContaining({ code: 'too_large' }));
  });
});

describe('WebP', () => {
  const riff = (chunks: Buffer[]) => {
    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(4 + body.length, 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, body]);
  };
  const webpChunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
  };
  const vp8x = (flags: number) => {
    const data = Buffer.alloc(10);
    data[0] = flags;
    data.writeUIntLE(23, 4, 3);
    data.writeUIntLE(15, 7, 3);
    return webpChunk('VP8X', data);
  };
  const imageChunk = (name: 'webpLossy' | 'webpLossless') => bytes(name).subarray(12);

  test.each(['webpLossy', 'webpLossless'] as const)(
    'Exif, XMP and ICC chunks of an extended %s file are gone and the flags say so',
    (name) => {
      const dirty = riff([
        vp8x(0x20 | 0x10 | 0x08 | 0x04),
        webpChunk('ICCP', Buffer.from(SECRET)),
        imageChunk(name),
        webpChunk('EXIF', Buffer.from(`Exif\0\0${SECRET}`)),
        webpChunk('XMP ', Buffer.from(SECRET)),
        webpChunk('JUNK', Buffer.from(SECRET)),
      ]);
      expect(has(dirty, secret)).toBe(true);
      const cleaned = cleanImage(dirty);
      const out = Buffer.from(cleaned.bytes);
      expect([cleaned.mimeType, cleaned.width, cleaned.height]).toEqual(['image/webp', 24, 16]);
      expect(has(out, secret)).toBe(false);
      for (const dropped of ['ICCP', 'EXIF', 'XMP ', 'JUNK']) expect(has(out, dropped)).toBe(false);
      expect(out.readUInt32LE(4)).toBe(out.length - 8);
      // Only the alpha flag is left of the four set.
      expect(out[20]).toBe(0x10);
    },
  );

  test('a plain file is rewritten unchanged, and trailing bytes after the RIFF are cut', () => {
    for (const name of ['webpLossy', 'webpLossless'] as const) {
      const cleaned = cleanImage(Buffer.concat([bytes(name), Buffer.from(SECRET)]));
      expect(Buffer.from(cleaned.bytes).equals(bytes(name))).toBe(true);
      expect([cleaned.width, cleaned.height]).toEqual([24, 16]);
    }
  });

  test('a RIFF size that lies is refused', () => {
    const lying = Buffer.from(bytes('webpLossy'));
    lying.writeUInt32LE(5000, 4);
    expect(() => cleanImage(lying)).toThrow(ImageError);
  });
});

describe('GIF', () => {
  const original = bytes('gif');

  test('comments, plain text and XMP extensions are gone; frames and the loop count stay', () => {
    const subBlocks = (data: Buffer) => Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0])]);
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from(SECRET))]);
    const xmp = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP'), subBlocks(Buffer.from(SECRET))]);
    const loop = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), subBlocks(Buffer.from([1, 0, 0]))]);
    // Blocks go where the fixture's first frame starts.
    const colours = 3 * 2 ** ((original[10]! & 7) + 1);
    const at = 13 + colours;
    const dirty = Buffer.concat([original.subarray(0, at), comment, xmp, loop, original.subarray(at), Buffer.from(SECRET)]);
    const cleaned = cleanImage(dirty);
    expect(has(dirty, secret)).toBe(true);
    expect(has(cleaned.bytes, secret)).toBe(false);
    expect(has(cleaned.bytes, 'XMP Data')).toBe(false);
    expect(has(cleaned.bytes, 'NETSCAPE2.0')).toBe(true);
    expect([cleaned.mimeType, cleaned.width, cleaned.height]).toEqual(['image/gif', 24, 16]);
    expect(cleaned.bytes.at(-1)).toBe(0x3b);
  });

  test('a GIF without a trailer or frames is refused', () => {
    expect(() => cleanImage(original.subarray(0, original.length - 1))).toThrow(ImageError);
    const colours = 3 * 2 ** ((original[10]! & 7) + 1);
    expect(() => cleanImage(Buffer.concat([original.subarray(0, 13 + colours), Buffer.from([0x3b])]))).toThrow(ImageError);
  });
});

test('SVG, AVIF, HTML and garbage are unsupported whatever they are called; SVG never gets in', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(32)]);
  for (const input of [svg, avif, Buffer.from('<html><body>hi</body></html>'), Buffer.from('GIF'), Buffer.alloc(0), Buffer.alloc(64)]) {
    expect(() => cleanImage(input)).toThrow(expect.objectContaining({ code: 'unsupported' }));
  }
  // An SVG with a PNG header glued in front is still no PNG.
  expect(() => cleanImage(Buffer.concat([bytes('png').subarray(0, 8), svg]))).toThrow(ImageError);
});
