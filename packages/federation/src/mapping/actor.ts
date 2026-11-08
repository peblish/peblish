import { compact, parse, type JsonObject } from './json.ts';
import type { ActorRecord, ModeratorsRecord } from './records.ts';
import { WireActor, WireModerators } from './wire.ts';

const date = (value: string | undefined) => (value === undefined ? null : new Date(value));
const markdown = (source: { content: string; mediaType: string } | null | undefined) =>
  source?.mediaType === 'text/markdown' ? source.content : null;

/** Person, Group, Application or Service document to an actors row (Group is a community). */
export function actorFromWire(json: unknown): ActorRecord {
  const actor = parse(WireActor, json, 'actor');
  return {
    apId: actor.id,
    kind: actor.type,
    name: actor.preferredUsername,
    displayName: actor.name ?? null,
    summaryHtml: actor.summary ?? null,
    summaryMd: markdown(actor.source),
    inboxUrl: actor.inbox,
    sharedInboxUrl: actor.endpoints?.sharedInbox ?? null,
    outboxUrl: actor.outbox ?? null,
    followersUrl: actor.followers ?? null,
    featuredUrl: actor.featured ?? null,
    moderatorsUrl: actor.type === 'Group' ? (actor.attributedTo ?? actor.moderators ?? null) : null,
    iconUrl: actor.icon?.url ?? null,
    bannerUrl: actor.image?.url ?? null,
    sensitive: actor.sensitive ?? false,
    bot: actor.type === 'Service',
    postingRestrictedToMods: actor.postingRestrictedToMods ?? false,
    publishedAt: date(actor.published),
    updatedAt: date(actor.updated),
    publicKey: actor.publicKey ? { keyId: actor.publicKey.id, pem: actor.publicKey.publicKeyPem } : null,
    raw: json,
  };
}

/**
 * An actors row to its document, in Lemmy's shape: a Group names its moderators collection in
 * `attributedTo`, carries `sensitive`, `postingRestrictedToMods` and `language`, and every
 * actor has `endpoints.sharedInbox` and its `publicKey`.
 */
export function actorToWire(actor: ActorRecord): JsonObject {
  const group = actor.kind === 'Group';
  const image = (url: string | null) => (url === null ? undefined : { type: 'Image', url });
  return compact({
    type: actor.kind,
    id: actor.apId,
    preferredUsername: actor.name,
    inbox: actor.inboxUrl ?? undefined,
    outbox: actor.outboxUrl ?? undefined,
    followers: actor.followersUrl ?? undefined,
    publicKey: actor.publicKey ? { id: actor.publicKey.keyId, owner: actor.apId, publicKeyPem: actor.publicKey.pem } : undefined,
    name: actor.displayName ?? undefined,
    summary: actor.summaryHtml ?? undefined,
    source: actor.summaryMd === null ? undefined : { content: actor.summaryMd, mediaType: 'text/markdown' },
    icon: image(actor.iconUrl),
    image: image(actor.bannerUrl),
    sensitive: group ? actor.sensitive : undefined,
    attributedTo: group ? (actor.moderatorsUrl ?? undefined) : undefined,
    postingRestrictedToMods: group ? actor.postingRestrictedToMods : undefined,
    featured: actor.featuredUrl ?? undefined,
    endpoints: actor.sharedInboxUrl === null ? undefined : { sharedInbox: actor.sharedInboxUrl },
    language: group ? [] : undefined,
    published: actor.publishedAt?.toISOString(),
    updated: actor.updatedAt?.toISOString(),
  });
}

export function moderatorsFromWire(json: unknown): ModeratorsRecord {
  const collection = parse(WireModerators, json, 'moderators');
  return { apId: collection.id, moderatorApIds: collection.orderedItems };
}

/** Lemmy's shape: no totalItems. */
export function moderatorsToWire(moderators: ModeratorsRecord): JsonObject {
  return { type: 'OrderedCollection', id: moderators.apId, orderedItems: moderators.moderatorApIds };
}
