import { createHash } from 'node:crypto';
import { publicOrigin } from '@peblish/core/config';
import { imageSource } from '@peblish/core/media/image-src';
import { mediaProxyKey, proxyUrlBuilder } from '@peblish/core/media/proxy-url';
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
  proxy?: (url: string) => string;
}

export interface MarkdownRenderer {
  /** A local or remote Markdown body. idPrefix keeps footnote anchors apart on a page with many bodies. */
  render(source: string, options?: { idPrefix?: string; maxLength?: number; excerptLength?: number }): RenderedMarkdown;
  /** A remote object's HTML `content`; baseUrl is the object's URL. */
  sanitize(html: string, options?: { baseUrl?: string; excerptLength?: number }): SanitizedHtml;
  /**
   * Where a page loads an image from, such as a post's `thumbnailUrl` or an image post's `url`:
   * the URL itself on this instance, the signed proxy path for a remote one, or null when it
   * must not load (the caller shows a link or nothing).
   */
  image(url: string | null | undefined): string | null;
}

/** The settings of this instance: PUBLIC_ORIGIN, the stored kill switch and the remote-media proxy. */
export async function siteMarkdown(): Promise<SiteMarkdown> {
  const origin = publicOrigin();
  if (!origin) throw new Error('PUBLIC_ORIGIN is not set; Markdown links and mentions need the instance origin');
  return { origin, remoteMedia: await readSetting('remote_media.enabled'), proxy: proxyUrlBuilder(await mediaProxyKey()) };
}

export async function createMarkdownRenderer(site?: SiteMarkdown): Promise<MarkdownRenderer> {
  const { origin, remoteMedia, proxy } = site ?? (await siteMarkdown());
  const image = (url: string | null | undefined) => imageSource(url, { origin, remoteMedia, proxy });
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
    render: (source, options = {}) =>
      memo(rendered, [source, options], () => renderMarkdown(source, { ...options, baseOrigin: origin, rewriteImageUrl: image })),
    sanitize: (html, options = {}) =>
      memo(sanitized, [html, options], () => sanitizeRemoteHtml(html, { ...options, rewriteImageUrl: image })),
    image,
  };
}
