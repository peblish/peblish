import { cleanGif } from './image/gif.ts';
import { cleanJpeg } from './image/jpeg.ts';
import { cleanPng } from './image/png.ts';
import { ImageError, maxImagePixels, maxImageSide, type CleanImage, type ImageType } from './image/types.ts';
import { cleanWebp } from './image/webp.ts';
import { sniffRaster } from './sniff.ts';

// An uploaded or fetched image is rewritten before it is stored, never kept as received. The
// container is parsed strictly and rebuilt from the parts that decide what is drawn (see the
// format files), so Exif (GPS position, camera, owner), XMP, IPTC, ICC profiles, comments and
// anything appended after the image are gone, and a file that is not well formed is refused.
// The pixel data itself is not decoded or re-encoded: no native or wasm codec ships in the
// image (G0-STATUS wave 1 decision 6), and nothing here allocates per pixel, so a decompression
// bomb costs nothing. A thumbnail is therefore the image as sent, not a resized copy.

export { ImageError } from './image/types.ts';
export type { CleanImage, ImageType } from './image/types.ts';

/** The extension a stored object of each type gets. */
export const imageExtensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const satisfies Record<ImageType, string>;

/**
 * The image rewritten without metadata, with its type and size. Throws ImageError: `unsupported`
 * for anything but JPEG, PNG, WebP and GIF (SVG and AVIF included, whatever the declared type),
 * `invalid` for a damaged file, `too_large` past maxImageSide or maxImagePixels.
 */
export function cleanImage(input: Uint8Array): CleanImage {
  const type = sniffRaster(input);
  if (type === null || type === 'image/avif') throw new ImageError('unsupported', 'not a JPEG, PNG, WebP or GIF image');
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    const cleaners = { 'image/jpeg': cleanJpeg, 'image/png': cleanPng, 'image/gif': cleanGif, 'image/webp': cleanWebp };
    const { bytes, width, height } = cleaners[type](buffer);
    if (Math.max(width, height) > maxImageSide || width * height > maxImagePixels) {
      throw new ImageError('too_large', `${width}x${height} is larger than ${maxImageSide} pixels a side or ${maxImagePixels} in all`);
    }
    return { mimeType: type, bytes, width, height };
  } catch (error) {
    // A read past the end of the buffer is a file that ends early.
    if (error instanceof RangeError) throw new ImageError('invalid', 'the file ends early');
    throw error;
  }
}
