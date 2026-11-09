import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { siteSettings } from '@peblish/core/db/tables/site';
import { writer } from '@peblish/core/db/write';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, nodeInfoRoutes, rsaKeys, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { seedInboundWorld, seedInboxRow } from '@peblish/core/testing/seed-fed-b';
import { createHash } from 'node:crypto';
import { forgetKeyRefreshes } from '../signing/inbound.ts';
import { signDelivery, signHeaders } from '../signing/sign.ts';
import { admissionLock, maxBodyBytes, pendingBytesLimit, receiveInbound } from './receive.ts';
import {
  lookupBudgets,
  perInstanceRate,
  perSignerRate,
  resetKeyFetchBudget,
  takeIntake,
  takeKeyLookup,
  takePipelineFetch,
} from './throttle.ts';
import { activityId, addressedToCommunity, hosts } from './test-support.ts';

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

/** A POST to our inbox signed as lemmyuser. */
async function signed(body: string, keys: { keyId: string; privateKeyPem: string } = world.peers.lemmyuser.keys) {
  return new Request(inbox, { method: 'POST', headers: await signDelivery(keys, inbox, body), body });
}

const rows = () => db().select().from(inboxRaw);

describe('receiving an activity', () => {
  test('a signed activity is stored with its exact bytes and answered 202', async () => {
    // Trailing whitespace and a multi-byte character: the relay must be able to give these back unchanged.
    const body = `${JSON.stringify({ ...like(), summary: 'zażółć' })}  \n`;
    const response = await receiveInbound(await signed(body));
    expect(response.status).toBe(202);
    const [row] = await rows();
    expect(Buffer.from(row!.body).toString('utf8')).toBe(body);
    expect(row).toMatchObject({ activityType: 'Like', actorApId: hosts.lemmyuser, state: 'pending' });
    expect(row?.headers).toMatchObject({ method: 'POST', path: '/inbox', signer: hosts.lemmyuser, keyId: `${hosts.lemmyuser}#main-key` });
  });

  test('a body that does not survive a UTF-8 round trip is answered 400, so the relay can send exactly what was read', async () => {
    const send = async (bytes: Uint8Array<ArrayBuffer>) => {
      const url = new URL(inbox);
      const headers = new Headers({
        accept: 'application/activity+json',
        'content-type': 'application/activity+json',
        date: new Date().toUTCString(),
        digest: `SHA-256=${createHash('sha256').update(bytes).digest('base64')}`,
        host: url.host,
      });
      const covered = ['(request-target)', 'accept', 'content-type', 'date', 'digest', 'host'];
      const signedHeaders = signHeaders(world.peers.lemmyuser.keys, 'post', url, headers, covered);
      return (await receiveInbound(new Request(inbox, { method: 'POST', headers: signedHeaders, body: bytes }))).status;
    };
    const json = JSON.stringify({ ...like(), summary: 'XX' });
    const around = json.split('XX').map((part) => new TextEncoder().encode(part));
    const joined = (middle: number[]) => new Uint8Array(Buffer.concat([around[0]!, Uint8Array.from(middle), around[1]!]));
    expect(await send(joined([0xff, 0xfe]))).toBe(400);
    expect(await send(joined([0xc0, 0xaf]))).toBe(400);
    expect(await send(new Uint8Array(Buffer.concat([Uint8Array.from([0xef, 0xbb, 0xbf]), new TextEncoder().encode(json)])))).toBe(400);
    expect(await rows()).toEqual([]);
    expect(await send(joined([...new TextEncoder().encode('zażółć')]))).toBe(202);
  });

  test('a body over 512 KiB is answered 413, announced by Content-Length or streamed in chunks', async () => {
    const big = new Uint8Array(maxBodyBytes + 1).fill(0x20);
    const declared = new Request(inbox, { method: 'POST', headers: { 'content-length': String(big.length) }, body: big });
    expect((await receiveInbound(declared)).status).toBe(413);
    // No Content-Length: counted as the stream arrives, and the stream is cancelled when it passes the limit.
    let sent = 0;
    const chunked = new Request(inbox, {
      method: 'POST',
      body: new ReadableStream({
        pull(controller) {
          sent += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024));
          if (sent > 4 * maxBodyBytes) controller.close();
        },
      }),
      // @ts-expect-error Node requires duplex for a streamed request body
      duplex: 'half',
    });
    expect((await receiveInbound(chunked)).status).toBe(413);
    expect(sent).toBeLessThan(4 * maxBodyBytes);
    expect(await rows()).toHaveLength(0);
  });

  test('while the inbox is switched off it answers 503 with Retry-After, and stores nothing', async () => {
    await writer().insert(siteSettings).values({ key: 'inbox.enabled', value: false });
    const response = await receiveInbound(await signed(JSON.stringify(like())));
    expect({ status: response.status, retryAfter: response.headers.get('retry-after') }).toEqual({ status: 503, retryAfter: '300' });
    expect(await rows()).toHaveLength(0);
  });

  test('an unsigned or altered request is 401, a signed body that is not an activity is 400', async () => {
    const body = JSON.stringify(like());
    expect((await receiveInbound(new Request(inbox, { method: 'POST', body }))).status).toBe(401);
    const altered = await signed(body);
    const tampered = new Request(inbox, { method: 'POST', headers: altered.headers, body: `${body} ` });
    expect((await receiveInbound(tampered)).status).toBe(401);
    expect((await receiveInbound(await signed('not json'))).status).toBe(400);
    expect((await receiveInbound(await signed(JSON.stringify({ hello: 'world' })))).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test('a failure to store is a 503, never another 5xx', async () => {
    await writer().execute(sql`alter table inbox_raw rename to inbox_raw_away`);
    try {
      const response = await receiveInbound(await signed(JSON.stringify(like())));
      expect({ status: response.status, retryAfter: response.headers.get('retry-after') }).toEqual({ status: 503, retryAfter: '300' });
    } finally {
      await writer().execute(sql`alter table inbox_raw_away rename to inbox_raw`);
    }
  });

  // Requests from `peer` signed with keys nobody here holds, each naming another actor of `host`.
  const fabricated = async (count: number, host: string, peer: string, fetch: ReturnType<typeof stubFetch>['fetch']) => {
    const statuses: number[] = [];
    for (let n = 0; n < count; n++) {
      const stranger = { keyId: `https://${host}/u/someone${n}#main-key`, privateKeyPem: world.peers.mallory.keys.privateKeyPem };
      statuses.push((await receiveInbound(await signed(JSON.stringify(like()), stranger), { fetch, peer })).status);
    }
    return statuses;
  };
  const { discovery } = lookupBudgets;

  test('one address making us look up unknown keys is limited to a small allowance, then answered 429', async () => {
    const { fetch, requests } = stubFetch({});
    const statuses = await fabricated(discovery.perAddress + 1, 'unknown.test', '203.0.113.1', fetch);
    expect(statuses.slice(0, discovery.perAddress)).toEqual(Array(discovery.perAddress).fill(401));
    expect(statuses[discovery.perAddress]).toBe(429);
    // A refused lookup fetches nothing.
    expect(requests).toHaveLength(discovery.perAddress);
    expect(await db().select().from(inboxRaw).where(eq(inboxRaw.state, 'pending'))).toHaveLength(0);
  });

  test('a flood of made-up key ids from one address leaves a real host’s genuine new signer its turn', async () => {
    const host = 'genuine.test';
    const real = actorDocument(host, 'real', { publicKeyPem: world.peers.mallory.keys.publicKeyPem });
    const { fetch } = stubFetch({ [real.id]: { body: real }, ...nodeInfoRoutes(host, 'lemmy') });
    const flood = await fabricated(2 * discovery.perHost, host, '203.0.113.1', fetch);
    expect(flood.filter((status) => status === 401)).toHaveLength(discovery.perAddress);
    expect(flood.filter((status) => status === 429)).toHaveLength(2 * discovery.perHost - discovery.perAddress);

    const genuine = { keyId: real.publicKey.id, privateKeyPem: world.peers.mallory.keys.privateKeyPem };
    const body = JSON.stringify({ ...like(), actor: real.id });
    // Another client's lookup of the same host goes through: the flood spent its own address's allowance, not the host's.
    expect((await receiveInbound(await signed(body, genuine), { fetch, peer: '198.51.100.7' })).status).toBe(202);
    expect((await rows()).map((row) => row.actorApId)).toEqual([real.id]);
  });

  test('behind Traefik the address is the one it saw, so clients behind one proxy are counted apart', async () => {
    vi.stubEnv('PEBLISH_TRUSTED_PROXY', 'traefik');
    try {
      const { fetch } = stubFetch({});
      const from = async (client: string, n: number) => {
        const stranger = { keyId: `https://unknown.test/u/someone${n}#main-key`, privateKeyPem: world.peers.mallory.keys.privateKeyPem };
        const request = await signed(JSON.stringify(like()), stranger);
        request.headers.set('x-forwarded-for', `10.9.9.9, ${client}`);
        return (await receiveInbound(request, { fetch, peer: '10.0.0.2' })).status;
      };
      for (let n = 0; n < discovery.perAddress; n++) expect(await from('203.0.113.1', n)).toBe(401);
      expect(await from('203.0.113.1', 99)).toBe(429);
      expect(await from('203.0.113.2', 100)).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('a held actor’s rotated key is refreshed even while discovery of its host is spent', async () => {
    const rotated = rsaKeys();
    const { fetch } = stubFetch({
      [hosts.lemmyuser]: { body: actorDocument('lemmy.test', 'lemmyuser', { publicKeyPem: rotated.publicKeyPem }) },
      ...nodeInfoRoutes('lemmy.test', 'lemmy'),
    });
    // The stored copy is older than the minute a key is not looked for again.
    await writer()
      .update(actors)
      .set({ fetchedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(actors.apId, hosts.lemmyuser));
    for (let n = 0; n < 2 * discovery.perHost; n++) takeKeyLookup('discovery', { address: `192.0.2.${n}`, host: 'lemmy.test' });
    expect(takeKeyLookup('discovery', { address: '192.0.2.250', host: 'lemmy.test' })).toBe(false);

    const response = await receiveInbound(await signed(JSON.stringify(like()), { keyId: `${hosts.lemmyuser}#main-key`, ...rotated }), {
      fetch,
      peer: '198.51.100.7',
    });
    expect(response.status).toBe(202);
  });

  test('an unsigned flood does not spend what a real peer needs', async () => {
    const { fetch } = stubFetch({});
    await fabricated(discovery.perAddress + 1, 'unknown.test', '203.0.113.1', fetch);
    // The lookup budget is spent for that address, yet a known key needs no fetch, and what processing fetches has its own budget.
    expect((await receiveInbound(await signed(JSON.stringify(like())), { peer: '203.0.113.1' })).status).toBe(202);
    expect(takePipelineFetch('unknown.test')).toBe(true);
  });
});

describe('a Delete from an account whose key cannot be fetched', () => {
  const gone = 'https://gone.test/users/x';
  const accountDelete = (actor: string, object = actor) => ({
    id: `${actor}#delete`,
    type: 'Delete',
    actor,
    object,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  });
  const signedAs = (actor: string) => ({ keyId: `${actor}#main-key`, privateKeyPem: world.peers.mallory.keys.privateKeyPem });

  test('for an account we do not hold is answered 202 and nothing is stored, so the peer stops retrying', async () => {
    const { fetch } = stubFetch({ [gone]: { status: 410 } });
    const response = await receiveInbound(await signed(JSON.stringify(accountDelete(gone)), signedAs(gone)), { fetch });
    expect(response.status).toBe(202);
    expect(await rows()).toEqual([]);
  });

  test('is still 401 when we hold the account, when it deletes something else, or when it is not a Delete', async () => {
    const { fetch } = stubFetch({ [gone]: { status: 410 } });
    const attempt = async (activity: object, as: { keyId: string; privateKeyPem: string }) =>
      (await receiveInbound(await signed(JSON.stringify(activity), as), { fetch })).status;
    // A held, living account that signs with a key we do not know may be a rotated key: the peer should retry.
    const held = { keyId: `${hosts.lemmyuser}#other-key`, privateKeyPem: world.peers.mallory.keys.privateKeyPem };
    expect(await attempt(accountDelete(hosts.lemmyuser), held)).toBe(401);
    expect(await attempt(accountDelete(gone, 'https://gone.test/post/1'), signedAs(gone))).toBe(401);
    expect(await attempt({ ...accountDelete(gone), type: 'Like' }, signedAs(gone))).toBe(401);
    expect(await rows()).toEqual([]);
  });
});

describe('what one signer, and its instance, may send', () => {
  test('a repeat of a body, or of an activity id within the hour, is answered 202 and stored once', async () => {
    const body = JSON.stringify(like());
    expect((await receiveInbound(await signed(body))).status).toBe(202);
    expect((await receiveInbound(await signed(body))).status).toBe(202);
    expect((await receiveInbound(await signed(`${body} `))).status).toBe(202);
    expect(await rows()).toHaveLength(1);
    expect((await receiveInbound(await signed(JSON.stringify(like())))).status).toBe(202);
    expect(await rows()).toHaveLength(2);
  });

  test('a repeat is answered 202 after the signer’s allowance is spent, while a new activity is not', async () => {
    const body = JSON.stringify(like());
    expect((await receiveInbound(await signed(body))).status).toBe(202);
    for (let used = 0; used < perSignerRate; used++) takeIntake(hosts.lemmyuser);
    expect((await receiveInbound(await signed(body))).status).toBe(202);
    expect((await receiveInbound(await signed(JSON.stringify(like())))).status).toBe(429);
    expect(await rows()).toHaveLength(1);
  });

  test('identical requests that arrive together wait their turn at the instance and are stored once', async () => {
    const body = JSON.stringify(like());
    // Another request of the instance is in its admission step: these wait for it.
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const open = new Promise<void>((resolve) => (release = resolve));
    const holder = tx(async (t) => {
      await t.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${admissionLock('https://lemmy.test')}, 0))`);
      locked();
      await open;
    });
    await holding;

    let finished = 0;
    const answers = Array.from({ length: 4 }, async () => {
      const status = (await receiveInbound(await signed(body))).status;
      finished += 1;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(0);
    release();
    await holder;
    expect(await Promise.all(answers)).toEqual(Array(4).fill(202));
    expect(await rows()).toHaveLength(1);
  });

  test('large requests that arrive together cannot all pass on the same pending count', async () => {
    const filler = 'x'.repeat(256 * 1024);
    const bodies = Array.from({ length: 4 }, () => JSON.stringify({ ...like(), summary: filler }));
    const size = new TextEncoder().encode(bodies[0]!).byteLength;
    // Room for two of them, and not three.
    await seedInboxRow(new Uint8Array(pendingBytesLimit.signer - Math.floor(2.5 * size)), { actorApId: hosts.lemmyuser });
    const statuses = await Promise.all(bodies.map(async (body) => (await receiveInbound(await signed(body))).status));
    expect(statuses.toSorted()).toEqual([202, 202, 429, 429]);
    expect(await rows()).toHaveLength(3);
  });

  test('a signer over its request rate, or an instance over its own, is answered 429 and the others are not affected', async () => {
    const elsewhere = { ...like(), actor: hosts.mallory };
    for (let used = 0; used < perSignerRate; used++) takeIntake(hosts.lemmyuser);
    expect((await receiveInbound(await signed(JSON.stringify(like())))).status).toBe(429);
    expect((await receiveInbound(await signed(JSON.stringify(elsewhere), world.peers.mallory.keys))).status).toBe(202);

    resetKeyFetchBudget();
    for (let used = 0; used < perInstanceRate; used++) takeIntake(`https://lemmy.test/u/other${used}`);
    const limited = await receiveInbound(await signed(JSON.stringify(like())));
    expect({ status: limited.status, retryAfter: limited.headers.get('retry-after') }).toEqual({ status: 429, retryAfter: '300' });
    expect((await rows()).filter((row) => row.actorApId === hosts.lemmyuser)).toHaveLength(0);
  });

  test('a signer, or an instance, with too much waiting in inbox_raw is answered 429 until the pipeline catches up', async () => {
    const megabytes = (count: number) => new Uint8Array(count * 1024 * 1024);
    const waiting = (actorApId: string, size: number) => seedInboxRow(megabytes(size), { actorApId });
    const elsewhere = { ...like(), actor: hosts.mallory };
    const post = async () => (await receiveInbound(await signed(JSON.stringify(like())))).status;

    const full = await waiting(hosts.lemmyuser, pendingBytesLimit.signer / 1024 / 1024 + 1);
    expect(await post()).toBe(429);
    // Another signer of the same instance, and a signer elsewhere, are not held back by it.
    expect(
      (await receiveInbound(await signed(JSON.stringify({ ...like(), actor: hosts.lemmyadmin }), world.peers.lemmyadmin.keys))).status,
    ).toBe(202);
    expect((await receiveInbound(await signed(JSON.stringify(elsewhere), world.peers.mallory.keys))).status).toBe(202);
    // Once the row is processed it no longer counts.
    await writer().update(inboxRaw).set({ state: 'applied' }).where(eq(inboxRaw.id, full.id));
    expect(await post()).toBe(202);

    // Many signers of one instance together.
    const share = pendingBytesLimit.instance / 1024 / 1024 / 4 + 1;
    for (let signer = 0; signer < 5; signer++) await waiting(`https://lemmy.test/u/filler${signer}`, share);
    expect(await post()).toBe(429);
  });
});
