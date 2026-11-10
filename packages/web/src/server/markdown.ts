import { createHash } from 'node:crypto';
import { publicOrigin } from '@peblish/core/config';
import { imageSource, type ImageContent } from '@peblish/core/media/image-src';
import { mediaProxyKey, proxyUrlBuilder, type MediaContent } from '@peblish/core/media/proxy-url';
import { deniedMediaDomains } from '@peblish/core/peers/gate';
import { renderMarkdown } from '@peblish/core/markdown/render';
import { sanitizeRemoteHtml } from '@peblish/core/markdown/sanitize';
import { readSetting } from '@peblish/core/settings/read';
import type { RenderedMarkdown, SanitizedHtml } from '@peblish/schema/markdown';

// Server-only Markdown and remote HTML for pages: the site's settings applied once, and each
// body rendered once per request however often the page shows it. Create one renderer per
// request (in the loader or server function) and drop it with the request.

/** The site settings a renderer applies. */
export interface SiteMarkdown {
  /** This instance's origin: relative links resolve against it, mentions link to it. */
  origin: string;
  /** The remote_media.enabled kill switch. */
  remoteMedia: boolean;
  /**
   * The remote-media proxy URL for an off-origin image: a signed /media/proxy path, which
   * siteMarkdown() sets. Without it, or with remote media switched off, off-origin images show
   * as links: viewer IPs never reach remote hosts (decision 5).
   */
  proxy?: (url: string, content?: MediaContent | null) => string;
  /** Peer domains whose media is denied (new peers are quarantined until approved); their images show as links. */
  deniedDomains?: readonly string[];
}

/**
 * What a body or an image belongs to (a post, a comment, a profile or community page), with its
 * ap_id. Remote images are signed for it and for the peer that supplied it, so the proxy refuses
 * them once it is removed, deleted or gated for the viewer, or that peer's media is denied; text
 * that belongs to nothing yet (a draft's preview, a site page) leaves it out, and its images'
 * URLs expire within two hours (core media/proxy-url.ts).
 */
type Content = { content?: ImageContent };

export interface MarkdownRenderer {
  /** A local or remote Markdown body. idPrefix keeps footnote anchors apart on a page with many bodies. */
  render(source: string, options?: { idPrefix?: string; maxLength?: number; excerptLength?: number } & Content): RenderedMarkdown;
  /** A remote object's HTML `content`; baseUrl is the object's URL. */
  sanitize(html: string, options?: { baseUrl?: string; excerptLength?: number } & Content): SanitizedHtml;
  /**
   * Where a page loads an image from, such as a post's `thumbnailUrl` or an image post's `url`:
   * the URL itself on this instance, the signed proxy path for a remote one (for `content`), or
   * null when it must not load (the caller shows a link or nothing).
   */
  image(url: string | null | undefined, content?: ImageContent): string | null;
}

/** The settings of this instance: PUBLIC_ORIGIN, the stored kill switch and the remote-media proxy. */
export async function siteMarkdown(): Promise<SiteMarkdown> {
  const origin = publicOrigin();
  if (!origin) throw new Error('PUBLIC_ORIGIN is not set; Markdown links and mentions need the instance origin');
  return {
    origin,
    remoteMedia: await readSetting('remote_media.enabled'),
    proxy: proxyUrlBuilder(await mediaProxyKey()),
    deniedDomains: await deniedMediaDomains(),
  };
}

export async function createMarkdownRenderer(site?: SiteMarkdown): Promise<MarkdownRenderer> {
  const { origin, remoteMedia, proxy, deniedDomains } = site ?? (await siteMarkdown());
  const image = (url: string | null | undefined, content?: ImageContent) =>
    imageSource(url, { origin, remoteMedia, proxy, deniedDomains }, content ?? null);
  const rendered = new Map<string, RenderedMarkdown>();
  const sanitized = new Map<string, SanitizedHtml>();
  // Keyed by a hash of the input and its options, so large bodies are not kept twice.
  const memo = <T>(cache: Map<string, T>, parts: unknown[], run: () => T): T => {
    const key = createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
    const hit = cache.get(key);
    if (hit) return hit;
    const result = run();
    cache.set(key, result);
    return result;
  };
  return {
    render: (source, { content, ...options } = {}) =>
      memo(rendered, [source, options, content], () =>
        renderMarkdown(source, { ...options, baseOrigin: origin, rewriteImageUrl: (url) => image(url, content) }),
      ),
    sanitize: (html, { content, ...options } = {}) =>
      memo(sanitized, [html, options, content], () =>
        sanitizeRemoteHtml(html, { ...options, rewriteImageUrl: (url) => image(url, content) }),
      ),
    image,
  };
}
