import { isImageContentType } from '@peblish/core/media/image-src';
import type { PostPage } from '@peblish/core/posts/read';
import type { PostView } from '@peblish/schema/views';
import type { MarkdownRenderer } from '../../server/markdown.ts';
import { withheldAuthor } from './-withheld.ts';

// The decisions of the post page's data that need no request (-load.ts has the rest), apart from
// the server function so they are unit tested.

/**
 * Root-relative paths are this instance's own media; the renderer's image() resolves everything
 * else. The same pattern as core's imageSource: a second slash or a backslash after the first
 * would make the browser read the path as another host.
 */
const rootRelative = /^\/(?![/\\])/;

/**
 * The thumbnail and the picture of an image post, as the page may load them: this instance's own
 * URL as it is, a remote one through the signed proxy, and null when it must not load (remote
 * media off, no proxy, a URL too long to proxy), where the page shows a link or nothing. An image
 * post is a link whose media type is an image other than SVG.
 */
export function postMedia(
  view: Pick<PostView, 'id' | 'apId' | 'url' | 'urlContentType' | 'thumbnailUrl'>,
  renderer: Pick<MarkdownRenderer, 'image'>,
) {
  const source = (url: string | null) =>
    url && rootRelative.test(url) ? url : renderer.image(url, { kind: 'post', id: view.id, apId: view.apId });
  return {
    thumbnail: source(view.thumbnailUrl),
    image: isImageContentType(view.urlContentType) ? source(view.url) : null,
  };
}

/**
 * Whether the thread may be sent with the post: not while the gate withholds the post (signed
 * out, no 16+ declaration, or Hide NSFW on), and not under a post a moderator removed, except to the
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
}): boolean => gate === 'none' && (!view.removed || moderator);

/**
 * Whether the post's author goes to this viewer: a live post's always; a tombstone's (deleted, or removed)
 * only to staff (the community's moderators and site admins, `moderator`) and to the author, who restores
 * their own deleted post from the page.
 */
export const authorShown = (
  page: { view: Pick<PostView, 'deleted' | 'removed' | 'author'>; moderator: boolean },
  viewerId: string | null,
) => (!page.view.deleted && !page.view.removed) || page.moderator || viewerId === page.view.author.id;

/**
 * The post as its page sends it to `viewerId`. A tombstone keeps its flags, community, time and counts
 * but says nothing of its author: no id, name, handle or badge, and no address of its own, since a
 * federated post's address can hold its author's handle. Where authorShown holds, core's view as it is.
 */
export function postForViewer(page: { view: PostView; moderator: boolean }, viewerId: string | null): PostView {
  return authorShown(page, viewerId) ? page.view : { ...page.view, apId: '', author: withheldAuthor, authorBadge: null };
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * "Nov 9, 2026, 2:39 AM UTC": a date and time in UTC, in the request's locale. The loader
 * formats it and the page prints the string it was given, so hydration never formats a date
 * itself: Node's and each browser's ICU data differ in small ways, and any difference would be
 * a hydration mismatch. Fixed fields, because dateStyle cannot be combined with timeZoneName.
 */
export function postTime(locale: string, iso: string): string {
  let format = timeFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    });
    timeFormats.set(locale, format);
  }
  return format.format(new Date(iso));
}

/**
 * Whether a body the renderer or the sanitiser produced holds a spoiler: a block one (`::: spoiler`, a
 * <details>) or an inline one (a span the UI blacks out). The post's Spoiler badge is derived from it, so
 * it needs no field of its own.
 */
export const hasSpoiler = (html: string | null): boolean =>
  html !== null && /<details[\s>]|<span class="(?:[^"]*\s)?spoiler(?:\s[^"]*)?"/.test(html);
