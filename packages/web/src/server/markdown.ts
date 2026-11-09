import { createHash } from 'node:crypto';
import { publicOrigin } from '@peblish/core/config';
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
   * The remote-media proxy URL for an off-origin image (lane B2). Without it, or with remote
   * media switched off, off-origin images show as links: viewer IPs never reach remote hosts
   * (decision 5).
   */
  proxy?: (url: string) => string;
}

export interface MarkdownRenderer {
  /** A local or remote Markdown body. idPrefix keeps footnote anchors apart on a page with many bodies. */
  render(source: string, options?: { idPrefix?: string; maxLength?: number; excerptLength?: number }): RenderedMarkdown;
  /** A remote object's HTML `content`; baseUrl is the object's URL. */
  sanitize(html: string, options?: { baseUrl?: string; excerptLength?: number }): SanitizedHtml;
}

/** The settings of this instance: PUBLIC_ORIGIN and the stored kill switch. */
export async function siteMarkdown(): Promise<SiteMarkdown> {
  const origin = publicOrigin();
  if (!origin) throw new Error('PUBLIC_ORIGIN is not set; Markdown links and mentions need the instance origin');
  return { origin, remoteMedia: await readSetting('remote_media.enabled') };
}

export async function createMarkdownRenderer(site?: SiteMarkdown): Promise<MarkdownRenderer> {
  const { origin, remoteMedia, proxy } = site ?? (await siteMarkdown());
  const rewriteImageUrl = (url: string) => {
    if (new URL(url).origin === origin) return url;
    return remoteMedia && proxy ? proxy(url) : null;
  };
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
      memo(rendered, [source, options], () => renderMarkdown(source, { ...options, baseOrigin: origin, rewriteImageUrl })),
    sanitize: (html, options = {}) => memo(sanitized, [html, options], () => sanitizeRemoteHtml(html, { ...options, rewriteImageUrl })),
  };
}
