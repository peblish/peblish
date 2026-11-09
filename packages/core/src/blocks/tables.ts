import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from '../db/columns.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';

// What a local person has blocked (S02). The blocker is always a local account; nothing here
// is sent to the blocked person, community or instance. Rows go with the actor or instance.

/** People a person has blocked. The pair is the key; nobody blocks themselves. */
export const personBlocks = pgTable(
  'person_blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    check('person_blocks_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
    index('person_blocks_blocked').on(t.blockedId),
  ],
);

/** Communities (Group actors) a person has blocked. */
export const communityBlocks = pgTable(
  'community_blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    communityId: uuid('community_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.communityId] }), index('community_blocks_community').on(t.communityId)],
);

/** Instances a person has blocked: every person and community that lives there. */
export const instanceBlocks = pgTable(
  'instance_blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.instanceId] }), index('instance_blocks_instance').on(t.instanceId)],
);
