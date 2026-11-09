import type { Principal } from '@peblish/schema/authz';
import { type } from 'arktype';
import { authorize } from '../authz/authorize.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import type { Result } from '../identity/result.ts';
import { sniffRaster } from '../media/sniff.ts';
import { safeFetch, type SafeResponse } from '../net/fetch.ts';
import { NewPost } from '../posts/input.ts';
import { readPageMeta } from './html.ts';

// Link previews (C02), fetched when a person writes a link post, before createPost: no
// network call happens inside the post's transaction. Everything goes through safeFetch, so
// a link to a private address, a metadata service or a redirect into one yields no preview.
// The page's picture is not downloaded: nothing fetched from a remote server is stored until
// lane SAFE's scanning is live, so the preview hands back the picture's URL and every page
// shows it through the remote-media proxy.

/** What createPost takes from a preview, plus the page's own description. */
export type LinkPreview = {
  /** The page's title, as a suggestion for the post title (at most 200 characters). */
  title: string | null;
  description: string | null;
  /** The media type of what the link points at: text/html, image/png and so on. */
  urlContentType: string | null;
  /**
   * The page's `og:image` (or Twitter image) as an absolute http(s) URL, or null. It is stored
   * as the post's `thumbnail_url` as it is; a page turns it into a signed proxy path with
   * `createMarkdownRenderer().image(url)`, so the viewer's address never reaches the remote host.
   */
  thumbnailUrl: string | null;
};

const noPreview: LinkPreview = { title: null, description: null, urlContentType: null, thumbnailUrl: null };

export const previewLimits = {
  /** The page: its head is all that is read, but a page may put it after a lot of script. */
  pageBytes: 512 * 1024,
  redirects: 3,
  timeoutMs: 5_000,
};

type Fetcher = (url: string, init: Parameters<typeof safeFetch>[1]) => Promise<SafeResponse>;

const mediaType = (headers: Headers) => headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || null;

// createPost refuses a post whose thumbnailUrl or urlContentType fails NewPost's checks (a URL
// over 2,000 characters, a content type that is not a media type), and both come from a stranger's
// page. They are checked here with NewPost's own validators, and a value that fails is null.
const thumbnailField = NewPost.get('thumbnailUrl');
const contentTypeField = NewPost.get('urlContentType');
const accepted = (field: (value: string) => unknown, value: string | null) =>
  value !== null && !(field(value) instanceof type.errors) ? value : null;

/** A preview whose two post fields are ones createPost takes. */
const forPost = (preview: LinkPreview): LinkPreview => ({
  ...preview,
  urlContentType: accepted(contentTypeField, preview.urlContentType),
  thumbnailUrl: accepted(thumbnailField, preview.thumbnailUrl),
});

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
 * <title>), and the URL of the image they name (not downloaded). A page that cannot be fetched
 * or a blocked destination just leaves those fields null. Refused with `site.disabled` while
 * remote_media.enabled is off (the kill switch for previews too), and with auth.required or
 * auth.email_unverified for accounts that cannot post: the check is the `media.thumbnail`
 * policy, which here gates making the server fetch an address a person chose.
 */
export async function fetchLinkPreview(principal: Principal, url: string, options: { fetch?: Fetcher } = {}): Promise<Result<LinkPreview>> {
  const decision = await authorize('media.thumbnail', principal, {});
  if (!decision.ok) return decision;
  const fetch: Fetcher = options.fetch ?? safeFetch;
  const { origin } = await localInstance(db());

  let page: SafeResponse;
  try {
    page = await fetch(url, {
      schemes: ['https:', 'http:'],
      maxRedirects: previewLimits.redirects,
      maxBytes: previewLimits.pageBytes,
      timeoutMs: previewLimits.timeoutMs,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5',
        'user-agent': `peblish-link-preview/1 (+${origin})`,
      },
    });
  } catch {
    return { ok: true, ...noPreview };
  }
  if (page.status !== 200) return { ok: true, ...noPreview };
  const sniffed = sniffRaster(page.body);
  const type = sniffed ?? mediaType(page.headers);
  // A link straight to an image is an image post: there is no page to read.
  if (sniffed || !type?.includes('html')) return { ok: true, ...forPost({ ...noPreview, urlContentType: type }) };

  const meta = readPageMeta(decodePage(page), page.url);
  return { ok: true, ...forPost({ title: meta.title, description: meta.description, urlContentType: type, thumbnailUrl: meta.image }) };
}
