import { isImageContentType } from '@peblish/core/media/image-src';
import type { MediaContent } from '@peblish/core/media/proxy-url';
import type { PostView } from '@peblish/schema/views';

/** One post of a page: the view, and the picture the card may load (already through the proxy rule). */
export type FeedItem = { post: PostView; thumbnailSrc: string | null };

/** The address up to the host, or null when it is not an absolute one. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * A post for the page data. The card draws `thumbnailSrc` (`image` is the renderer's
 * resolver: own-origin path, signed proxy URL or null), so no picture address goes into the
 * page. An image post's `url` is the picture itself and is cut to its origin: the card still
 * marks the post as an image and prints the host it already prints for any link, and the
 * remote path and query stay on the server.
 */
export function feedItem(post: PostView, image: (url: string | null, content: MediaContent) => string | null): FeedItem {
  const isImage = isImageContentType(post.urlContentType);
  return {
    post: { ...post, thumbnailUrl: null, url: isImage && post.url ? originOf(post.url) : post.url },
    thumbnailSrc: image(post.thumbnailUrl ?? (isImage ? post.url : null), { kind: 'post', id: post.id }),
  };
}
