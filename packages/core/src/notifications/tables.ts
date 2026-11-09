import { sql } from 'drizzle-orm';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { modlog } from '../db/tables/moderation.ts';
import { notificationKinds } from './view.ts';

/**
 * A person's inbox. One row per cause: ref_id is the comment, post or modlog row that
 * triggered it, so a replayed event or a repeated edit adds nothing (the unique index). The
 * context ids are plain links for rendering and go null when their row is purged. uuidv7 ids
 * are in creation order, so the list pages by id and (recipient_id, id desc) serves it; the
 * partial index keeps the unread count to the unread rows however large the table grows.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: notificationKinds }).notNull(),
    refId: uuid('ref_id').notNull(),
    actorId: uuid('actor_id').references(() => actors.id, { onDelete: 'set null' }),
    communityId: uuid('community_id').references(() => actors.id, { onDelete: 'set null' }),
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'set null' }),
    modlogId: uuid('modlog_id').references(() => modlog.id, { onDelete: 'set null' }),
    readAt: at('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('notifications_kind', t.kind, notificationKinds),
    uniqueIndex('notifications_recipient_ref').on(t.recipientId, t.refId),
    index('notifications_recipient_id').on(t.recipientId, t.id.desc()),
    index('notifications_unread')
      .on(t.recipientId)
      .where(sql`${t.readAt} is null`),
  ],
);
