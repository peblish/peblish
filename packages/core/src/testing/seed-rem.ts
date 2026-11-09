import { uuidv7 } from 'uuidv7';
import { inboxRaw } from '../db/tables/federation.ts';
import { writer } from '../db/write.ts';
import { deliveries } from '../delivery/tables.ts';

// Lane REM's seeds: rows in the queue tables at chosen times, for the dormancy and retention
// tests. Test code only.

const day = 24 * 60 * 60 * 1000;
export const daysAgo = (days: number, from = new Date()) => new Date(from.getTime() - days * day);

/** One delivery to `instance`, in the state and at the times `extra` says (by default a failed one from 8 days ago). */
export async function seedDelivery(
  instance: { id: string; domain: string },
  sender: { id: string },
  extra: Partial<typeof deliveries.$inferInsert> = {},
) {
  const id = uuidv7();
  const createdAt = extra.createdAt ?? daysAgo(8);
  const state = extra.state ?? 'failed';
  const [row] = await writer()
    .insert(deliveries)
    .values({
      id,
      activityApId: `https://rem.test/activities/${id}`,
      activityType: 'Create',
      senderId: sender.id,
      inboxUrl: `https://${instance.domain}/inbox`,
      instanceId: instance.id,
      body: '{}',
      state,
      attempts: 1,
      createdAt,
      settledAt: state === 'pending' ? null : createdAt,
      ...extra,
    })
    .returning();
  return row!;
}

/** An inbox row from `actor`, received at `receivedAt` and, unless pending, processed then. */
export async function seedInbound(actor: { apId: string }, receivedAt: Date, extra: Partial<typeof inboxRaw.$inferInsert> = {}) {
  const state = extra.state ?? 'applied';
  const [row] = await writer()
    .insert(inboxRaw)
    .values({
      id: uuidv7(),
      activityId: `${actor.apId}/activities/${uuidv7()}`,
      activityType: 'Like',
      actorApId: actor.apId,
      body: new TextEncoder().encode('{}'),
      state,
      receivedAt,
      processedAt: state === 'pending' ? null : receivedAt,
      ...extra,
    })
    .returning();
  return row!;
}
