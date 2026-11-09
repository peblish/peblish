import { type } from 'arktype';

// Without JavaScript a refused post cannot keep the form in the page: the server answers 303 back
// to /submit, and what was typed travels in one search parameter, `kept` (base64url JSON, so the
// router's own value parsing cannot mangle it). A long body does not fit in a URL and is left out.

export const Kept = type({
  'community?': 'string',
  'type?': "'text' | 'link' | 'image'",
  'title?': 'string',
  'url?': 'string',
  'body?': 'string',
  'nsfw?': 'boolean',
});
export type Kept = typeof Kept.infer;

/** The longest body that is kept; roughly what a search parameter can carry. */
export const keptBodyMaxLength = 2_000;

export function encodeKept(fields: Kept): string {
  const body = fields.body !== undefined && fields.body.length <= keptBodyMaxLength ? fields.body : undefined;
  const bytes = new TextEncoder().encode(JSON.stringify({ ...fields, body }));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/** What `encodeKept` made of it, or undefined for anything else (an edited or old URL is just ignored). */
export function decodeKept(value: string | undefined): Kept | undefined {
  if (!value) return undefined;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const json: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    // An array has no keys to fail on, so it would pass for an empty form.
    const kept = Array.isArray(json) ? undefined : Kept(json);
    return kept === undefined || kept instanceof type.errors ? undefined : kept;
  } catch {
    return undefined;
  }
}
