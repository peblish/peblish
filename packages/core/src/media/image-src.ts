/** The settings an image source depends on; web's SiteMarkdown has exactly these. */
export type ImagePolicy = {
  /** This instance's origin. */
  origin: string;
  /** The remote_media.enabled kill switch. */
  remoteMedia: boolean;
  /** The proxy URL builder (proxy-url.ts); without it remote images are never loaded. */
  proxy?: (url: string) => string;
};

/**
 * Where a page loads an image from, for a post's thumbnail as for an image inside a body: this
 * instance's own URL as it is, a remote one through the signed proxy so the viewer's address
 * never reaches the remote host (decision 5), and null when it must not load (remote media is
 * off, no proxy, not http or https, too long to proxy). The caller then shows a link or nothing.
 */
export function imageSource(url: string | null | undefined, policy: ImagePolicy): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.origin === policy.origin) return url;
  if (!policy.remoteMedia || !policy.proxy) return null;
  try {
    return policy.proxy(url);
  } catch {
    return null;
  }
}

/**
 * Whether a post's `url_content_type` says its link is an image to show: any `image/` type,
 * including the placeholder `image/*` that PieFed's Image attachments without a media type
 * get (FIT), but not SVG, which the proxy never serves.
 */
export function isImageContentType(contentType: string | null | undefined): boolean {
  const type = contentType?.trim().toLowerCase();
  return !!type?.startsWith('image/') && !type.startsWith('image/svg');
}
