import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { authorize } from '../authz/authorize.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import type { Result } from '../identity/result.ts';
import { recordThumbnail } from '../media/record.ts';
import { saveImage } from '../media/save.ts';
import { sniffRaster } from '../media/sniff.ts';
import { safeFetch, type SafeResponse } from '../net/fetch.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { readPageMeta } from './html.ts';

// Link previews (C02), fetched when a person writes a link post, before createPost: no
// network call happens inside the post's transaction. Everything goes through safeFetch, so
// a link to a private address, a metadata service or a redirect into one yields no preview.

/** What createPost takes from a preview, plus the page's own description. */
export type LinkPreview = {
  /** The page's title, as a suggestion for the post title (at most 200 characters). */
  title: string | null;
  description: string | null;
  /** The media type of what the link points at: text/html, image/png and so on. */
  urlContentType: string | null;
  /**
   * Where the stored thumbnail will be served from (`<origin>/media/<id>`), or null. The row
   * is scan_state 'pending' and nothing serves it before lane SAFE marks it clean, so until
   * then this URL answers 404.
   */
  thumbnailUrl: string | null;
  mediaId: Uuid | null;
};

const noPreview: LinkPreview = { title: null, description: null, urlContentType: null, thumbnailUrl: null, mediaId: null };

export const previewLimits = {
  /** The page: its head is all that is read, but a page may put it after a lot of script. */
  pageBytes: 512 * 1024,
  /** The thumbnail source, as downloaded. */
  imageBytes: 2 * 1024 * 1024,
  redirects: 3,
  timeoutMs: 5_000,
};

type Fetcher = (url: string, init: Parameters<typeof safeFetch>[1]) => Promise<SafeResponse>;

const mediaType = (headers: Headers) => headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;

/** The page as text, in the charset its headers or its first meta tag name (UTF-8 otherwise). */
function decodePage(response: SafeResponse): string {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1];
  const sniffed = /<meta[^>]{0,200}?charset\s*=\s*["']?([\w-]+)/i.exec(
    Buffer.from(response.body.subarray(0, 1024)).toString('latin1'),
  )?.[1];
  for (const label of [declared, sniffed]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(response.body);
    } catch {
      // An unknown label: try the next, then UTF-8.
    }
  }
  return new TextDecoder().decode(response.body);
}

/**
 * The preview of a link: title and description from the page's Open Graph tags (or its
 * <title>), and the image they name, downloaded, cleaned of metadata and stored as a
 * 'thumbnail' media row (scan_state 'pending'). A page that cannot be fetched, a blocked
 * destination, a missing image or an image that cannot be stored just leave those fields null.
 * Refused with `site.disabled` while remote_media.enabled is off (the kill switch for
 * previews too), and with auth.required or auth.email_unverified for accounts that cannot post.
 */
export async function fetchLinkPreview(
  principal: Principal,
  url: string,
  options: { store?: ObjectStore; fetch?: Fetcher } = {},
): Promise<Result<LinkPreview>> {
  const decision = await authorize('media.thumbnail', principal, {});
  if (!decision.ok) return decision;
  const fetch: Fetcher = options.fetch ?? safeFetch;
  const { origin } = await localInstance(db());
  const get = (target: string, accept: string, maxBytes: number) =>
    fetch(target, {
      schemes: ['https:', 'http:'],
      maxRedirects: previewLimits.redirects,
      maxBytes,
      timeoutMs: previewLimits.timeoutMs,
      headers: { accept, 'user-agent': `peblish-link-preview/1 (+${origin})` },
    });

  let page: SafeResponse;
  try {
    page = await get(url, 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', previewLimits.pageBytes);
  } catch {
    return { ok: true, ...noPreview };
  }
  if (page.status !== 200) return { ok: true, ...noPreview };
  const sniffed = sniffRaster(page.body);
  const type = sniffed ?? mediaType(page.headers);
  // A link straight to an image is an image post: nothing to read, nothing to store.
  if (sniffed || !type?.includes('html')) return { ok: true, ...noPreview, urlContentType: type };

  const meta = readPageMeta(decodePage(page), page.url);
  const preview: LinkPreview = { ...noPreview, title: meta.title, description: meta.description, urlContentType: type };
  if (!meta.image) return { ok: true, ...preview };
  try {
    const image = await get(meta.image, 'image/*', previewLimits.imageBytes);
    if (image.status !== 200 || image.truncated) return { ok: true, ...preview };
    const saved = await saveImage({
      bytes: image.body,
      remoteUrl: meta.image,
      store: options.store ?? s3Store(),
      record: (row) => recordThumbnail(decision.grant, row),
    });
    if (saved.ok) return { ok: true, ...preview, mediaId: saved.id, thumbnailUrl: `${origin}/media/${saved.id}` };
  } catch {
    // The page is fine without its picture.
  }
  return { ok: true, ...preview };
}
