import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { inboxRaw } from '@peblish/core/db/tables/federation';
import { siteSettings } from '@peblish/core/db/tables/site';
import { writer } from '@peblish/core/db/write';
import { truncateAll } from '@peblish/core/testing/db';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { signDelivery } from '../signing/sign.ts';
import { maxBodyBytes, receiveInbound } from './receive.ts';
import { perHostBudget, resetKeyFetchBudget } from './throttle.ts';
import { activityId, addressedToCommunity, hosts } from './test-support.ts';

const inbox = 'https://fed-b.test/inbox';
let world: Awaited<ReturnType<typeof seedInboundWorld>>;

beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
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
async function signed(body: string, keys = world.peers.lemmyuser.keys) {
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

  test('requests made to fetch unknown keys are limited, then answered 429', async () => {
    const { fetch } = stubFetch({});
    const body = JSON.stringify(like());
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= perHostBudget; attempt++) {
      const stranger = {
        keyId: `https://unknown.test/u/someone${attempt}#main-key`,
        privateKeyPem: world.peers.mallory.keys.privateKeyPem,
      };
      statuses.push((await receiveInbound(await signed(body, stranger), { fetch })).status);
    }
    expect(statuses.slice(0, perHostBudget)).toEqual(Array(perHostBudget).fill(401));
    expect(statuses[perHostBudget]).toBe(429);
    expect(await db().select().from(inboxRaw).where(eq(inboxRaw.state, 'pending'))).toHaveLength(0);
  });
});
