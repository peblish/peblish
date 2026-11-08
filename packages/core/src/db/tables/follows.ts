import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, enumCheck, id } from '../columns.ts';
import { actors } from './actors.ts';

const stateValues = ['pending', 'accepted'] as const;

/**
 * Follow relations in both directions: followers of a local actor are the rows whose
 * followee is local; what a local actor follows are the rows whose follower is local.
 * One table instead of followers plus following, so a local-to-local follow is one row.
 */
export const follows = pgTable(
  'follows',
  {
    id: id(),
    followerId: uuid('follower_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    followeeId: uuid('followee_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    /** The Follow activity id, matched by Accept and Undo. */
    apId: text('ap_id').unique(),
    state: text('state', { enum: stateValues }).notNull().default('pending'),
    /** Last time an unanswered Follow was (re)sent; the first-contact retry rule reads it. */
    sentAt: at('sent_at'),
    acceptedAt: at('accepted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('follows_state', t.state, stateValues),
    uniqueIndex('follows_pair').on(t.followerId, t.followeeId),
    index('follows_followee').on(t.followeeId, t.state),
  ],
);
