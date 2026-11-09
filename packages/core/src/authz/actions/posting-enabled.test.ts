import { beforeEach, expect, test } from 'vitest';
import { truncateAll } from '../../testing/db.ts';
import { seedSetting } from '../../testing/seed-a.ts';
import { seedPostWorld } from '../../testing/seed-b1.ts';
import { localUser } from '../../testing/seed.ts';
import { authorize } from '../authorize.ts';

// The posting kill switch (site setting posting.enabled, lane ADM writes it): off, local people
// can neither post nor comment; remote authors are not stopped, so peers' content keeps arriving.

beforeEach(truncateAll);

test('posting.enabled off refuses local posts and comments with site.disabled and lets remote ones through', async () => {
  const world = await seedPostWorld();
  const author = localUser(world.people.author.id);
  const remote = { kind: 'remote', actorId: world.people.remoteAuthor.id, announcedBy: null } as const;
  const post = { communityId: world.communities.open.id };
  const comment = { postId: world.posts.local.normal, parentId: null };
  const remoteComment = { postId: world.posts.remote.normal, parentId: null };
  const outcome = async () =>
    Promise.all([
      authorize('post.create', author, post),
      authorize('comment.create', author, comment),
      authorize('post.create', remote, { communityId: world.communities.remote.id }),
      authorize('comment.create', remote, remoteComment),
    ]).then((decisions) => decisions.map((decision) => (decision.ok ? 'allow' : decision.reason)));
  expect(await outcome()).toEqual(['allow', 'allow', 'allow', 'allow']);
  await seedSetting('posting.enabled', false);
  expect(await outcome()).toEqual(['site.disabled', 'site.disabled', 'allow', 'allow']);
  await seedSetting('posting.enabled', true);
  expect(await outcome()).toEqual(['allow', 'allow', 'allow', 'allow']);
});
