import { type } from 'arktype';

// ArkType schemas for the wire objects peers send, covering the fields the mapping reads.
// Undeclared keys pass through untouched (ArkType ignores them); the stored `raw` keeps them.

export const Iri = type('string.url');
/** JSON-LD allows one value or an array; Lemmy sends arrays, Fedify collapses one-element arrays. */
export const Iris = Iri.or(Iri.array());
/** A reference: the IRI itself, or an embedded object that carries it. */
export const Ref = Iri.or({ id: Iri });
export const Timestamp = type('string.date.iso');

export const Source = type({ content: 'string', mediaType: 'string' });
/** Lemmy and PieFed: `{ identifier: 'en', name: 'English' }`. */
export const Language = type({ identifier: 'string', 'name?': 'string' });
export const Image = type({ 'type?': 'string', url: Iri, 'name?': 'string | null' });
export const Attachment = type({ type: 'string', 'href?': Iri, 'url?': Iri, 'name?': 'string | null', 'mediaType?': 'string' });

const addressing = {
  'to?': Iris.or('null'),
  'cc?': Iris.or('null'),
  'audience?': Iri.or('null'),
} as const;

export const WireActor = type({
  type: "'Person' | 'Group' | 'Application' | 'Service'",
  id: Iri,
  preferredUsername: 'string',
  'name?': 'string | null',
  'summary?': 'string | null',
  'source?': Source.or('null'),
  inbox: Iri,
  'outbox?': Iri.or('null'),
  'followers?': Iri.or('null'),
  'featured?': Iri.or('null'),
  /** Lemmy names a Group's moderators collection here. */
  'attributedTo?': Iri.or('null'),
  /** PieFed and Mbin name it here (PieFed sends both). */
  'moderators?': Iri.or('null'),
  'endpoints?': type({ 'sharedInbox?': Iri }).or('null'),
  'publicKey?': { id: Iri, owner: Iri, publicKeyPem: 'string' },
  'icon?': Image.or('null'),
  'image?': Image.or('null'),
  'sensitive?': 'boolean',
  'postingRestrictedToMods?': 'boolean',
  'published?': Timestamp,
  'updated?': Timestamp,
});
export type WireActor = typeof WireActor.infer;

const content = {
  id: Iri,
  /** Lemmy: the author's IRI. PeerTube-style peers send an array of Person and Group objects. */
  attributedTo: Ref.or(Ref.array()),
  'content?': 'string | null',
  'mediaType?': 'string',
  'source?': Source.or('null'),
  'language?': Language.or('null'),
  'contentMap?': 'Record<string, string>',
  'published?': Timestamp,
  'updated?': Timestamp,
  ...addressing,
} as const;

/** A post. Lemmy also reads Article and Video as posts; PieFed polls are Question (not mapped yet). */
export const WirePage = type({
  ...content,
  type: "'Page' | 'Article' | 'Video'",
  name: 'string',
  'attachment?': Attachment.array(),
  'image?': Image.or('null'),
  'sensitive?': 'boolean',
  'commentsEnabled?': 'boolean',
  'stickied?': 'boolean',
});
export type WirePage = typeof WirePage.infer;

/** A comment: a Note that replies to a post or to another comment. */
export const WireNote = type({
  ...content,
  type: "'Note'",
  inReplyTo: Iri,
  'distinguished?': 'boolean',
});
export type WireNote = typeof WireNote.infer;

/** A community's moderators collection (Lemmy, PieFed). */
export const WireModerators = type({
  type: "'OrderedCollection'",
  id: Iri,
  orderedItems: Iri.array(),
  'totalItems?': 'number',
});

/** Every activity type the mapping reads; the object is checked per type. */
export const WireActivity = type({
  type: 'string',
  id: Iri,
  actor: Ref,
  'object?': 'unknown',
  'target?': Ref.or('null'),
  'summary?': 'string | null',
  'content?': 'string | null',
  /** Lemmy's ban flag: also remove the banned user's content. */
  'removeData?': 'boolean | null',
  /** Ban expiry: Lemmy sends `expires`, PieFed sends `expires` and `endTime`. */
  'expires?': Timestamp.or('null'),
  'endTime?': Timestamp.or('null'),
  ...addressing,
});
export type WireActivity = typeof WireActivity.infer;

/** The IRI of a reference. */
export const refId = (ref: typeof Ref.infer): string => (typeof ref === 'string' ? ref : ref.id);

/** One-or-many as an array. */
export const many = <T>(value: T | T[] | null | undefined): T[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
