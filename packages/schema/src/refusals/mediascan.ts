// Owned by lane SAFE (wave 3): scanning, quarantine and the blocked-image list. A refused
// action that needs a login or an admin is `auth.*`, a missing row `target.not_found`.
export const refusals = {
  'media.not_pending': 'The image is not waiting for a scan, so a scan result cannot be recorded for it.',
  'media.not_quarantined': 'The image is not quarantined, so it cannot be confirmed, released or held.',
  'media.already_decided': 'An admin already decided this image (confirmed or released it).',
  'media.hash_invalid': 'The value is not a SHA-256 hash (64 hexadecimal characters).',
  'media.hash_exists': 'The hash is already on the blocked-image list.',
  'media.hold_invalid': 'A hold needs a reference and a date in the future.',
  'media.rejected': 'The image was not accepted. The uploader is not told why.',
  'media.scan_unavailable': 'The image could not be checked right now, so it was not accepted. Trying again later may work.',
};
