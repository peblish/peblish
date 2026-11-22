import { beforeEach, expect, test } from 'vitest';
import { personBlocks } from '../blocks/tables.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedPost } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { participantScan, threadFacts } from './facts.ts';

beforeEach(truncateAll);

test('thread facts count the post’s author and the live comments the viewer is shown, each person once', async () => {
  const local = await seedInstance('feddit.test');
  const community = await seedActor(local, 'Group', 'bikes');
  const [author, ann, bo, troll, viewer] = await Promise.all(
    ['author', 'ann', 'bo', 'troll', 'viewer'].map((name) => seedActor(local, 'Person', name)),
  );
  const posted = new Date('2026-11-01T10:00:00Z');
  const post = await seedPost(local, community, author!, { publishedAt: posted, language: 'de' });
  expect(await threadFacts(post.id, null)).toEqual({ participants: 1, more: false, lastActivityAt: posted.toISOString(), language: 'de' });

  await seedComment(local, post, ann!, { publishedAt: new Date('2026-11-02T10:00:00Z') });
  await seedComment(local, post, ann!, { publishedAt: new Date('2026-11-03T10:00:00Z') });
  await seedComment(local, post, author!, { publishedAt: new Date('2026-11-04T10:00:00Z') });
  await seedComment(local, post, bo!, { publishedAt: new Date('2026-11-09T10:00:00Z'), removedAt: new Date() });
  await seedComment(local, post, troll!, { publishedAt: new Date('2026-11-05T10:00:00Z') });
  expect(await threadFacts(post.id, null)).toMatchObject({ participants: 3, lastActivityAt: '2026-11-05T10:00:00.000Z' });

  await writer().insert(personBlocks).values({ blockerId: viewer!.id, blockedId: troll!.id });
  expect(await threadFacts(post.id, { actorId: viewer!.id, siteRole: 'user' })).toMatchObject({
    participants: 2,
    more: false,
    lastActivityAt: '2026-11-04T10:00:00.000Z',
  });
});

test('past one read’s worth of comments, participants are a floor and the last activity is unknown', async () => {
  const local = await seedInstance('feddit.test');
  const community = await seedActor(local, 'Group', 'bikes');
  const author = await seedActor(local, 'Person', 'author');
  const post = await seedPost(local, community, author);
  for (let i = 0; i <= participantScan; i++) await seedComment(local, post, author);
  expect(await threadFacts(post.id, null)).toEqual({ participants: 1, more: true, lastActivityAt: null, language: null });
});
