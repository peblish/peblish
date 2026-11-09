import { isImageContentType } from '@peblish/core/media/image-src';
import type { PostPage } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import type { MarkdownRenderer } from '../../server/markdown.ts';

// The two decisions of the post page's data that need no request (-load.ts has the rest), apart
// from the server function so they are unit tested.

/** Root-relative paths are this instance's own media; the renderer's image() resolves everything else. */
const rootRelative = /^\/(?!\/)/;

/**
 * The thumbnail and the picture of an image post, as the page may load them: this instance's own
 * URL as it is, a remote one through the signed proxy, and null when it must not load (remote
 * media off, no proxy, a URL too long to proxy), where the page shows a link or nothing. An image
 * post is a link whose media type is an image other than SVG.
 */
export function postMedia(view: Pick<PostView, 'url' | 'urlContentType' | 'thumbnailUrl'>, renderer: Pick<MarkdownRenderer, 'image'>) {
  const source = (url: string | null) => (url && rootRelative.test(url) ? url : renderer.image(url));
  return {
    thumbnail: source(view.thumbnailUrl),
    image: isImageContentType(view.urlContentType) ? source(view.url) : null,
  };
}

/**
 * Whether the thread may be sent with the post: not while the gate withholds the post (signed
 * out, or no 16+ declaration), and not under a post a moderator removed, except to the
 * moderators and admins who still read that post. A deleted post is a tombstone whose comments
 * stay listed.
 */
export const threadVisible = ({
  gate,
  view,
  moderator,
}: {
  gate: PostPage['gate'];
  view: Pick<PostView, 'removed'>;
  moderator: boolean;
}): boolean => (gate === 'none' || gate === 'blur') && (!view.removed || moderator);
