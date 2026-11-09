import { expectThat, type Cleaned } from './types.ts';

// JPEG: segments are copied through unless they carry metadata. Kept: the frame (SOF), the
// tables (DQT, DHT, DRI, DAC), every scan with its entropy-coded data, and the Adobe APP14
// segment (it says how a CMYK or YCCK image is stored). Dropped: every other APPn (Exif with
// its GPS position and camera, XMP, IPTC, Photoshop resources, ICC profiles, JFIF thumbnails),
// comments, and anything after EOI. A phone photo's Exif orientation is the one thing the
// picture needs, so a 34-byte Exif segment holding only the orientation is written back.
// A kept segment must be exactly as long as its fields say (`expectPayload`), since bytes after
// the defined fields are where a marker would hide, so a table or header with a suffix is
// refused. Adobe APP14 is the exception: some Adobe tools append private bytes to it, and real
// files carry them, so it is written again at its defined 12 bytes. Only the entropy-coded scan
// data stays opaque (it cannot be judged without decoding it).

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DHT = 0xc4;
const DAC = 0xcc;
const DQT = 0xdb;
const DRI = 0xdd;
const APP14 = 0xee;
const isRestart = (marker: number) => marker >= 0xd0 && marker <= 0xd7;
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== DHT && marker !== 0xc8 && marker !== DAC;
const keptTable = (marker: number) => marker === DHT || marker === DAC || marker === DQT || marker === DRI;

/** Adobe APP14: "Adobe", a version, two flag words and the colour transform byte. */
const ADOBE_PAYLOAD = 12;

/** Whether the tables in a DQT or DHT payload fill it exactly, with no byte left over. */
function tablesFillPayload(marker: number, payload: Buffer): boolean {
  let at = 0;
  while (at < payload.length) {
    const info = payload[at] ?? 0;
    if (marker === DQT) {
      // High nibble: 0 for 8-bit entries (64 bytes), 1 for 16-bit entries (128 bytes).
      if (info >> 4 > 1) return false;
      at += 1 + 64 * ((info >> 4) + 1);
    } else {
      // Sixteen counts of codes per length, then one symbol per code.
      if (at + 17 > payload.length) return false;
      let symbols = 0;
      for (let length = 1; length <= 16; length++) symbols += payload[at + length] ?? 0;
      if (symbols > 256) return false;
      at += 17 + symbols;
    }
  }
  return at === payload.length && payload.length > 0;
}

/**
 * Throws unless a kept segment's payload (the bytes after its length field) is exactly the
 * size its fields define. Frame and scan headers count their components; DQT and DHT count their
 * tables; DRI is one word; DAC is pairs of bytes.
 */
function expectPayload(marker: number, payload: Buffer): void {
  const components = payload[isFrame(marker) ? 5 : 0] ?? 0;
  let exact: boolean;
  if (isFrame(marker)) exact = components > 0 && payload.length === 6 + 3 * components;
  else if (marker === SOS) exact = components > 0 && payload.length === 4 + 2 * components;
  else if (marker === DQT || marker === DHT) exact = tablesFillPayload(marker, payload);
  else if (marker === DRI) exact = payload.length === 2;
  else exact = payload.length > 0 && payload.length % 2 === 0; // DAC
  expectThat(exact, `JPEG: the 0x${marker.toString(16)} segment does not match the size its fields define`);
}

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
    const payload = segment.subarray(4);
    if (isFrame(marker)) {
      expectThat(size === null, 'JPEG: a second frame header');
      expectPayload(marker, payload);
      size = { height: segment.readUInt16BE(5), width: segment.readUInt16BE(7) };
      kept.push(segment);
    } else if (marker === SOS) {
      expectThat(size !== null, 'JPEG: a scan before the frame');
      expectPayload(marker, payload);
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
      expectPayload(marker, payload);
      kept.push(segment);
    } else if (marker === APP14 && segment.toString('latin1', 4, 9) === 'Adobe') {
      expectThat(payload.length >= ADOBE_PAYLOAD, 'JPEG: the Adobe segment is shorter than its fields');
      kept.push(Buffer.from([0xff, APP14, 0x00, 2 + ADOBE_PAYLOAD]), payload.subarray(0, ADOBE_PAYLOAD));
    } else if (marker === 0xe1) {
      orientation ??= exifOrientation(segment.subarray(4));
    }
    pos = end;
  }
  expectThat(size !== null && size.width > 0 && size.height > 0 && scans > 0, 'JPEG: no frame or no scan');
  const head = [Buffer.from([0xff, SOI]), ...(orientation ? [orientationSegment(orientation)] : [])];
  return { bytes: Buffer.concat([...head, ...kept, Buffer.from([0xff, EOI])]), ...size };
}
