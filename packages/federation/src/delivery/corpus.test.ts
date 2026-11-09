import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { deliveries } from '@peblish/core/delivery/tables';
import { comments, posts } from '@peblish/core/db/tables/content';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { writer } from '@peblish/core/db/write';
import { tx } from '@peblish/core/tx/tx';
import { truncateAll } from '@peblish/core/testing/db';
import { seedActor, seedInstance } from '@peblish/core/testing/seed';
import { seedComment, seedPost } from '@peblish/core/testing/seed-az';
import { seedLocalInstance, seedSigningKey } from '@peblish/core/testing/seed-fed-a';
import type { OutboxEvent } from '@peblish/schema/events';
import { diff, matches, type Change } from '../test/diff.ts';
import { readFixture, readManifest } from '../test/manifest.ts';
import { shapeOf } from '../test/corpus.ts';
import { consumer } from './consumer.ts';

// What peblish sends against what Lemmy 0.19.21 and PieFed 1.8.11 accepted from the spike: the
// manifest's `feddit-spike-0.0.1` outbound entries. For each event the consumer turns into an
// activity, the document we queue must have the same keys and the same kinds of values as an
// accepted document of the same shape; ids, times, texts and addresses differ, nothing else may.

const entries = readManifest().entries;
const acceptedShape = (label: string, software = 'feddit-spike') => {
  const entry = entries.find(
    (candidate) => candidate.software.name === software && candidate.type === label && candidate.direction !== 'peer-log',
  );
  if (!entry) throw new Error(`the corpus has no ${software} ${label}`);
  return readFixture(entry.fixture);
};

const kind = (value: unknown) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

/**
 * How our documents differ from the spike's, and why that is fine. The spike's Fedify output
 * left out the Lemmy vocabulary the mapping sends on purpose (mapping/README.md, "Lemmy
 * vocabulary peblish sends"), embedded a @context in nested objects, and gave its Notes a
 * `sensitive` flag Lemmy's own Notes lack. Lemmy and PieFed accepted the spike's documents; they
 * send these fields themselves, so they read ours too. Anything else that differs is a bug.
 */
const dialect: { change: Change; pattern: string }[] = [
  { change: 'added', pattern: '**.attachment' },
  { change: 'added', pattern: '**.cc' },
  { change: 'added', pattern: '**.commentsEnabled' },
  { change: 'added', pattern: '**.stickied' },
  { change: 'added', pattern: '**.nsfl' },
  { change: 'added', pattern: '**.distinguished' },
  { change: 'dropped', pattern: '**.sensitive' },
  { change: 'dropped', pattern: '**.@context' },
  // A moderator's restore carries the reason; an author's Undo(Delete) has none.
  { change: 'dropped', pattern: '**.summary' },
];

/** Differences between an accepted document and ours that are more than a different value of the same kind or the dialect above. */
function structural(
  label: string,
  ours: unknown,
  { reference = 'feddit-spike', allowed = dialect }: { reference?: string; allowed?: typeof dialect } = {},
) {
  return diff(acceptedShape(label, reference), ours)
    .filter((difference) => difference.change !== 'changed' || kind(difference.original) !== kind(difference.mapped))
    .filter((difference) => !allowed.some((entry) => entry.change === difference.change && matches(entry.pattern, difference.path)))
    .map((difference) => `${difference.change} ${difference.path}`);
}

async function world() {
  const { instance: here } = await seedLocalInstance();
  const alice = await seedActor(here, 'Person', 'alice', { inboxUrl: 'https://fed-a.test/ap/u.alice/inbox' });
  const news = await seedActor(here, 'Group', 'news', { inboxUrl: 'https://fed-a.test/ap/c.news/inbox' });
  await seedSigningKey(alice);
  await seedSigningKey(news);
  const lemmy = await seedInstance('lemmy.test', false);
  await writer().update(instances).set({ software: 'lemmy' }).where(eq(instances.id, lemmy.id));
  const bob = await seedActor(lemmy, 'Person', 'bob', {
    inboxUrl: 'https://lemmy.test/u/bob/inbox',
    sharedInboxUrl: 'https://lemmy.test/inbox',
  });
  await writer()
    .insert(follows)
    .values({ followerId: bob.id, followeeId: news.id, apId: 'https://lemmy.test/follow/bob', state: 'accepted' });
  const lab = await seedActor(lemmy, 'Group', 'lab', { inboxUrl: 'https://lemmy.test/c/lab/inbox' });
  const run = async (event: OutboxEvent) => {
    await writer().delete(deliveries);
    await tx((t) => consumer.handle(event, t));
    return (await db().select().from(deliveries)).map((row) => JSON.parse(row.body) as unknown);
  };
  return { here, alice, news, bob, lab, run };
}

/** An edit: the row's `updated` time is set, as the edit mutations do, before the event is handled. */
const edited = async (table: typeof posts | typeof comments, id: string) => {
  await writer().update(table).set({ editedAt: new Date() }).where(eq(table.id, id));
};

const post = (type: string, w: { news: { id: string }; alice: { id: string } }, postId: string) =>
  ({ type, v: 1, postId, communityId: w.news.id, authorId: w.alice.id, local: true }) as OutboxEvent;
const vote = (
  w: { alice: { id: string } },
  postId: string,
  fields: { value: -1 | 0 | 1; previous: -1 | 0 | 1; apId: string | null; previousApId: string | null },
) => ({ type: 'vote.cast', v: 1, voterId: w.alice.id, target: { kind: 'post', id: postId }, local: true, ...fields }) as OutboxEvent;

beforeEach(truncateAll);

describe('what we queue has the shape Lemmy and PieFed accepted', () => {
  test('a community announcing posts, comments, edits, deletes and votes', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.news, w.alice, {
      title: 'Hello',
      bodyMd: 'text',
      url: 'https://example.com/a',
    });
    const c = await seedComment(w.here, p, w.alice, { bodyMd: 'a comment' });
    const commentEvent = (type: string) =>
      ({ type, v: 1, commentId: c.id, postId: p.id, authorId: w.alice.id, parentId: null, local: true }) as OutboxEvent;
    const like = { value: 1, previous: 0, apId: 'https://fed-a.test/ap/activity/like-1', previousApId: null } as const;
    const seen = {
      'Announce(Create(Page))': (await w.run(post('post.created', w, p.id)))[0],
      'Announce(Update(Page))': (await edited(posts, p.id), (await w.run(post('post.updated', w, p.id)))[0]),
      'Announce(Delete)': (await w.run(post('post.deleted', w, p.id)))[0],
      'Announce(Create(Note))': (await w.run(commentEvent('comment.created')))[0],
      'Announce(Like)': (await w.run(vote(w, p.id, like)))[0],
      'Announce(Dislike)': (
        await w.run(vote(w, p.id, { value: -1, previous: 0, apId: 'https://fed-a.test/ap/activity/dislike-1', previousApId: null }))
      )[0],
      'Announce(Undo(Like))': (await w.run(vote(w, p.id, { value: 0, previous: 1, apId: null, previousApId: like.apId })))[0],
      'Announce(Undo(Dislike))': (
        await w.run(vote(w, p.id, { value: 0, previous: -1, apId: null, previousApId: 'https://fed-a.test/ap/activity/dislike-1' }))
      )[0],
    };
    // The post comes back after a delete: Announce(Undo(Delete)).
    const restored = { 'Announce(Undo(Delete))': (await w.run(post('post.restored', w, p.id)))[0] };
    const problems = Object.fromEntries(Object.entries({ ...seen, ...restored }).map(([label, ours]) => [label, structural(label, ours)]));
    expect(problems).toEqual(Object.fromEntries(Object.keys({ ...seen, ...restored }).map((label) => [label, []])));
    for (const [label, ours] of Object.entries({ ...seen, ...restored })) expect(shapeOf(ours)).toBe(label);
  });

  test('a person’s own activity in a remote community, and the follow handshake', async () => {
    const w = await world();
    const p = await seedPost(w.here, w.lab, w.alice, { title: 'Hello', bodyMd: 'text' });
    const c = await seedComment(w.here, p, w.alice, { bodyMd: 'a comment' });
    const remotePost = (type: string) =>
      ({ type, v: 1, postId: p.id, communityId: w.lab.id, authorId: w.alice.id, local: true }) as OutboxEvent;
    const commentEvent = (type: string) =>
      ({ type, v: 1, commentId: c.id, postId: p.id, authorId: w.alice.id, parentId: null, local: true }) as OutboxEvent;
    const like = { value: 1, previous: 0, apId: 'https://fed-a.test/ap/activity/like-1', previousApId: null } as const;
    const follow = { v: 1, followId: '01a1bddf-bc70-7f9f-87f1-968d3195960a', apId: 'https://fed-a.test/ap/activity/follow-1' } as const;
    const seen = {
      'Create(Page)': (await w.run(remotePost('post.created')))[0],
      'Update(Page)': (await edited(posts, p.id), (await w.run(remotePost('post.updated')))[0]),
      Delete: (await w.run(remotePost('post.deleted')))[0],
      'Create(Note)': (await w.run(commentEvent('comment.created')))[0],
      'Update(Note)': (await edited(comments, c.id), (await w.run(commentEvent('comment.updated')))[0]),
      Like: (await w.run({ ...vote(w, p.id, like), target: { kind: 'post', id: p.id } } as OutboxEvent))[0],
      'Undo(Like)': (await w.run(vote(w, p.id, { value: 0, previous: 1, apId: null, previousApId: like.apId })))[0],
      Follow: (
        await w.run({
          type: 'follow.requested',
          ...follow,
          followerId: w.alice.id,
          followeeId: w.lab.id,
          followerLocal: true,
          followeeLocal: false,
        })
      )[0],
      'Accept(Follow)': (
        await w.run({
          type: 'follow.accepted',
          ...follow,
          apId: 'https://lemmy.test/follow/bob',
          followerId: w.bob.id,
          followeeId: w.news.id,
          followerLocal: false,
          followeeLocal: true,
        })
      )[0],
    };
    const problems = Object.fromEntries(Object.entries(seen).map(([label, ours]) => [label, structural(label, ours)]));
    expect(problems).toEqual(Object.fromEntries(Object.keys(seen).map((label) => [label, []])));
    for (const [label, ours] of Object.entries(seen)) expect(shapeOf(ours)).toBe(label);
  });
});

describe('the copy for Mastodon is the shape Lemmy sends', () => {
  test('Announce(Page) matches Lemmy’s own, key for key', async () => {
    const w = await world();
    const masto = await seedInstance('masto.test', false);
    await writer().update(instances).set({ software: 'mastodon' }).where(eq(instances.id, masto.id));
    const dave = await seedActor(masto, 'Person', 'dave', {
      inboxUrl: 'https://masto.test/users/dave/inbox',
      sharedInboxUrl: 'https://masto.test/inbox',
    });
    await writer()
      .insert(follows)
      .values({ followerId: dave.id, followeeId: w.news.id, apId: 'https://masto.test/follow/dave', state: 'accepted' });
    const p = await seedPost(w.here, w.news, w.alice, { title: 'Hello', bodyMd: 'text', url: 'https://example.com/a' });
    await w.run(post('post.created', w, p.id));
    const rows = await db().select().from(deliveries).where(eq(deliveries.inboxUrl, 'https://masto.test/inbox'));
    const ours = JSON.parse(rows[0]!.body) as unknown;
    expect(shapeOf(ours)).toBe('Announce(Page)');
    // Against Lemmy's own: nothing may differ but the fields listed here.
    expect(
      structural('Announce(Page)', ours, {
        reference: 'lemmy',
        allowed: [
          // Our Page names the link, and PieFed's flags; Lemmy's embeds the author again as `actor` and tags the community.
          { change: 'added', pattern: 'object.attachment[]' },
          { change: 'added', pattern: 'object.commentsEnabled' },
          { change: 'added', pattern: 'object.stickied' },
          { change: 'added', pattern: 'object.nsfl' },
          { change: 'dropped', pattern: 'object.actor' },
          { change: 'dropped', pattern: 'object.tag' },
        ],
      }),
    ).toEqual([]);
  });
});
