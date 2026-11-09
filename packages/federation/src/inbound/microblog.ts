import { sanitizeRemoteHtml } from '@peblish/core/markdown/sanitize';
import type { JsonObject } from '../mapping/json.ts';
import { isPublic } from '../mapping/vocabulary.ts';

// A top-level Note addressed to a community (a Mastodon status or an Mbin microblog post that
// names a community) is a post, not a comment (decisions.md): its title is the first non-empty
// line of the plain text, cut at 200 characters, and its body is the full text. The mapping
// reads a Page, so the Note is rewritten as one before it is mapped.

/** The most characters a microblog post's title keeps (Lemmy's limit). */
export const microblogTitleMax = 200;

const blockEnd = /<\/(p|div|li|h[1-6]|blockquote|pre|ul|ol)>|<br\s*\/?>/gi;
const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** The text of an HTML fragment with a line break at each block end. The fragment goes through the sanitiser first. */
export function htmlToText(html: string, baseUrl: string): string {
  const clean = sanitizeRemoteHtml(html, { baseUrl }).html;
  return clean
    .replace(blockEnd, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => entities[entity] ?? entity);
}

/** The first non-empty line of `text` (whitespace collapsed), cut at the title limit by characters, not UTF-16 units. */
export function titleOf(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.replace(/\s+/g, ' ').trim())
    .find((candidate) => candidate !== '');
  return [...(line ?? '')].slice(0, microblogTitleMax).join('');
}

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string');

/** Every address a Note names: audience, to, cc, the Public collection left out. */
export function addressesOf(note: JsonObject): string[] {
  return [...strings(note.audience), ...strings(note.to), ...strings(note.cc)].filter((address) => !isPublic(address));
}

/**
 * The Note as the Page the mapping reads, in `communityApId`. Its title comes from the text; the
 * HTML `content` stays as the body, and a Markdown `source` stays with it when the peer sent one.
 * A Note with no text at all gets no title and is refused by the mapping.
 */
export function noteAsPage(note: JsonObject, communityApId: string): JsonObject {
  const content = typeof note.content === 'string' ? note.content : '';
  const source = note.source;
  const markdown =
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    source.mediaType === 'text/markdown' &&
    typeof source.content === 'string'
      ? source.content
      : null;
  const text = markdown ?? htmlToText(content, typeof note.id === 'string' ? note.id : communityApId);
  const page: JsonObject = { ...note, type: 'Page', name: titleOf(text), audience: communityApId };
  delete page.inReplyTo;
  return page;
}
