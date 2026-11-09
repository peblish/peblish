import { markdownMaxLength, remoteHtmlMaxLength } from '@peblish/schema/markdown';
import { renderMarkdown } from '../markdown/render.ts';
import { sanitizeRemoteHtml } from '../markdown/sanitize.ts';

// How a post body becomes the HTML stored in posts.content_html. That HTML is what federates
// (peers get original image URLs, no rewrite), so it is rendered here, in core, for the
// instance's own origin. Pages do not print it as is: they render bodyMd, or sanitise a
// remote post's HTML, through the web renderer, which adds the origin and media policy.

/** A local post's Markdown, rendered. Null when there is no body. */
export function renderLocalBody(bodyMd: string | null | undefined, origin: string, postId: string): string | null {
  if (!bodyMd) return null;
  return renderMarkdown(bodyMd, { baseOrigin: origin, idPrefix: postId }).html;
}

/**
 * A peer's post body. Markdown source (Lemmy and PieFed send it beside the HTML) is rendered
 * like our own, with relative links meaning this instance, as in lemmy-ui; otherwise the HTML
 * is sanitised against the object's URL. Returns the Markdown kept and the HTML to store.
 */
export function remoteBody(
  body: { bodyMd: string | null; contentHtml: string | null },
  origin: string,
  postId: string,
  objectUrl: string,
): { bodyMd: string | null; contentHtml: string | null } {
  if (body.bodyMd) {
    const bodyMd = body.bodyMd.slice(0, markdownMaxLength);
    return { bodyMd, contentHtml: renderLocalBody(bodyMd, origin, postId) };
  }
  if (!body.contentHtml) return { bodyMd: null, contentHtml: null };
  return { bodyMd: null, contentHtml: sanitizeRemoteHtml(body.contentHtml, { baseUrl: objectUrl, maxLength: remoteHtmlMaxLength }).html };
}
