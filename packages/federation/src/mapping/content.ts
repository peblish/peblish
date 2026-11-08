import { compact, MappingError, parse, type JsonObject } from './json.ts';
import { languageFromWire, languageToWire } from './language.ts';
import type { CommentRecord, PostRecord } from './records.ts';
import { isPublic, PUBLIC } from './vocabulary.ts';
import { many, refId, webUrl, WireNote, WirePage } from './wire.ts';

const date = (value: string | undefined) => (value === undefined ? null : new Date(value));
const markdown = (source: { content: string; mediaType: string } | null | undefined) =>
  source?.mediaType === 'text/markdown' ? source.content : null;

/** The author: Lemmy sends one IRI; PeerTube-style peers send Person and Group objects, the Person first. */
function author(attributedTo: WirePage['attributedTo']): string {
  const refs = many(attributedTo);
  const person = refs.find((ref) => typeof ref !== 'string' && 'type' in ref && ref.type === 'Person') ?? refs[0];
  if (person === undefined) throw new MappingError('attributedTo is empty');
  return refId(person);
}

/**
 * The community a post or comment belongs to: `audience` (Lemmy, PieFed, Mbin), else the first
 * address in `to` and `cc` that is neither Public, a followers collection nor the author.
 */
export function communityOf(object: { audience?: string | null; to?: unknown; cc?: unknown }, authorApId: string): string | null {
  if (object.audience) return object.audience;
  const addresses = [...many(object.to), ...many(object.cc)].filter((value): value is string => typeof value === 'string');
  return addresses.find((address) => !isPublic(address) && address !== authorApId && !address.endsWith('/followers')) ?? null;
}

/**
 * Page (or Article, Video) to a posts row. The link of a link post is the first Link (or Image)
 * attachment, as Lemmy reads it; a link that is not http(s) (javascript:, data:, file:) maps to
 * no link, so the post still arrives.
 */
export function postFromPage(json: unknown): PostRecord {
  const page = parse(WirePage, json, 'Page');
  const authorApId = author(page.attributedTo);
  const communityApId = communityOf(page, authorApId);
  if (communityApId === null) throw new MappingError(`Page ${page.id} names no community`);
  const link = page.attachment?.find((attachment) => attachment.type === 'Link' || attachment.type === 'Image');
  return {
    apId: page.id,
    authorApId,
    communityApId,
    title: page.name,
    url: webUrl(link?.href ?? link?.url),
    bodyMd: markdown(page.source),
    contentHtml: page.content ?? null,
    language: languageFromWire(page.language, page.contentMap),
    sensitive: page.sensitive ?? false,
    locked: page.commentsEnabled === undefined ? null : !page.commentsEnabled,
    featuredCommunity: page.stickied ?? null,
    publishedAt: date(page.published),
    editedAt: date(page.updated),
    raw: json,
  };
}

/** A posts row to its Page, with the Lemmy vocabulary peblish always sends (README.md). */
export function postToPage(post: PostRecord): JsonObject {
  return compact({
    type: 'Page',
    id: post.apId,
    attributedTo: post.authorApId,
    to: [post.communityApId, PUBLIC],
    name: post.title,
    cc: [],
    content: post.contentHtml ?? undefined,
    mediaType: 'text/html',
    source: post.bodyMd === null ? undefined : { content: post.bodyMd, mediaType: 'text/markdown' },
    attachment: post.url === null ? [] : [{ href: post.url, type: 'Link' }],
    sensitive: post.sensitive,
    commentsEnabled: !(post.locked ?? false),
    stickied: post.featuredCommunity ?? false,
    language: languageToWire(post.language),
    published: post.publishedAt?.toISOString(),
    updated: post.editedAt?.toISOString(),
    audience: post.communityApId,
  });
}

/** Note to a comments row. A Note that replies to nothing (a microblog post) is not a comment. */
export function commentFromNote(json: unknown): CommentRecord {
  const note = parse(WireNote, json, 'Note');
  const authorApId = author(note.attributedTo);
  return {
    apId: note.id,
    authorApId,
    inReplyToApId: note.inReplyTo,
    communityApId: communityOf(note, authorApId),
    bodyMd: markdown(note.source),
    contentHtml: note.content ?? null,
    language: languageFromWire(note.language, note.contentMap),
    distinguished: note.distinguished ?? false,
    publishedAt: date(note.published),
    editedAt: date(note.updated),
    raw: json,
  };
}

export function commentToNote(comment: CommentRecord): JsonObject {
  return compact({
    type: 'Note',
    id: comment.apId,
    attributedTo: comment.authorApId,
    to: [PUBLIC],
    cc: comment.communityApId === null ? [] : [comment.communityApId],
    content: comment.contentHtml ?? undefined,
    inReplyTo: comment.inReplyToApId,
    mediaType: 'text/html',
    source: comment.bodyMd === null ? undefined : { content: comment.bodyMd, mediaType: 'text/markdown' },
    language: languageToWire(comment.language),
    published: comment.publishedAt?.toISOString(),
    updated: comment.editedAt?.toISOString(),
    distinguished: comment.distinguished,
    audience: comment.communityApId ?? undefined,
    attachment: [],
  });
}
