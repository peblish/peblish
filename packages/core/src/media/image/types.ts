/** The formats a person may upload or a preview may store. SVG is never one of them. */
export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** An image rewritten to its pixels and the metadata a browser needs, nothing else. */
export type CleanImage = { mimeType: ImageType; bytes: Uint8Array; width: number; height: number };

/**
 * Why an image was refused: its format is not one of ImageType (`unsupported`), its structure is
 * damaged or lies about itself (`invalid`), or it is larger than the limits below (`too_large`).
 */
export class ImageError extends Error {
  readonly code: 'unsupported' | 'invalid' | 'too_large';
  constructor(code: ImageError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** The longest side and the pixel count a stored image may have (a browser decodes every pixel). */
export const maxImageSide = 8192;
export const maxImagePixels = 40_000_000;

/** What a format cleaner returns before the size limits are applied. */
export type Cleaned = { bytes: Uint8Array; width: number; height: number };

export const invalid = (why: string) => new ImageError('invalid', why);

/** Throws `invalid` unless `condition` holds. */
export function expectThat(condition: boolean, why: string): asserts condition {
  if (!condition) throw invalid(why);
}
