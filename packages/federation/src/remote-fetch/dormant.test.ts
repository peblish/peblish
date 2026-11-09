import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { deliveries } from '@peblish/core/delivery/tables';
import { writer } from '@peblish/core/db/write';
import { dormancy, evaluateInstanceHealth } from '@peblish/core/remote/dormant';
import { instanceHealth } from '@peblish/core/remote/tables';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedLocalInstance, seedSigningKey, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { daysAgo, seedDelivery } from '@peblish/core/testing/seed-rem';
import { enqueueDeliveries } from '../delivery/queue.ts';
import { deliverDue } from '../delivery/run.ts';

// The delivery worker with the real dormancy answer (core/remote/dormant.ts): what a dormant
// instance costs us, and what brings it back.

const inbox = 'https://lemmy.test/inbox';
const quiet = { refreshSoftware: async () => {} };

async function world() {
  const { instance } = await seedLocalInstance('rem.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const community = await seedActor(instance, 'Group', 'news');
  await seedSigningKey(community);
  for (const age of [9, 6, 1]) await seedDelivery(lemmy, community, { state: 'failed', createdAt: daysAgo(age) });
  const send = (n: number) =>
    tx((t) =>
      enqueueDeliveries(t, {
        activityApId: `https://rem.test/ap/activity/${n}`,
        senderId: community.id,
        body: JSON.stringify({ type: 'Announce', id: `https://rem.test/ap/activity/${n}` }),
        inboxes: [inbox],
      }),
    );
  const states = async () => (await db().select().from(deliveries).where(eq(deliveries.state, 'skipped'))).length;
  return { lemmy, community, send, states };
}

beforeEach(truncateAll);

describe('delivery to a dormant instance', () => {
  test('sends nothing, bar one probe a day, and a delivered probe brings the instance back', async () => {
    const w = await world();
    // The job first saw the deliveries failing eight days ago, and has seen them fail since.
    await evaluateInstanceHealth(daysAgo(8));
    expect(await evaluateInstanceHealth()).toEqual({ dormant: 1, revived: 0 });
    const peer = stubFetch({ [inbox]: { status: 202, type: 'text/plain' } });

    await Promise.all([1, 2, 3].map(w.send));
    expect(await deliverDue({ fetch: peer.fetch, ...quiet })).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 3 });
    expect(peer.requests).toHaveLength(0);
    expect(await w.states()).toBe(3);

    // A day on, of four queued deliveries exactly one goes out, and the others are still skipped.
    await writer()
      .update(instanceHealth)
      .set({ dormantSince: daysAgo(2), lastProbeAt: new Date(Date.now() - dormancy.probeEveryMs - 60_000) });
    await Promise.all([4, 5, 6, 7].map(w.send));
    expect(await deliverDue({ fetch: peer.fetch, ...quiet })).toEqual({ delivered: 1, retried: 0, failed: 0, skipped: 3 });
    expect(peer.requests).toHaveLength(1);

    // The health job sees the probe was delivered, and the instance gets all its deliveries again.
    expect(await evaluateInstanceHealth()).toEqual({ dormant: 0, revived: 1 });
    await send8(w);
    expect(await deliverDue({ fetch: peer.fetch, ...quiet })).toEqual({ delivered: 1, retried: 0, failed: 0, skipped: 0 });
  });
});

const send8 = (w: Awaited<ReturnType<typeof world>>) => w.send(8);
