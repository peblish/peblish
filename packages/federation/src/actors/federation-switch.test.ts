import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { backfills } from '@peblish/core/remote/tables';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { queueBackfill } from '@peblish/core/remote/backfill';
import { forgetDeferredMirrors } from '@peblish/core/remote/moderators';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedSetting } from '@peblish/core/testing/seed-a';
import { rsaKeys, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { seedDelivery } from '@peblish/core/testing/seed-rem';
import { backfillDue } from '../backfill/run.ts';
import { deliveries } from '@peblish/core/delivery/tables';
import { deliverDue } from '../delivery/run.ts';
import { mirrorDue } from '../inbound/moderators/refresh.ts';
import { processRow } from '../inbound/pipeline.ts';
import { receiveInbound } from '../inbound/receive.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId, addressedToCommunity, hosts } from '../inbound/test-support.ts';
import { forgetNodeInfoFailures, nodeInfoFailureCount, refreshInstanceSoftware } from '../nodeinfo/client.ts';
import { fetchMissing } from '../remote-fetch/missing.ts';
import { fetchRemoteObject } from '../remote-fetch/object.ts';
import { polite } from '../remote-fetch/polite.ts';
import { recheckObjects } from '../remote-fetch/recheck.ts';
import { resolveLookup } from '../resolve/web.ts';
import { forgetKeyRefreshes } from '../signing/inbound.ts';
import { signDelivery } from '../signing/sign.ts';
import { fetchJson, type Fetcher } from './document.ts';
import { FederationPaused } from './federation-switch.ts';
import { resolveRemoteActor } from './resolve.ts';

// O1 (the B06 rehearsal): with `delivery.enabled` off no process makes a request to another
// server. Each test takes one path that went out during the rehearsal, or could have, with work
// waiting for it, and checks that the fetcher it was given was never called.

const stranger = 'https://new.test/u/someone';
const day = 24 * 60 * 60 * 1000;

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
let peer: ReturnType<typeof stubFetch>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetKeyRefreshes();
  forgetDeferredMirrors();
  forgetNodeInfoFailures();
  world = await seedInboundWorld();
  peer = stubFetch({});
});
const pause = () => seedSetting('delivery.enabled', false);

describe('with the federation switch off', () => {
  test('delivery sends nothing, so no dormancy probe either (a probe is a delivery)', async () => {
    await seedDelivery(world.instances.lemmy, world.community, { state: 'pending', createdAt: new Date() });
    await pause();
    expect(await deliverDue({ fetch: peer.fetch })).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 0 });
    expect(peer.requests).toEqual([]);
  });

  test('a queued backfill is not claimed, and keeps its attempts', async () => {
    await tx((t) => queueBackfill(t, world.peers.lab.id));
    await pause();
    expect(await backfillDue({ fetch: peer.fetch, gapMs: 0 })).toBe(0);
    expect(peer.requests).toEqual([]);
    const [queued] = await db().select().from(backfills).where(eq(backfills.communityId, world.peers.lab.id));
    expect(queued?.attempts).toBe(0);
  });

  test('the moderators mirror reads no collection', async () => {
    await pause();
    expect(await mirrorDue({ fetch: peer.fetch })).toBe(0);
    expect(peer.requests).toEqual([]);
  });

  test('the missing-object job fetches nothing a skipped activity waits for', async () => {
    const target = 'https://lemmy.test/post/900';
    const dislike = {
      id: activityId('https://lemmy.test', 'dislike'),
      type: 'Dislike',
      actor: hosts.lemmyuser,
      object: target,
      audience: hosts.lab,
    };
    const announce = {
      id: activityId('https://lemmy.test', 'announce'),
      type: 'Announce',
      actor: hosts.lab,
      ...addressedToCommunity(hosts.lab),
      object: dislike,
    };
    expect((await deliverRow(announce, (row) => processRow(row, { fetch: stubFetch({}).fetch }))).stored?.error).toBe(
      `target.missing ${target}`,
    );
    await pause();
    expect(await fetchMissing({ fetch: peer.fetch, gapMs: 0 })).toEqual({ looked: 0, stored: 0 });
    expect(peer.requests).toEqual([]);
  });

  test('held objects are not asked after, nor claimed for a recheck', async () => {
    await pause();
    expect(await recheckObjects({ fetch: peer.fetch, gapMs: 0, now: new Date(Date.now() + 30 * day) })).toEqual({
      checked: 0,
      gone: 0,
      unreachable: 0,
    });
    expect(peer.requests).toEqual([]);
  });

  test('a NodeInfo check asks nothing and records no failure for the peer', async () => {
    await pause();
    await refreshInstanceSoftware('https://new.test', { fetch: peer.fetch });
    expect(peer.requests).toEqual([]);
    expect(nodeInfoFailureCount()).toBe(0);
  });

  test('resolving an actor, a handle or an object throws FederationPaused before any request, and a search answers resolve.paused', async () => {
    await pause();
    await expect(resolveRemoteActor(stranger, { fetch: peer.fetch })).rejects.toBeInstanceOf(FederationPaused);
    await expect(resolveRemoteActor('@someone@new.test', { fetch: peer.fetch })).rejects.toBeInstanceOf(FederationPaused);
    const vouch = { community: world.peers.lab, announceApId: `${hosts.lab}/outbox` };
    await expect(fetchRemoteObject('https://lemmy.test/post/901', { vouch, fetch: peer.fetch })).rejects.toBeInstanceOf(FederationPaused);
    expect(await resolveLookup({ kind: 'url', url: stranger }, { fetch: peer.fetch })).toEqual({ ok: false, error: 'resolve.paused' });
    expect(peer.requests).toEqual([]);
  });

  test('an inbox POST whose signing key would have to be fetched is answered 503 with Retry-After, and nothing is stored', async () => {
    await pause();
    const inbox = 'https://fed-b.test/inbox';
    const body = JSON.stringify({ id: 'https://new.test/activities/like/1', type: 'Like', actor: stranger, object: hosts.t1 });
    const keys = { keyId: `${stranger}#main-key`, privateKeyPem: rsaKeys().privateKeyPem };
    const request = new Request(inbox, { method: 'POST', headers: await signDelivery(keys, inbox, body), body });
    const response = await receiveInbound(request, { fetch: peer.fetch });
    expect([response.status, response.headers.get('retry-after')]).toEqual([503, '300']);
    expect(peer.requests).toEqual([]);
    expect(await db().select().from(inboxRaw)).toEqual([]);
  });

  test('an inbox row whose actor would have to be fetched waits, pending, with its attempt given back', async () => {
    await pause();
    const like = {
      id: activityId('https://new.test', 'like'),
      type: 'Like',
      actor: stranger,
      object: hosts.t1,
      ...addressedToCommunity(hosts.spike),
    };
    const { row, settled } = await deliverRow(like, (leased) => processRow(leased, { fetch: peer.fetch }));
    expect(settled).toEqual({ state: 'pending', error: 'federation is paused here; this delivery waits until it is on again' });
    const [after] = await db().select({ state: inboxRaw.state, attempts: inboxRaw.attempts }).from(inboxRaw).where(eq(inboxRaw.id, row.id));
    expect(after).toEqual({ state: 'pending', attempts: 0 });
    expect(peer.requests).toEqual([]);
  });
});

// FN2 (review 2): the switch was read once, when a job or a document read started, so a request
// that had not gone out yet still went out after a pause: a delivery POST after its NodeInfo
// check, a redirect hop, a fetch waiting its turn to a host. Each test turns the switch off at
// that point (no timing: the switch flips inside the step before) and checks nothing more is sent.
describe('a switch turned off while work is under way', () => {
  /** A promise and the function that resolves it. */
  const signal = () => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };

  test('a delivery whose NodeInfo check ends after the pause is not POSTed, and goes back to pending with its attempt given back', async () => {
    const row = await seedDelivery(world.instances.lemmy, world.community, { state: 'pending', createdAt: new Date() });
    const counts = await deliverDue({ fetch: peer.fetch, refreshSoftware: pause });
    expect(counts).toEqual({ delivered: 0, retried: 0, failed: 0, skipped: 0 });
    expect(peer.requests).toEqual([]);
    const [after] = await db()
      .select({
        state: deliveries.state,
        attempts: deliveries.attempts,
        leaseUntil: deliveries.leaseUntil,
        lastError: deliveries.lastError,
      })
      .from(deliveries)
      .where(eq(deliveries.id, row.id));
    expect(after).toEqual({ state: 'pending', attempts: row.attempts, leaseUntil: null, lastError: null });
  });

  test('a redirect is not followed once the switch is off', async () => {
    const moved = 'https://new.test/users/someone';
    const stub = stubFetch({ [stranger]: { status: 301, location: moved }, [moved]: { body: { id: moved, type: 'Person' } } });
    const fetch = (async (url, init) => {
      const answer = await stub.fetch(url, init);
      await pause(); // while the first answer is on its way back
      return answer;
    }) as Fetcher;
    await expect(fetchJson(stranger, fetch)).rejects.toBeInstanceOf(FederationPaused);
    expect(stub.requests.map((request) => request.url)).toEqual([stranger]);
  });

  test('a fetch waiting its turn to a host is not sent when its turn comes after the pause', async () => {
    const first = 'https://new.test/one';
    const second = 'https://new.test/two';
    const stub = stubFetch({ [first]: { body: { id: first } }, [second]: { body: { id: second } } });
    const firstSent = signal();
    const firstMayEnd = signal();
    const base = (async (url, init) => {
      const answer = await stub.fetch(url, init);
      if (String(url) === first) {
        firstSent.resolve();
        await firstMayEnd.promise;
      }
      return answer;
    }) as Fetcher;
    const queue = polite(base, 0);
    const secondQueued = signal();
    const fetch: Fetcher = (url, init) => {
      const turn = queue(url, init); // takes its place in the host's queue before it returns
      if (String(url) === second) secondQueued.resolve();
      return turn;
    };

    const one = fetchJson(first, fetch);
    await firstSent.promise;
    const two = fetchJson(second, fetch);
    await secondQueued.promise; // checked the switch on its way in, and now waits behind the first
    await pause();
    firstMayEnd.resolve();

    expect((await one).json).toEqual({ id: first });
    await expect(two).rejects.toBeInstanceOf(FederationPaused);
    expect(stub.requests.map((request) => request.url)).toEqual([first]);
  });
});
