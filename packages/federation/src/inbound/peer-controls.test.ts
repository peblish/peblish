import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { instances } from '@peblish/core/db/tables/instances';
import { writer } from '@peblish/core/db/write';
import { peerControls } from '@peblish/core/peers/tables';
import { truncateAll } from '@peblish/core/testing/db';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { forgetKeyRefreshes } from '../signing/inbound.ts';
import { signDelivery } from '../signing/sign.ts';
import { processRow } from './pipeline.ts';
import { receiveInbound } from './receive.ts';
import { activityId, addressedToCommunity, hosts } from './test-support.ts';
import { resetKeyFetchBudget } from './throttle.ts';

// M18: what the inbox does for a peer the admin paused or blocked (peers/gate.ts).

const inbox = 'https://fed-b.test/inbox';
let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetKeyRefreshes();
  world = await seedInboundWorld();
});

const like = () => ({
  id: activityId('https://lemmy.test', 'like'),
  type: 'Like',
  actor: hosts.lemmyuser,
  object: hosts.t1,
  ...addressedToCommunity(hosts.spike),
});
const control = (values: Partial<typeof peerControls.$inferInsert>) =>
  writer()
    .insert(peerControls)
    .values({ instanceId: world.instances.lemmy.id, ...values })
    .onConflictDoUpdate({ target: peerControls.instanceId, set: values });
const post = async (json: object) => {
  const body = JSON.stringify(json);
  return receiveInbound(new Request(inbox, { method: 'POST', headers: await signDelivery(world.peers.lemmyuser.keys, inbox, body), body }));
};

describe('the inbox', () => {
  test('a paused inbox answers 503 with Retry-After and stores nothing; once resumed the same activity is taken', async () => {
    await control({ inboxPaused: true });
    const activity = like();
    const paused = await post(activity);
    expect([paused.status, paused.headers.get('retry-after')]).toEqual([503, '300']);
    expect(await db().select().from(inboxRaw)).toEqual([]);
    await control({ inboxPaused: false });
    expect((await post(activity)).status).toBe(202);
    expect(await db().select().from(inboxRaw)).toHaveLength(1);
  });

  test('a blocked peer is refused with 403 and nothing is stored; another peer is not affected', async () => {
    await control({ blocked: true });
    expect((await post(like())).status).toBe(403);
    expect(await db().select().from(inboxRaw)).toEqual([]);
    await control({ blocked: false });
    expect((await post(like())).status).toBe(202);
  });
});

describe('the pipeline', () => {
  test('an activity taken in before its peer was blocked changes nothing: skipped as peer.blocked', async () => {
    await control({ blocked: true });
    const { stored } = await deliverRow(like(), (row) => processRow(row));
    expect(stored).toMatchObject({ state: 'skipped' });
    expect(stored?.error).toMatch(/^peer\.blocked/);
  });

  test('without a control row the peer’s activity is applied as before', async () => {
    const { stored } = await deliverRow(like(), (row) => processRow(row));
    expect(stored).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(instances).where(eq(instances.id, world.instances.lemmy.id))).toHaveLength(1);
  });
});
