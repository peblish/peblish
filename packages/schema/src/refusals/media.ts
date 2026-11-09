// Owned by lane B2: image uploads and the thumbnails of link previews. Whether uploads or
// previews are switched off is `site.disabled`; a missing login is `auth.required`.
export const refusals = {
  'media.unsupported_type':
    'The file is not a JPEG, PNG, WebP or GIF image (SVG and every other type are refused, whatever the upload claims).',
  'media.invalid_image': 'The image file is damaged, cut short or not well formed.',
  'media.too_large': 'The file, or the image inside it, is over the size limit.',
};
