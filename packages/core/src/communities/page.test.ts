import { beforeEach, describe, expect, test } from 'vitest';
import { communityModerators } from '../db/tables/moderation.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedBan, seedCommunityRemoval, seedModerator, seedPost } from '../testing/seed-az.ts';
import { person, sampleCommunity, seedCommunityWorld } from '../testing/seed-f.ts';
import { seedActor } from '../testing/seed.ts';
import { createCommunityAs } from './create.ts';
import { hideNsfw } from './gate.ts';
import { communityGate, readCommunityPage } from './page.ts';
import { findCommunityId } from './read.ts';
import { updateCommunityAs } from './update.ts';

beforeEach(truncateAll);

async function setup() {
  const world = await seedCommunityWorld();
  const admin = person(world.people.admin.id, 'admin');
  const made = await createCommunityAs(admin, { name: 'News', ...sampleCommunity });
  if (!made.ok) throw new Error(made.reason);
  return { ...world, admin, news: made };
}

const user = (actor: { id: string }) => ({ actorId: actor.id, siteRole: 'user' as const });

describe('findCommunityId', () => {
  test('a bare name is local in any case, name@host is remote, name@<this domain> is the local one', async () => {
    const { instances, news } = await setup();
    const lab = await seedActor(instances.lemmy, 'Group', 'lab');
    const sameName = await seedActor(instances.lemmy, 'Group', 'news');
    expect(await findCommunityId('news')).toBe(news.id);
    expect(await findCommunityId('NEWS')).toBe(news.id);
    expect(await findCommunityId('news@feddit.test')).toBe(news.id);
    expect(await findCommunityId('news@lemmy.test')).toBe(sameName.id);
    expect(await findCommunityId('Lab@Lemmy.Test')).toBe(lab.id);
    for (const handle of ['lab', 'missing', 'lab@feddit.test', 'news@nowhere.test', 'news@', '@lemmy.test', '']) {
      expect(await findCommunityId(handle), handle).toBeNull();
    }
  });
});

describe('readCommunityPage', () => {
  test('a local community: counts held here, moderators, the viewer join state and what they may do', async () => {
    const { people, instances, news } = await setup();
    await seedModerator(news, people.member, { role: 'owner' });
    await seedModerator(news, people.moderator);
    await writer().insert(follows).values({ followerId: people.user.id, followeeId: news.id, state: 'accepted' });
    await seedPost(instances.local, news, people.other);
    await seedPost(instances.local, news, people.other, { removedAt: new Date() });
    await seedPost(instances.local, news, people.other, { deletedAt: new Date() });

    const page = await readCommunityPage({ id: news.id }, user(people.user));
    expect(page).toMatchObject({
      actor: { handle: 'News', local: true },
      postCount: 1,
      subscribers: 1,
      home: 'feddit.test',
      fetchedAt: null,
      followState: 'accepted',
      banned: false,
      canPost: true,
      canModerate: false,
      discoverable: true,
      indexable: true,
    });
    expect(page?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(page?.moderators.map(({ actor, role, state }) => ({ name: actor.name, role, state }))).toEqual([
      { name: 'andrew', role: 'owner', state: 'local' },
      { name: 'ben', role: 'owner', state: 'local' },
      { name: 'olive', role: 'moderator', state: 'local' },
    ]);
    expect(await readCommunityPage({ id: news.id }, null)).toMatchObject({ followState: 'none', canModerate: false });
    expect(await readCommunityPage({ id: news.id }, user(people.moderator))).toMatchObject({ canModerate: true });
    expect(await readCommunityPage({ id: news.id }, { actorId: people.admin.id, siteRole: 'admin' })).toMatchObject({ canModerate: true });
  });

  test('restricted: only the staff may post; a banned viewer may not, and a banned moderator moderates nothing', async () => {
    const { people, admin, news } = await setup();
    await seedModerator(news, people.moderator);
    await updateCommunityAs(admin, news.id, { postingRestrictedToMods: true });
    expect(await readCommunityPage({ id: news.id }, user(people.user))).toMatchObject({ canPost: false });
    expect(await readCommunityPage({ id: news.id }, null)).toMatchObject({ canPost: false });
    expect(await readCommunityPage({ id: news.id }, user(people.moderator))).toMatchObject({ canPost: true, canModerate: true });
    await seedBan(news, people.moderator);
    await seedBan(news, people.user);
    expect(await readCommunityPage({ id: news.id }, user(people.moderator))).toMatchObject({
      banned: true,
      canPost: false,
      canModerate: false,
    });
    expect(await readCommunityPage({ id: news.id }, user(people.user))).toMatchObject({ banned: true });
  });

  test('a remote community: the home host, the refresh time and every moderator row with its state', async () => {
    const { instances } = await setup();
    const fetchedAt = new Date('2026-11-08T10:00:00Z');
    const lab = await seedActor(instances.lemmy, 'Group', 'lab', { fetchedAt, summaryHtml: '<p>Hello</p>' });
    const people = [
      await seedActor(instances.lemmy, 'Person', 'fresh'),
      await seedActor(instances.lemmy, 'Person', 'stale'),
      await seedActor(instances.lemmy, 'Person', 'unknown'),
    ];
    const hour = 3_600_000;
    const rows = [
      { moderatorId: people[0]!.id, verifiedAt: new Date(Date.now() - hour), expiresAt: new Date(Date.now() + hour) },
      { moderatorId: people[1]!.id, verifiedAt: new Date(Date.now() - 20 * hour), expiresAt: new Date(Date.now() - hour) },
      { moderatorId: people[2]!.id, verifiedAt: null, expiresAt: null },
    ];
    for (const row of rows)
      await writer()
        .insert(communityModerators)
        .values({ communityId: lab.id, source: 'remote', ...row });

    const page = await readCommunityPage({ id: lab.id }, null);
    expect(page).toMatchObject({
      actor: { handle: 'lab@lemmy.test', local: false },
      home: 'lemmy.test',
      fetchedAt: fetchedAt.toISOString(),
    });
    expect(page?.moderators.map(({ actor, state }) => [actor.handle, state])).toEqual([
      ['fresh@lemmy.test', 'fresh'],
      ['stale@lemmy.test', 'stale'],
      ['unknown@lemmy.test', 'unknown'],
    ]);
    expect(page?.moderators[2]?.verifiedAt).toBeNull();
  });

  test('a deleted, removed or unknown community reads as absent', async () => {
    const { instances, news } = await setup();
    const gone = await seedActor(instances.local, 'Group', 'gone', { deletedAt: new Date() });
    const closed = await seedActor(instances.local, 'Group', 'closed');
    await seedCommunityRemoval(closed);
    for (const id of [gone.id, closed.id, '0198f3a2-0000-7000-8000-000000000000'] as const)
      expect(await readCommunityPage({ id }, null)).toBeNull();
    expect(await readCommunityPage({ id: news.id }, null)).not.toBeNull();
  });
});

describe('communityGate', () => {
  test('is none for an open community and names the exact gate for a flagged one', async () => {
    const { people, admin, news } = await setup();
    expect(await communityGate(news.id, null, hideNsfw)).toBe('none');
    await updateCommunityAs(admin, news.id, { sensitive: true });
    expect(await communityGate(news.id, null, hideNsfw)).toBe('sign-in');
    expect(await communityGate(news.id, user(people.user), { always: true, once: [] })).toBe('age');
    await writer().insert(ageDeclarations).values({ actorId: people.user.id });
    expect(await communityGate(news.id, user(people.user), hideNsfw)).toBe('hidden');
    expect(await communityGate(news.id, user(people.user), { always: true, once: [] })).toBe('none');
    expect(await communityGate(news.id, user(people.user), { always: false, once: [news.id] })).toBe('none');
    expect(await communityGate('0198f3a2-0000-7000-8000-000000000000', null, hideNsfw)).toBeNull();
  });
});
