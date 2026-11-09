import { boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, enumCheck } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';

// Lane MODF's table; root generates its migration.

const mediaValues = ['quarantined', 'approved', 'denied'] as const;

/**
 * What this server does about one peer. A peer with no row is new: its text is taken, its media
 * is quarantined (the same as `media = 'quarantined'`). `denied` is a purge: the media stays off
 * and purged_at says when. No authz policy reads this table, so the gates in peers/gate.ts read
 * it plain.
 */
export const peerControls = pgTable(
  'peer_controls',
  {
    instanceId: uuid('instance_id')
      .primaryKey()
      .references(() => instances.id, { onDelete: 'cascade' }),
    media: text('media', { enum: mediaValues }).notNull().default('quarantined'),
    /** The inbox answers 503 so the peer retries; nothing is lost. */
    inboxPaused: boolean('inbox_paused').notNull().default(false),
    /** Intake, delivery, media and feeds all stop for the peer. */
    blocked: boolean('blocked').notNull().default(false),
    reason: text('reason'),
    purgedAt: at('purged_at'),
    changedBy: uuid('changed_by').references(() => actors.id, { onDelete: 'set null' }),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [enumCheck('peer_controls_media', t.media, mediaValues)],
);
