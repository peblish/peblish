import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id, raw } from '../columns.ts';
import { actors } from './actors.ts';
import { comments, posts } from './content.ts';
import { instances } from './instances.ts';

const roleValues = ['owner', 'moderator'] as const;
const sourceValues = ['local', 'remote'] as const;
const statusValues = ['open', 'resolved', 'dismissed'] as const;

/**
 * Moderators of a community. source 'local' rows are assigned here; 'remote' rows mirror the
 * moderators collection a remote community publishes and expire (bounded cache, lane AZ).
 */
export const communityModerators = pgTable(
  'community_moderators',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    moderatorId: uuid('moderator_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    role: text('role', { enum: roleValues }).notNull().default('moderator'),
    source: text('source', { enum: sourceValues }).notNull(),
    /** When the origin last confirmed this row (remote), or when it was assigned (local). */
    verifiedAt: at('verified_at'),
    /** Remote rows are stale after this and must be refetched before they grant anything. */
    expiresAt: at('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.communityId, t.moderatorId] }),
    enumCheck('community_moderators_role', t.role, roleValues),
    enumCheck('community_moderators_source', t.source, sourceValues),
    index('community_moderators_moderator').on(t.moderatorId),
  ],
);

/**
 * Immutable moderation log: updates and deletes are refused by a trigger, except the
 * ON DELETE SET NULL a purge of the referenced actor, community, post or comment performs
 * (a reference may become null only once its row is gone, and never re-point). Every
 * reference carries its ap_id, required by a CHECK whenever the id is set, so the log and
 * each community's history still name everything after a purge.
 */
export const modlog = pgTable(
  'modlog',
  {
    id: id(),
    action: text('action').notNull(),
    /**
     * Who acted: a moderator or admin, or the instance actor for system work. When a remote
     * community's Announce is the authority and the moderator is unknown, actorId is null and
     * actorApId names the announcing community.
     */
    actorId: uuid('actor_id').references(() => actors.id, { onDelete: 'set null' }),
    actorApId: text('actor_ap_id').notNull(),
    communityId: uuid('community_id').references(() => actors.id, { onDelete: 'set null' }),
    communityApId: text('community_ap_id'),
    targetActorId: uuid('target_actor_id').references(() => actors.id, { onDelete: 'set null' }),
    targetPostId: uuid('target_post_id').references(() => posts.id, { onDelete: 'set null' }),
    targetCommentId: uuid('target_comment_id').references(() => comments.id, { onDelete: 'set null' }),
    targetApId: text('target_ap_id'),
    /** Statement of reasons shown to the affected user. */
    reason: text('reason'),
    /** The Authority that granted the action. */
    authority: jsonb('authority').notNull(),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The federated activity that carried or announced the action, when there is one. */
    activityApId: text('activity_ap_id'),
    /** False keeps the row out of the public modlog (sensitive cases); staff still see it. */
    public: boolean('public').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index('modlog_created').on(t.createdAt.desc()),
    index('modlog_community_created').on(t.communityId, t.createdAt.desc()),
    check('modlog_community_ap_id', sql`${t.communityId} is null or ${t.communityApId} is not null`),
    check(
      'modlog_target_ap_id',
      sql`(${t.targetActorId} is null and ${t.targetPostId} is null and ${t.targetCommentId} is null) or ${t.targetApId} is not null`,
    ),
  ],
);

/** Reports (lane REP owns the category set and the flow; schema only in 0001). */
export const reports = pgTable(
  'reports',
  {
    id: id(),
    /** The Flag activity id, for reports that federate. */
    apId: text('ap_id').unique(),
    local: boolean('local').notNull(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id),
    raw: raw(),
    reporterId: uuid('reporter_id').references(() => actors.id),
    communityId: uuid('community_id').references(() => actors.id),
    targetActorId: uuid('target_actor_id'),
    targetPostId: uuid('target_post_id'),
    targetCommentId: uuid('target_comment_id'),
    category: text('category').notNull(),
    reason: text('reason'),
    status: text('status', { enum: statusValues }).notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => actors.id),
    resolvedAt: at('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('reports_status', t.status, statusValues),
    index('reports_open')
      .on(t.createdAt)
      .where(sql`${t.status} = 'open'`),
  ],
);
