import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id, raw } from '../columns.ts';
import { authUser } from './auth.ts';
import { instances } from './instances.ts';

const kindValues = ['Person', 'Group', 'Application', 'Service'] as const;
const algorithmValues = ['rsa', 'ed25519'] as const;

/**
 * One table for every actor kind: Person, Group (communities are Group attributes here),
 * Application (the instance actor) and Service. Names of local actors are unique across
 * kinds, case-insensitively; new local actors match [A-Za-z0-9_]{1,50}, while imported ones
 * (imported_at set, such as feddit-admin) keep theirs. ap_id, local and instance_id never
 * change (trigger in migration 0001).
 */
export const actors = pgTable(
  'actors',
  {
    id: id(),
    apId: text('ap_id').notNull().unique(),
    kind: text('kind', { enum: kindValues }).notNull(),
    local: boolean('local').notNull(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id),
    raw: raw(),
    name: text('name').notNull(),
    displayName: text('display_name'),
    summaryHtml: text('summary_html'),
    /** Markdown source of a local actor's summary. */
    summaryMd: text('summary_md'),
    inboxUrl: text('inbox_url'),
    sharedInboxUrl: text('shared_inbox_url'),
    outboxUrl: text('outbox_url'),
    followersUrl: text('followers_url'),
    featuredUrl: text('featured_url'),
    /** Group only: the moderators collection the community publishes. */
    moderatorsUrl: text('moderators_url'),
    iconUrl: text('icon_url'),
    bannerUrl: text('banner_url'),
    sensitive: boolean('sensitive').notNull().default(false),
    bot: boolean('bot').notNull().default(false),
    /** Group only: only moderators may post (lane F). */
    postingRestrictedToMods: boolean('posting_restricted_to_mods').notNull().default(false),
    /** Local Person only: the better-auth account. Kept as a tombstone when the account goes. */
    userId: uuid('user_id')
      .unique()
      .references(() => authUser.id, { onDelete: 'set null' }),
    /** Set on actors carried over from PieFed at cutover; they keep their names and URLs. */
    importedAt: at('imported_at'),
    publishedAt: at('published_at'),
    updatedAt: at('updated_at'),
    fetchedAt: at('fetched_at'),
    deletedAt: at('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('actors_local_name_unique')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.local}`),
    index('actors_instance_name').on(t.instanceId, sql`lower(${t.name})`),
    check('actors_local_name_chars', sql`not ${t.local} or ${t.importedAt} is not null or ${t.name} ~ '^[A-Za-z0-9_]{1,50}$'`),
    enumCheck('actors_kind', t.kind, kindValues),
    check('actors_user_is_local_person', sql`${t.userId} is null or (${t.local} and ${t.kind} = 'Person')`),
  ],
);

/** Signing keys. Local actors hold the private key (PKCS#8 PEM); remote ones only the public key. */
export const actorKeys = pgTable(
  'actor_keys',
  {
    id: id(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    /** The key's IRI, such as <ap_id>#main-key. */
    keyId: text('key_id').notNull().unique(),
    algorithm: text('algorithm', { enum: algorithmValues }).notNull(),
    publicKeyPem: text('public_key_pem').notNull(),
    privateKeyPem: text('private_key_pem'),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('actor_keys_algorithm', t.algorithm, algorithmValues),
    uniqueIndex('actor_keys_one_per_algorithm').on(t.actorId, t.algorithm),
  ],
);
