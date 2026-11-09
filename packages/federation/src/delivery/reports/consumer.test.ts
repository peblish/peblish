import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { activities } from '@peblish/core/db/tables/federation';
import { deliveries } from '@peblish/core/delivery/tables';
import { writer } from '@peblish/core/db/write';
import { peerControls } from '@peblish/core/peers/tables';
import { createReportAs } from '@peblish/core/reports/actions';
import type { ReportCategory } from '@peblish/core/reports/categories';
import { truncateAll } from '@peblish/core/testing/db';
import { localUser, seedActor, seedInstance } from '@peblish/core/testing/seed';
import { outboxEvents, seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { tx } from '@peblish/core/tx/tx';
import type { OutboxEvent } from '@peblish/schema/events';
import { readFixture } from '../../test/manifest.ts';
import { deliverDue } from '../run.ts';
import { consumer } from './consumer.ts';

// A local report with `forward` becomes one Flag signed as the reporter, queued for the remote
// community's inbox and the remote author's instance. It is never stored as an activity.

beforeEach(truncateAll);

/** This server (alice reports, bob writes) and two peers: lemmy.test with a community and authors, other.test with an author. */
async function world() {
  const { instance: here } = await seedLocalInstance();
  const alice = await seedActor(here, 'Person', 'alice', { inboxUrl: 'https://fed-a.test/u/alice/inbox' });
  const bob = await seedActor(here, 'Person', 'bob');
  const home = await seedActor(here, 'Group', 'home');
  await seedSigningKey(alice);
  const lemmy = await seedInstance('lemmy.test', false);
  const other = await seedInstance('other.test', false);
  const lab = await seedActor(lemmy, 'Group', 'lab', {
    inboxUrl: 'https://lemmy.test/c/lab/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  const rex = await seedActor(lemmy, 'Person', 'rex', {
    inboxUrl: 'https://lemmy.test/u/rex/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  const olga = await seedActor(other, 'Person', 'olga', {
    inboxUrl: 'https://other.test/u/olga/inbox',
    sharedInboxUrl: 'https://other.test/inbox',
  });
  return { here, alice, bob, home, lemmy, other, lab, rex, olga };
}

type World = Awaited<ReturnType<typeof world>>;

/** Files the report as alice, then runs the consumer on the event it emitted. */
async function forwarded(
  w: World,
  post: { id: string },
  category: ReportCategory,
  forward: boolean,
  details = 'Selling counterfeit watches',
) {
  const made = await createReportAs(localUser(w.alice.id), { target: { kind: 'post', id: post.id }, category, forward, details });
  if (!made.ok) return made.reason;
  const event = (await outboxEvents()).at(-1) as OutboxEvent;
  await tx((t) => consumer.handle(event, t));
  return made;
}
const queued = async () =>
  (await db().select().from(deliveries).orderBy(deliveries.inboxUrl)).map((row) => ({ ...row, json: JSON.parse(row.body) }));

/** The members of a captured Flag with our values in, minus what differs by design (@context, the id, Lemmy's null content). */
const likeFixture = (name: string, ours: Record<string, unknown>) => {
  const { '@context': _context, id: _id, content: _content, ...rest } = readFixture(name) as Record<string, unknown>;
  return { ...rest, ...ours };
};

describe('the Flag we send', () => {
  test('has the members of the Flags Lemmy and PieFed send, signed as the reporter', async () => {
    const w = await world();
    const post = await seedPost(w.lemmy, w.lab, w.rex);
    expect(await forwarded(w, post, 'spam', true)).toMatchObject({ ok: true });
    const [row, ...rest] = await queued();
    expect(rest).toEqual([]);
    const { '@context': context, id, ...members } = row!.json;
    expect(context).toBeDefined();
    expect(row).toMatchObject({ senderId: w.alice.id, inboxUrl: 'https://lemmy.test/inbox', activityApId: id });
    const ours = {
      actor: w.alice.apId,
      object: post.apId,
      to: [w.lab.apId],
      audience: w.lab.apId,
      summary: 'Spam - Selling counterfeit watches',
    };
    expect(members).toEqual(likeFixture('wire/lemmy-0.19.21/inbound/inbound-0045-flag.json', ours));
    expect(members).toEqual(likeFixture('wire/piefed-1.8.11/inbound/inbound-0062-flag.json', ours));
    expect(members).not.toHaveProperty('content');
  });

  test('is never stored as an activity, and nothing is sent when the reporter keeps the report here', async () => {
    const w = await world();
    const post = await seedPost(w.lemmy, w.lab, w.rex);
    await forwarded(w, post, 'spam', true);
    expect(await db().select().from(activities)).toEqual([]);
    const second = await seedPost(w.lemmy, w.lab, w.rex);
    await forwarded(w, second, 'spam', false);
    expect(await queued()).toHaveLength(1);
  });
});

describe('who gets it', () => {
  test.each([
    ['a remote community and an author on another host', 'olga', ['https://lemmy.test/inbox', 'https://other.test/inbox']],
    ['a remote community and an author on the same host', 'rex', ['https://lemmy.test/inbox']],
    ['a remote community and a local author', 'bob', ['https://lemmy.test/inbox']],
  ] as const)('%s', async (_case, author, inboxes) => {
    const w = await world();
    const post = await seedPost(w.lemmy, w.lab, w[author]);
    expect(await forwarded(w, post, 'hate', true)).toMatchObject({ ok: true });
    expect((await queued()).map((row) => row.inboxUrl)).toEqual(inboxes);
  });

  test('a local community and a remote author: only the author’s instance', async () => {
    const w = await world();
    const post = await seedPost(w.here, w.home, w.olga);
    expect(await forwarded(w, post, 'hate', true)).toMatchObject({ ok: true });
    expect((await queued()).map((row) => row.inboxUrl)).toEqual(['https://other.test/inbox']);
  });

  test('a local community and a local author has nobody to send to, and an admins-only category never leaves', async () => {
    const w = await world();
    const local = await seedPost(w.here, w.home, w.bob);
    expect(await forwarded(w, local, 'hate', true)).toBe('report.forward_unavailable');
    const remote = await seedPost(w.lemmy, w.lab, w.rex);
    expect(await forwarded(w, remote, 'child_safety', true)).toBe('report.forward_unavailable');
    expect(await queued()).toEqual([]);
  });

  test('an author’s instance blocked after the report was filed gets no Flag; the community’s still does', async () => {
    const w = await world();
    const post = await seedPost(w.lemmy, w.lab, w.olga);
    expect(await forwarded(w, post, 'hate', true)).toMatchObject({ ok: true });
    await writer().insert(peerControls).values({ instanceId: w.other.id, blocked: true });
    const { fetch, requests } = stubFetch({ 'https://lemmy.test/inbox': { status: 202 } });
    expect(await deliverDue({ fetch, refreshSoftware: async () => {} })).toMatchObject({ delivered: 1, skipped: 1 });
    expect(requests.map((request) => request.url)).toEqual(['https://lemmy.test/inbox']);
    expect((await queued()).map((row) => [row.inboxUrl, row.state])).toEqual([
      ['https://lemmy.test/inbox', 'delivered'],
      ['https://other.test/inbox', 'skipped'],
    ]);
  });
});
