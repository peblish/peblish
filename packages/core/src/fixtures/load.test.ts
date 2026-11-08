import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../db/read.ts';
import { actors, communityLanguages } from '../db/tables/actors.ts';
import { comments, posts, votes } from '../db/tables/content.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { truncateAll } from '../testing/db.ts';
import { loadFixtureSet } from './load.ts';

beforeEach(truncateAll);

it('loads lab-live into the public tables, every row remote', async () => {
  const { set, id } = await loadFixtureSet('lab-live');
  const count = async (table: typeof actors | typeof posts | typeof comments | typeof votes | typeof follows | typeof instances) =>
    (await db().select().from(table)).length;
  expect([
    await count(instances),
    await count(actors),
    await count(posts),
    await count(comments),
    await count(votes),
    await count(follows),
  ]).toEqual([set.instances.length, set.actors.length, set.posts.length, set.comments.length, set.votes.length, set.follows.length]);
  expect(await db().select().from(actors).where(eq(actors.local, true))).toEqual([]);
  const [lemmyPost] = await db()
    .select()
    .from(posts)
    .where(eq(posts.id, id('https://lemmy.lab.test/post/10')));
  expect(lemmyPost).toMatchObject({ local: false, communityId: id('https://lemmy.lab.test/c/lab') });
  expect(lemmyPost?.raw).not.toBeNull();
  const languages = await db()
    .select({ language: communityLanguages.language })
    .from(communityLanguages)
    .where(eq(communityLanguages.communityId, id('https://piefed.lab.test/c/pflab')));
  expect(languages.map(({ language }) => language).sort()).toEqual(['en', 'und']);
});

it('makes the instance named localDomain local, with its rows local and raw null', async () => {
  const { id } = await loadFixtureSet('lab-live', { localDomain: 'feddit.lab.test' });
  const [instance] = await db().select().from(instances).where(eq(instances.local, true));
  expect(instance?.domain).toBe('feddit.lab.test');
  const [community] = await db()
    .select()
    .from(actors)
    .where(eq(actors.id, id('https://feddit.lab.test/ap/c.spike')));
  expect(community).toMatchObject({ local: true, kind: 'Group', name: 'spike', raw: null });
  const [post] = await db()
    .select()
    .from(posts)
    .where(eq(posts.id, id('https://feddit.lab.test/ap/post/1')));
  expect(post).toMatchObject({ local: true, raw: null });
  await expect(loadFixtureSet('lab-live', { localDomain: 'nowhere.test' })).rejects.toThrow('has no instance nowhere.test');
});
