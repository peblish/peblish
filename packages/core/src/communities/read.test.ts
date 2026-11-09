import { beforeEach, describe, expect, test } from 'vitest';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedCommunityRemoval, seedModerator } from '../testing/seed-az.ts';
import { person, sampleCommunity, seedCommunityWorld } from '../testing/seed-f.ts';
import { seedActor } from '../testing/seed.ts';
import { createCommunityAs } from './create.ts';
import { listLocalCommunities, listModerators, readCommunity } from './read.ts';
import { updateCommunityAs } from './update.ts';

beforeEach(truncateAll);

async function setup() {
  const world = await seedCommunityWorld();
  const admin = person(world.people.admin.id, 'admin');
  const create = async (name: string, input: Partial<Parameters<typeof createCommunityAs>[1]> = {}) => {
    const made = await createCommunityAs(admin, { name, ...input });
    if (!made.ok) throw new Error(made.reason);
    return made;
  };
  return { ...world, admin, create };
}

describe('readCommunity', () => {
  test('a community by id or by name in any case, with rules in order, languages sorted, the warning and the Markdown source', async () => {
    const { people, create } = await setup();
    const news = await create('news', { ...sampleCommunity, sensitive: true, postingRestrictedToMods: true });
    for (const follower of [people.user, people.member]) {
      await writer().insert(follows).values({ followerId: follower.id, followeeId: news.id, state: 'accepted' });
    }
    await writer().insert(follows).values({ followerId: people.other.id, followeeId: news.id, state: 'pending' });

    const byId = await readCommunity({ id: news.id });
    expect(byId).toEqual(await readCommunity({ name: 'NEWS' }));
    expect(byId).toMatchObject({
      actor: {
        id: news.id,
        apId: 'https://feddit.test/ap/c.news',
        kind: 'Group',
        name: 'news',
        displayName: 'Local news',
        local: true,
        handle: 'news',
      },
      summaryMd: sampleCommunity.description,
      sensitive: true,
      nsfl: false,
      postingRestrictedToMods: true,
      postingWarning: 'Read the rules before you post.',
      subscribers: 2,
      languages: ['de', 'en'],
    });
    expect(byId?.summaryHtml).toContain('<strong>matters</strong>');
    expect(byId?.rules.map(({ position, title }) => ({ position, title }))).toEqual([
      { position: 1, title: 'Be civil' },
      { position: 2, title: 'Stay on topic' },
      { position: 3, title: 'No spam' },
    ]);
    expect(byId?.rules[0]?.bodyHtml).toContain('<em>dogpiling</em>');
  });

  test('an imported community keeps the ap_id it was stored with; a remote one reads by id with a name@host handle', async () => {
    const { instances } = await setup();
    const announcements = await seedActor(instances.local, 'Group', 'announcements', {
      apId: 'https://feddit.test/c/announcements',
      importedAt: new Date(),
      summaryHtml: '<p>Imported sidebar</p>',
      iconUrl: 'https://feddit.test/pictrs/icon.png',
    });
    const technology = await seedActor(instances.lemmy, 'Group', 'technology');
    expect(await readCommunity({ name: 'announcements' })).toMatchObject({
      actor: { id: announcements.id, apId: 'https://feddit.test/c/announcements', local: true, handle: 'announcements' },
      summaryHtml: '<p>Imported sidebar</p>',
      summaryMd: null,
      iconUrl: 'https://feddit.test/pictrs/icon.png',
      bannerUrl: null,
      rules: [],
      languages: [],
    });
    expect(await readCommunity({ id: technology.id })).toMatchObject({
      actor: { apId: technology.apId, local: false, handle: 'technology@lemmy.test' },
    });
    expect(await readCommunity({ name: 'technology' })).toBeNull();
  });

  test('a deleted or removed community, a Person and an unknown id read as absent', async () => {
    const { instances, people } = await setup();
    const deleted = await seedActor(instances.local, 'Group', 'gone', { deletedAt: new Date() });
    const removed = await seedActor(instances.local, 'Group', 'closed');
    await seedCommunityRemoval(removed);
    expect(await readCommunity({ id: deleted.id })).toBeNull();
    expect(await readCommunity({ name: 'closed' })).toBeNull();
    expect(await readCommunity({ id: people.user.id })).toBeNull();
    expect(await readCommunity({ id: '0198f3a2-0000-7000-8000-000000000000' })).toBeNull();
  });

  test('reads what an update just wrote', async () => {
    const { admin, create } = await setup();
    const news = await create('news', sampleCommunity);
    await updateCommunityAs(admin, news.id, { postingRestrictedToMods: true, rules: [{ title: 'Only rule' }], languages: ['fr'] });
    expect(await readCommunity({ id: news.id })).toMatchObject({
      postingRestrictedToMods: true,
      languages: ['fr'],
      rules: [{ position: 1, title: 'Only rule', bodyMd: null, bodyHtml: null }],
    });
  });
});

describe('listLocalCommunities', () => {
  test('lists live local communities by name; age-gated ones only when the caller says the viewer may see them', async () => {
    const { instances, create } = await setup();
    await create('news', { postingRestrictedToMods: true });
    await create('art', { sensitive: true });
    await create('Books');
    // An imported community may be flagged NSFL without sensitive (PieFed's two flags are independent).
    await seedActor(instances.local, 'Group', 'adults', {
      apId: 'https://feddit.test/c/adults',
      importedAt: new Date(),
      sensitive: false,
      nsfl: true,
    });
    await seedActor(instances.lemmy, 'Group', 'technology');
    await seedActor(instances.local, 'Group', 'gone', { deletedAt: new Date() });
    await seedCommunityRemoval(await seedActor(instances.local, 'Group', 'closed'));

    const names = (items: Awaited<ReturnType<typeof listLocalCommunities>>) => items.map((item) => item.actor.name);
    expect(names(await listLocalCommunities())).toEqual(['Books', 'news']);
    const all = await listLocalCommunities({ includeSensitive: true });
    expect(names(all)).toEqual(['adults', 'art', 'Books', 'news']);
    expect(
      all.map(({ sensitive, nsfl, postingRestrictedToMods, subscribers }) => ({ sensitive, nsfl, postingRestrictedToMods, subscribers })),
    ).toEqual([
      { sensitive: false, nsfl: true, postingRestrictedToMods: false, subscribers: 0 },
      { sensitive: true, nsfl: false, postingRestrictedToMods: false, subscribers: 0 },
      { sensitive: false, nsfl: false, postingRestrictedToMods: false, subscribers: 0 },
      { sensitive: false, nsfl: false, postingRestrictedToMods: true, subscribers: 0 },
    ]);
    expect(names(await listLocalCommunities({ includeSensitive: true, limit: 2 }))).toEqual(['adults', 'art']);
  });
});

describe('listModerators', () => {
  test('owners first, then in the order appointed; expired, unverified remote and deleted moderators are left out', async () => {
    const { instances, people, create } = await setup();
    const news = await create('news');
    const community = { id: news.id };
    const deleted = await seedActor(instances.local, 'Person', 'deleted_mod', { deletedAt: new Date() });
    const expired = await seedActor(instances.local, 'Person', 'expired_mod');
    await seedModerator(community, people.moderator);
    await seedModerator(community, people.member, { role: 'owner' });
    await seedModerator(community, deleted);
    await seedModerator(community, expired, { expiresAt: new Date(Date.now() - 60_000) });
    await seedModerator(community, people.remoteUser, { source: 'remote', verifiedAt: null, expiresAt: new Date(Date.now() + 3_600_000) });

    const listed = await listModerators(news.id);
    expect(listed.map(({ actor, role }) => ({ name: actor.name, role, handle: actor.handle }))).toEqual([
      { name: 'andrew', role: 'owner', handle: 'andrew' },
      { name: 'ben', role: 'owner', handle: 'ben' },
      { name: 'olive', role: 'moderator', handle: 'olive' },
    ]);

    await seedModerator(community, people.other, { source: 'remote', expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await listModerators(news.id)).map(({ actor }) => actor.name)).toContain('otto');
  });
});
