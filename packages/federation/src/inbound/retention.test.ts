import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { truncateAll } from '@peblish/core/testing/db';
import { seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { forgetKeyRefreshes } from '../signing/inbound.ts';
import { signDelivery } from '../signing/sign.ts';
import { processPending } from './job.ts';
import { keptPrefixBytes, maxErrorLength } from './queue.ts';
import { maxActivityTypeLength, maxBodyBytes, receiveInbound } from './receive.ts';
import { intakeByteBudget, resetKeyFetchBudget, takeIntakeBytes } from './throttle.ts';
import { activityId, addressedToCommunity, hosts } from './test-support.ts';

// F3 (B07): the inbox's byte admission counts what it keeps, not only what waits. A peer could
// send unique bodies near 512 KiB of a type peblish does not read: each was skipped at once, so
// the pending limit never saw it, and its body stayed 14 days. Now a body rejected or skipped
// for good keeps only its first KiB, and each instance, and everyone, has an hour's byte budget.

const inbox = 'https://fed-b.test/inbox';
let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetKeyRefreshes();
  world = await seedInboundWorld();
});

const signed = async (body: string, keys = world.peers.lemmyuser.keys) =>
  new Request(inbox, { method: 'POST', headers: await signDelivery(keys, inbox, body), body });
/** A body just under the limit: `json` padded with a field the mapping ignores. */
const large = (json: Record<string, unknown>) => {
  const bare = JSON.stringify({ ...json, padding: '' });
  return JSON.stringify({ ...json, padding: 'x'.repeat(maxBodyBytes - 64 - bare.length) });
};
const kept = async () =>
  db()
    .select({
      type: inboxRaw.activityType,
      state: inboxRaw.state,
      error: inboxRaw.error,
      bytes: sql<number>`octet_length(${inboxRaw.body})`,
    })
    .from(inboxRaw)
    .orderBy(inboxRaw.activityType, inboxRaw.state);
const like = (object: string) => ({
  id: activityId('https://lemmy.test', 'like'),
  type: 'Like',
  actor: hosts.lemmyuser,
  object,
  ...addressedToCommunity(hosts.spike),
});

describe('what the inbox keeps of a body', () => {
  test('a body skipped or failed for good keeps its first KiB; an applied one, or one waiting for an object, keeps all of it', async () => {
    const unread = large({ id: activityId('https://lemmy.test', 'move'), type: 'Move', actor: hosts.lemmyuser, object: hosts.lemmyuser });
    const malformed = large({
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: hosts.lemmyuser,
      object: 'https://lemmy.test/post/77',
    });
    const waiting = large(like('https://lemmy.test/post/unseen'));
    const applied = large(like(hosts.t1));
    for (const body of [unread, malformed, waiting, applied]) expect((await receiveInbound(await signed(body))).status).toBe(202);
    await processPending();
    const size = (body: string) => new TextEncoder().encode(body).byteLength;
    expect(await kept()).toEqual([
      { type: 'Create', state: 'failed', error: expect.any(String), bytes: keptPrefixBytes },
      { type: 'Like', state: 'applied', error: null, bytes: size(applied) },
      { type: 'Like', state: 'skipped', error: 'target.missing https://lemmy.test/post/unseen', bytes: size(waiting) },
      { type: 'Move', state: 'skipped', error: 'type.unhandled Move', bytes: keptPrefixBytes },
    ]);
  });
});

describe('the hour’s byte budget', () => {
  test('an instance that stored its hour’s bytes is answered 429 with Retry-After, and another instance is not', async () => {
    takeIntakeBytes('https://lemmy.test/u/someone-else', intakeByteBudget.perInstance - 100);
    const refused = await receiveInbound(await signed(JSON.stringify(like(hosts.t1))));
    expect([refused.status, refused.headers.get('retry-after')]).toEqual([429, '300']);
    const elsewhere = { ...like(hosts.t1), id: activityId('https://rogue.test', 'like'), actor: hosts.mallory };
    expect((await receiveInbound(await signed(JSON.stringify(elsewhere), world.peers.mallory.keys))).status).toBe(202);
    expect((await db().select().from(inboxRaw).where(eq(inboxRaw.actorApId, hosts.lemmyuser))).length).toBe(0);
  });

  test('once every instance together stored the hour’s total, everyone is answered 429', async () => {
    const instances = Math.ceil(intakeByteBudget.total / intakeByteBudget.perInstance);
    for (let n = 0; n < instances; n++) takeIntakeBytes(`https://peer${n}.test/u/a`, intakeByteBudget.perInstance);
    expect((await receiveInbound(await signed(JSON.stringify(like(hosts.t1))))).status).toBe(429);
    expect(await db().select().from(inboxRaw)).toEqual([]);
  });

  test('a repeat that is not stored costs none of the budget', async () => {
    const body = JSON.stringify(like(hosts.t1));
    expect((await receiveInbound(await signed(body))).status).toBe(202);
    const size = new TextEncoder().encode(body).byteLength;
    // Room for exactly one more body of this size: the repeats below must not spend it.
    takeIntakeBytes('https://lemmy.test/u/someone-else', intakeByteBudget.perInstance - 2 * size);
    for (let n = 0; n < 3; n++) expect((await receiveInbound(await signed(body))).status).toBe(202);
    expect((await receiveInbound(await signed(JSON.stringify(like(hosts.t1))))).status).toBe(202);
    expect(await db().select().from(inboxRaw)).toHaveLength(2);
  });
});

// FN3 (review 2): a rejected body was cut to its first KiB, but what it said survived the cut in
// two other columns: `activity_type` (the top-level type, stored whole) and the recorded error
// (`type.unhandled <type>`, `object.unsupported <type>`), so a type of about 500 KiB was kept
// twice. The type is bounded at the door and the error of a settled row is bounded, except a
// `target.missing` one, whose ids the requeue matches whole.
describe('what the inbox keeps of a rejected body outside the body', () => {
  const huge = 'X'.repeat(300_000);

  test('an activity whose type is longer than the limit is refused at the door, and nothing is stored', async () => {
    const body = JSON.stringify({ id: activityId('https://lemmy.test', 'huge'), type: huge, actor: hosts.lemmyuser, object: hosts.t1 });
    const response = await receiveInbound(await signed(body));
    expect([response.status, await response.text()]).toEqual([400, 'the activity type is too long']);
    expect(await db().select().from(inboxRaw)).toEqual([]);

    // A type at the limit is taken, and skipped as a type peblish does not read.
    const longest = 'Y'.repeat(maxActivityTypeLength);
    const atLimit = JSON.stringify({
      id: activityId('https://lemmy.test', 'long'),
      type: longest,
      actor: hosts.lemmyuser,
      object: hosts.t1,
    });
    expect((await receiveInbound(await signed(atLimit))).status).toBe(202);
    await processPending();
    expect(await kept()).toEqual([{ type: longest, state: 'skipped', error: `type.unhandled ${longest}`, bytes: expect.any(Number) }]);
  });

  test('the error of a row settled for good is bounded, and a target.missing error keeps every id whole', async () => {
    const create = JSON.stringify({
      id: activityId('https://lemmy.test', 'create'),
      type: 'Create',
      actor: hosts.lemmyuser,
      ...addressedToCommunity(hosts.spike),
      object: { id: 'https://lemmy.test/post/huge', type: huge, attributedTo: hosts.lemmyuser },
    });
    const unseen = `https://lemmy.test/post/${'z'.repeat(2 * maxErrorLength)}`;
    for (const body of [create, JSON.stringify(like(unseen))]) expect((await receiveInbound(await signed(body))).status).toBe(202);
    await processPending();
    const [skipped, waiting] = await kept();
    expect(skipped).toMatchObject({ type: 'Create', state: 'skipped', bytes: keptPrefixBytes });
    expect(skipped?.error?.length).toBeLessThanOrEqual(maxErrorLength);
    expect(skipped?.error?.startsWith('object.unsupported XXX')).toBe(true);
    expect(waiting).toMatchObject({ type: 'Like', state: 'skipped', error: `target.missing ${unseen}` });
  });
});
