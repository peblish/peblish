import { expectThat, type Cleaned } from './types.ts';

// JPEG: segments are copied through unless they carry metadata. Kept: the frame (SOF), the
// tables (DQT, DHT, DRI, DAC), every scan with its entropy-coded data, and the Adobe APP14
// segment (it says how a CMYK or YCCK image is stored). Dropped: every other APPn (Exif with
// its GPS position and camera, XMP, IPTC, Photoshop resources, ICC profiles, JFIF thumbnails),
// comments, and anything after EOI. A phone photo's Exif orientation is the one thing the
// picture needs, so a 34-byte Exif segment holding only the orientation is written back.

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const isRestart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const keptTable = (marker: number) => marker === 0xc4 || marker === 0xcc || marker === 0xdb || marker === 0xdd;

/** The Exif orientation (2 to 8; 1 means upright) of an APP1 payload, or null. */
function exifOrientation(exif: Buffer): number | null {
  if (exif.length < 14 || exif.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const tiff = exif.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  if ((order !== 'II' && order !== 'MM') || tiff.length < 8) return null;
  const little = order === 'II';
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const entries = Math.min(u16(ifd), 64);
  for (let i = 0; i < entries; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > tiff.length) return null;
    // Tag 0x0112 (Orientation), type 3 (SHORT), count 1.
    if (u16(at) === 0x0112 && u16(at + 2) === 3 && u32(at + 4) === 1) {
      const value = u16(at + 8);
      return value >= 2 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An Exif segment with an Orientation entry and nothing else. */
function orientationSegment(orientation: number): Buffer {
  return Buffer.from([
    0xff,
    0xe1,
    0x00,
    0x22, // APP1, length 34
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // big-endian TIFF header, IFD0 at 8
    0x00,
    0x01, // one entry
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // Orientation, SHORT, 1, value
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]);
}

export function cleanJpeg(input: Buffer): Cleaned {
  expectThat(input[0] === 0xff && input[1] === SOI, 'not a JPEG');
  const kept: Buffer[] = [];
  let orientation: number | null = null;
  let size: { width: number; height: number } | null = null;
  let scans = 0;
  let pos = 2;
  for (;;) {
    expectThat(pos + 1 < input.length && input[pos] === 0xff, 'JPEG: expected a marker');
    // Any number of 0xFF fill bytes may precede a marker.
    while (input[pos + 1] === 0xff) pos++;
    const marker = input[pos + 1] ?? 0;
    if (marker === EOI) break;
    expectThat(marker !== SOI && marker !== 0x00 && marker !== 0x01 && !isRestart(marker), 'JPEG: unexpected marker');
    expectThat(pos + 4 <= input.length, 'JPEG: segment cut short');
    const end = pos + 2 + input.readUInt16BE(pos + 2);
    expectThat(end >= pos + 4 && end <= input.length, 'JPEG: segment length out of range');
    const segment = input.subarray(pos, end);
    if (isFrame(marker)) {
      expectThat(size === null && segment.length >= 10, 'JPEG: a second or short frame header');
      size = { height: segment.readUInt16BE(5), width: segment.readUInt16BE(7) };
      kept.push(segment);
    } else if (marker === SOS) {
      expectThat(size !== null, 'JPEG: a scan before the frame');
      kept.push(segment);
      scans++;
      // The entropy-coded data runs to the next marker that is not a stuffed 0xFF00, a restart or a fill byte.
      let scanEnd = end;
      while (scanEnd + 1 < input.length) {
        const next = input[scanEnd + 1] ?? 0;
        if (input[scanEnd] === 0xff && next !== 0x00 && next !== 0xff && !isRestart(next)) break;
        scanEnd++;
      }
      expectThat(scanEnd + 1 < input.length, 'JPEG: the scan never ends');
      kept.push(input.subarray(end, scanEnd));
      pos = scanEnd;
      continue;
    } else if (keptTable(marker)) {
      kept.push(segment);
    } else if (marker === 0xee && segment.toString('latin1', 4, 9) === 'Adobe') {
      kept.push(segment);
    } else if (marker === 0xe1) {
      orientation ??= exifOrientation(segment.subarray(4));
    }
    pos = end;
  }
  expectThat(size !== null && size.width > 0 && size.height > 0 && scans > 0, 'JPEG: no frame or no scan');
  const head = [Buffer.from([0xff, SOI]), ...(orientation ? [orientationSegment(orientation)] : [])];
  return { bytes: Buffer.concat([...head, ...kept, Buffer.from([0xff, EOI])]), ...size };
}
