import { sql } from 'drizzle-orm';
import { inboxRaw } from '../db/tables/federation.ts';
import { deliveries } from '../delivery/tables.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane REM. Retention for the two queue tables that otherwise grow for ever: the inbox
// (every activity as received, bodies up to 512 KiB) and the delivery queue (every send).

/** How long a settled row is kept, and how a prune run is cut into transactions. */
export const retention = {
  /** An inbox row that is applied, skipped or failed. A pending row is never deleted. */
  inboxRawMs: 14 * 24 * 60 * 60 * 1000,
  /** A delivery that is delivered, failed or skipped. The health job reads the last week only. */
  deliveriesMs: 30 * 24 * 60 * 60 * 1000,
  /** Rows deleted per transaction, and transactions per run (a larger backlog finishes on the next run). */
  batch: 2000,
  maxBatches: 25,
} as const;

/**
 * Deletes up to one batch of settled rows older than the grant's table keeps. An applied
 * activity's `activities` row stays and loses its link to the deleted bytes (ON DELETE SET
 * NULL), so the relay falls back to the parsed copy. Returns how many rows went.
 */
export const pruneBatch = defineMutation({
  action: 'remote.prune',
  emits: ['remote.pruned'],
  async run(t, grant, input: { now: Date }) {
    const { table } = grant.subject;
    const keep = table === 'inbox_raw' ? retention.inboxRawMs : retention.deliveriesMs;
    const cutoff = new Date(input.now.getTime() - keep).toISOString();
    const gone =
      table === 'inbox_raw'
        ? await t.db.execute<{ id: string }>(sql`
            delete from ${inboxRaw} where id in (
              select id from ${inboxRaw}
              where state <> 'pending' and processed_at < ${cutoff}::timestamptz
              limit ${retention.batch})
            returning id`)
        : await t.db.execute<{ id: string }>(sql`
            delete from ${deliveries} where id in (
              select id from ${deliveries}
              where state <> 'pending' and settled_at < ${cutoff}::timestamptz
              limit ${retention.batch})
            returning id`);
    if (gone.length > 0) await t.emit({ type: 'remote.pruned', v: 1, table, rows: gone.length });
    return { rows: gone.length };
  },
});
