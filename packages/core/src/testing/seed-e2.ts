import type { OutboxEvent } from '@peblish/schema/events';
import { asc, eq, sql } from 'drizzle-orm';
import { consumer } from '../notifications/consumer.ts';
import { db } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { notifications } from '../notifications/tables.ts';
import { ensureCursors, processBatch } from '../outbox/worker.ts';
import { seedPostWorld } from './seed-b1.ts';
import { seedActor } from './seed.ts';
import { tx } from '../tx/tx.ts';
import type { NotificationKind } from '../notifications/view.ts';

// Lane E2's seeds: the notifications consumer run for real, the notices it wrote, and what
// e2e/notifications runs against. Test code only. The people and communities come from
// seedPostWorld (seed-b1.ts); this adds nothing to them but the helpers below.

/**
 * seedPostWorld's cast plus the local instance actor the consumer acts as (people: author,
 * reader, moderator, owner, admin, banned and remoteAuthor; communities: open, restricted,
 * removed, remote), so `systemPrincipal` works.
 */
export async function seedInboxWorld() {
  const world = await seedPostWorld();
  await seedActor(world.instances.local, 'Application', 'feddit.test');
  return world;
}

/** Emits an event as the transaction that caused it would have, for a test that seeds rows directly. */
export const emitEvent = (event: OutboxEvent) => tx((t) => t.emit(event));

/**
 * Runs the notifications consumer over the outbox until its cursor has passed every event,
 * through the real processBatch (its cursor and transaction included). The horizon lags: it is
 * the oldest transaction running anywhere on the server, so on a busy machine a batch can move
 * nothing while events wait. This waits for the cursor, not for a quiet batch.
 */
export async function drainNotices(): Promise<void> {
  await ensureCursors([consumer]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await processBatch(consumer);
    const [waiting] = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from outbox o, outbox_cursors c
        where c.consumer = ${consumer.name} and (o.tx_id, o.id) > (c.tx_id, c.event_id)`,
    );
    if (waiting?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the notifications consumer did not catch up');
}

/** A person's notices, oldest first. */
export const noticesOf = (recipientId: string) =>
  db().select().from(notifications).where(eq(notifications.recipientId, recipientId)).orderBy(asc(notifications.id));

/** The kinds a person holds, in order, for compact assertions. */
export async function kindsOf(recipientId: string): Promise<NotificationKind[]> {
  return (await noticesOf(recipientId)).map((row) => row.kind);
}

export const noticeCount = async () =>
  (
    await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
  )[0]!.n;

/** True when the outbox row of `type` was written by the same transaction that wrote notice `id` (xmin matches tx_id). */
export async function sameTransactionAsNotice(id: string, type: string): Promise<boolean> {
  const [row] = await db().execute<{ same: boolean }>(
    sql`select exists (
      select 1 from outbox o, notifications r
      where r.id = ${id} and o.type = ${type} and (o.tx_id::text::numeric % 4294967296)::text = r.xmin::text
    ) as same`,
  );
  return row?.same === true;
}

/** Writes a notice directly, for read-model and mark tests that need rows without events. */
export async function seedNotice(row: typeof notifications.$inferInsert) {
  const [created] = await writer().insert(notifications).values(row).returning();
  return created!;
}

/**
 * A modlog row, by default a site ban by `moderator` (the ban lane's mutation does not exist
 * yet), so an event or a notice can name a real one. A moderator on another instance gives an
 * entry whose reason is withheld unless that instance is trusted.
 */
export async function seedModlog(
  moderator: { id: string; apId: string },
  target: { id: string; apId: string },
  extra: Partial<typeof modlog.$inferInsert> = {},
) {
  const [row] = await writer()
    .insert(modlog)
    .values({
      action: 'ban.site',
      actorId: moderator.id,
      actorApId: moderator.apId,
      targetActorId: target.id,
      targetApId: target.apId,
      reason: 'Spam',
      authority: { kind: 'site-admin', actorId: moderator.id },
      ...extra,
    })
    .returning();
  return row!;
}
