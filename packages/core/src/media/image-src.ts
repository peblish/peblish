import { hostUnder } from '../peers/domains.ts';
import type { MediaContent } from './proxy-url.ts';

/** The settings an image source depends on; web's SiteMarkdown has exactly these. */
export type ImagePolicy = {
  /** This instance's origin. */
  origin: string;
  /** The remote_media.enabled kill switch. */
  remoteMedia: boolean;
  /** The proxy URL builder (proxy-url.ts); without it remote images are never loaded. */
  proxy?: (url: string, content?: MediaContent | null) => string;
  /**
   * Peer domains whose media is denied (peers/gate.ts deniedMediaDomains): an image hosted at or
   * under one, or shown for content one of them supplied, is treated like remote media switched off.
   */
  deniedDomains?: readonly string[];
};

/** What an image is shown for, as a page knows it: the content's kind, id and ap_id (whose host is the peer that supplied it). */
export type ImageContent = { kind: MediaContent['kind']; id: MediaContent['id']; apId: string };

/** The signed form of `content`: its supplier is its ap_id's host, or null when that is this instance; undefined for an ap_id that is not a URL. */
function signedContent(content: ImageContent, origin: string): MediaContent | undefined {
  const apId = URL.parse(content.apId);
  if (!apId) return undefined;
  return { kind: content.kind, id: content.id, supplier: apId.origin === origin ? null : apId.host };
}

/**
 * A root-relative path stays on the page's host: one slash, then anything but another slash or a
 * backslash. `//host/x` and `/\host/x` are protocol-relative to a browser and would load from
 * another host. (`/%2f/` is a plain path: browsers do not decode it.)
 */
const ROOT_RELATIVE = /^\/(?![/\\])/;

/**
 * Where a page loads an image from, for a post's thumbnail as for an image inside a body: this
 * instance's own media as a root-relative path (the viewer may reach the instance under another
 * host than the stored origin), a remote one through the signed proxy so the viewer's address
 * never reaches the remote host (decision 5), and null when it must not load (remote media is
 * off, no proxy, a peer whose media is denied, not http or https, too long to proxy). The caller then shows a link or nothing.
 * An own-origin URL whose path would not be root-relative (`https://<origin>//evil.example/x.png`)
 * is treated like any other URL, so it is never an `<img src>` that leaves the host. `content`
 * is what the image is shown for, signed into the proxy URL with its supplier so the proxy
 * refuses it once that content is withheld or that peer's media is denied; without it the URL
 * expires (proxy-url.ts).
 */
export function imageSource(url: string | null | undefined, policy: ImagePolicy, content: ImageContent | null = null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const path = `${parsed.pathname}${parsed.search}`;
  if (parsed.origin === policy.origin && ROOT_RELATIVE.test(path)) return path;
  if (!policy.remoteMedia || !policy.proxy) return null;
  const signed = content ? signedContent(content, policy.origin) : null;
  if (signed === undefined) return null;
  const denied = (host: string) => policy.deniedDomains?.some((domain) => hostUnder(host, domain)) ?? false;
  if (denied(parsed.host) || (signed?.supplier && denied(signed.supplier))) return null;
  try {
    return policy.proxy(url, signed);
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
