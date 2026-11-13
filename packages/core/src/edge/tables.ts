import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt } from '../db/columns.ts';

/**
 * Purges owed to Cloudflare's edge cache (edge/debt.ts): one row per cache tag and send. Every
 * purge is sent twice: send 1 as soon as the rate allows, send 2 (the echo) `ECHO_MS` after send
 * 1 succeeded, for answers decided just before the takedown and stored after it (edge/timing.ts).
 * A row a sender has claimed carries its token and lease; a row nobody holds is unique by tag
 * and send, so owing a tag twice before it is sent is one row. Rows are deleted once sent.
 */
export const edgePurges = pgTable(
  'edge_purges',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tag: text('tag').notNull(),
    send: smallint('send').notNull().default(1),
    dueAt: at('due_at').notNull().defaultNow(),
    claimToken: uuid('claim_token'),
    leaseUntil: at('lease_until'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('edge_purges_owed')
      .on(t.tag, t.send)
      .where(sql`${t.claimToken} is null`),
    index('edge_purges_due').on(t.dueAt),
  ],
);

/**
 * Whether the worker's purge path works, as web reads it before answering public (edge/ready.ts).
 * One row, `cloudflare`, every time in it the database's. `verified_at` is the last authenticated
 * Cloudflare call that succeeded (a purge, or the idle check), for the zone in `zone_id`;
 * `sent_at` is when the last request was let out, which spaces requests across every worker;
 * `claim_token` and `lease_until` name the one batch in flight; `retry_at` holds requests back
 * after a failure.
 */
export const edgeStatus = pgTable('edge_status', {
  name: text('name').primaryKey(),
  zoneId: text('zone_id'),
  verifiedAt: at('verified_at'),
  sentAt: at('sent_at'),
  claimToken: uuid('claim_token'),
  leaseUntil: at('lease_until'),
  retryAt: at('retry_at'),
  failures: integer('failures').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
