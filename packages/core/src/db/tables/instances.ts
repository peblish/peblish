import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id } from '../columns.ts';

/** Every server we know of, this one included (exactly one row has local = true). */
export const instances = pgTable(
  'instances',
  {
    id: id(),
    /** Lowercase host, with the port when it is not the default. */
    domain: text('domain').notNull().unique(),
    /** Canonical origin (https://host[:port]); local ap_ids are minted under the local row's. */
    origin: text('origin').notNull(),
    local: boolean('local').notNull().default(false),
    software: text('software'),
    softwareVersion: text('software_version'),
    lastSeenAt: at('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('instances_one_local')
      .on(t.local)
      .where(sql`${t.local}`),
  ],
);
