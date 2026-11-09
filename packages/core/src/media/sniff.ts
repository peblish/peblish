/** The raster formats a browser shows from their first bytes (never SVG, which is XML). */
export type RasterType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif';

/** What the first bytes say the file is, or null for anything else. The declared type is not trusted. */
export function sniffRaster(bytes: Uint8Array): RasterType | null {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // ISO base media: a "ftyp" box whose major brand is avif or avis.
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(head.toString('latin1', 8, 12)))
    return 'image/avif';
  return null;
}
