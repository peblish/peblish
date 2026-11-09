import { bytes } from './images.ts';

// The metadata a camera or editor leaves behind. Each test plants a recognisable string in
// every place a format has for it and shows that no copy of the string survives.
export const SECRET = 'GPS-52.5200N-13.4050E-owner-andrew';
export const secret = Buffer.from(SECRET);
export const has = (haystack: Uint8Array, needle: Buffer | string) => Buffer.from(haystack).includes(needle);

/** Exif with an Orientation entry, a GPS IFD holding SECRET, and a camera make. */
export function exifSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(80);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8); // two entries: Orientation, GPSInfo pointer
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt16BE(0x8825, 22);
  tiff.writeUInt16BE(4, 24);
  tiff.writeUInt32BE(1, 26);
  tiff.writeUInt32BE(44, 30);
  tiff.write(SECRET, 44, 'latin1');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

export const segment = (marker: number, payload: Buffer | string) => {
  const body = Buffer.from(payload);
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

/** The JPEG fixture without its own JFIF and Exif, with ours after SOI plus a comment, XMP and trailing bytes. */
export function dirtyJpeg(orientation: number): Buffer {
  const original = bytes('jpeg');
  let at = 2;
  while (original[at + 1] === 0xe0 || original[at + 1] === 0xe1) at += 2 + original.readUInt16BE(at + 2);
  return Buffer.concat([
    original.subarray(0, 2),
    exifSegment(orientation),
    segment(0xe1, `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${SECRET}</x:xmpmeta>`),
    segment(0xed, `Photoshop 3.0\0${SECRET}`),
    segment(0xfe, SECRET),
    original.subarray(at),
    Buffer.from(`trailing ${SECRET}`),
  ]);
}
