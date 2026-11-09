import { createSign, createVerify } from 'node:crypto';
import type { Principal } from '@peblish/schema/authz';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { newRsaKeyPair } from '../actor-keys.ts';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actorKeys, actors, communityLanguages } from '../db/tables/actors.ts';
import { authUser } from '../db/tables/auth.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedModerator } from '../testing/seed-az.ts';
import { person, remote, sampleCommunity, seedCommunityWorld } from '../testing/seed-f.ts';
import { seedActor } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { createCommunity, createCommunityAs } from './create.ts';
import { communityRules } from './tables.ts';

beforeEach(truncateAll);

const world = async () => {
  const w = await seedCommunityWorld();
  return { ...w, admin: person(w.people.admin.id, 'admin') };
};

/** Creates a community as the admin, or fails the test with the refusal. */
async function created(principal: Principal, input: Parameters<typeof createCommunityAs>[1]) {
  const result = await createCommunityAs(principal, input);
  if (!result.ok) throw new Error(`community.create refused: ${result.reason}`);
  return result;
}

describe('community.create policy', () => {
  test('only a site admin with two-factor is allowed, and each other principal gets its exact reason', async () => {
    const { instances, people, admin } = await world();
    const elsewhere = await seedActor(instances.local, 'Group', 'elsewhere');
    await seedModerator(elsewhere, people.moderator, { role: 'owner' });
    const table: [string, Principal, string][] = [
      ['anonymous', { kind: 'anonymous' }, 'auth.required'],
      ['a local user', person(people.user.id), 'auth.admin_required'],
      ['the owner of another community', person(people.moderator.id), 'auth.admin_required'],
      ['an admin the database has without two-factor', person(people.adminWithoutTwoFactor.id, 'admin'), 'admin.two_factor_required'],
      ['a remote actor', remote(people.remoteUser.id), 'auth.admin_required'],
    ];
    for (const [who, principal, reason] of table) {
      expect(await authorize('community.create', principal, { name: 'news' }), who).toEqual({ ok: false, reason });
    }
    const allowed = await authorize('community.create', admin, { name: 'news' });
    expect(allowed).toMatchObject({ ok: true, grant: { authority: { kind: 'site-admin', actorId: people.admin.id } } });
  });

  test('names follow the other new local actors: valid, not reserved, free in any case among Groups and Persons', async () => {
    const { people, admin } = await world();
    await created(admin, { name: 'news' });
    const table: [string, string][] = [
      ['', 'name.invalid'],
      ['two words', 'name.invalid'],
      ['x'.repeat(51), 'name.invalid'],
      ['naïve', 'name.invalid'],
      ['Admin', 'name.reserved'],
      ['NEWS', 'name.taken'],
      [people.user.name.toUpperCase(), 'name.taken'],
    ];
    for (const [name, reason] of table) {
      expect(await authorize('community.create', admin, { name }), name).toEqual({ ok: false, reason });
    }
    expect(await createCommunityAs(admin, { name: 'News' })).toEqual({ ok: false, reason: 'name.taken' });
  });

  test('two creates of one name at once: one succeeds, the other is refused with name.taken', async () => {
    const { admin } = await world();
    const results = await Promise.all([createCommunityAs(admin, { name: 'race' }), createCommunityAs(admin, { name: 'RACE' })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'name.taken' }]);
    expect(
      await db()
        .select({ id: actors.id })
        .from(actors)
        .where(sql`lower(${actors.name}) = 'race'`),
    ).toHaveLength(1);
  });
});

describe('community.create', () => {
  test('writes the Group with its endpoints, sidebar, languages, rules in order and the admin as owner, and emits actor.created in the same transaction', async () => {
    const { people, admin } = await world();
    const community = await created(admin, { name: 'news', ...sampleCommunity, sensitive: true });
    expect(community).toMatchObject({ name: 'news', apId: 'https://feddit.test/ap/c.news' });

    const [row] = await db().select().from(actors).where(eq(actors.id, community.id));
    expect(row).toMatchObject({
      kind: 'Group',
      local: true,
      raw: null,
      userId: null,
      name: 'news',
      displayName: 'Local news',
      apId: 'https://feddit.test/ap/c.news',
      inboxUrl: 'https://feddit.test/ap/c.news/inbox',
      outboxUrl: 'https://feddit.test/ap/c.news/outbox',
      followersUrl: 'https://feddit.test/ap/c.news/followers',
      sharedInboxUrl: 'https://feddit.test/inbox',
      featuredUrl: 'https://feddit.test/ap/c.news/featured',
      moderatorsUrl: 'https://feddit.test/ap/c.news/moderators',
      summaryMd: sampleCommunity.description,
      sensitive: true,
      nsfl: false,
      postingRestrictedToMods: false,
      postingWarning: 'Read the rules before you post.',
    });
    expect(row?.summaryHtml).toContain('<strong>matters</strong>');
    expect(row?.publishedAt).toBeInstanceOf(Date);

    const languages = await db().select({ language: communityLanguages.language }).from(communityLanguages);
    expect(languages.map((entry) => entry.language).sort()).toEqual(['de', 'en']);

    const rules = await db()
      .select()
      .from(communityRules)
      .where(eq(communityRules.communityId, community.id))
      .orderBy(communityRules.position);
    expect(rules.map(({ position, title, bodyMd }) => ({ position, title, bodyMd }))).toEqual([
      { position: 1, title: 'Be civil', bodyMd: 'No harassment, slurs or *dogpiling*.' },
      { position: 2, title: 'Stay on topic', bodyMd: null },
      { position: 3, title: 'No spam', bodyMd: null },
    ]);
    expect(rules[0]?.bodyHtml).toContain('<em>dogpiling</em>');
    expect(rules[1]?.bodyHtml).toBeNull();

    const moderators = await db().select().from(communityModerators).where(eq(communityModerators.communityId, community.id));
    expect(moderators).toMatchObject([{ moderatorId: people.admin.id, role: 'owner', source: 'local', expiresAt: null }]);
    expect(moderators[0]?.verifiedAt).toBeInstanceOf(Date);

    expect(await outboxEvents()).toEqual([{ type: 'actor.created', v: 1, actorId: community.id, kind: 'Group', local: true }]);
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox) = (select xmin::text from actors where id = ${community.id}) as same`,
    );
    expect(same?.same).toBe(true);
  });

  test('stores an RSA signing key under <ap_id>#main-key that signs and verifies', async () => {
    const { admin } = await world();
    const community = await created(admin, { name: 'news' });
    const [key] = await db().select().from(actorKeys).where(eq(actorKeys.actorId, community.id));
    expect(key).toMatchObject({ keyId: 'https://feddit.test/ap/c.news#main-key', algorithm: 'rsa' });
    const signature = createSign('sha256').update('(request-target): post /inbox').sign(key!.privateKeyPem!);
    expect(createVerify('sha256').update('(request-target): post /inbox').verify(key!.publicKeyPem, signature)).toBe(true);
  });

  test('a defaults-only create is open to everyone and carries no age gate', async () => {
    const { admin } = await world();
    const community = await created(admin, { name: 'plain' });
    const [row] = await db().select().from(actors).where(eq(actors.id, community.id));
    expect(row).toMatchObject({
      displayName: null,
      summaryMd: null,
      summaryHtml: null,
      sensitive: false,
      nsfl: false,
      postingRestrictedToMods: false,
      postingWarning: null,
    });
  });

  test('not safe for life implies the age gate', async () => {
    const { admin } = await world();
    const community = await created(admin, { name: 'dark', nsfl: true, sensitive: false });
    const [row] = await db().select({ sensitive: actors.sensitive, nsfl: actors.nsfl }).from(actors).where(eq(actors.id, community.id));
    expect(row).toEqual({ sensitive: true, nsfl: true });
  });

  test.each([
    ['sixteen rules', { rules: Array.from({ length: 16 }, (_, index) => ({ title: `Rule ${index}` })) }],
    ['a rule without a title', { rules: [{ title: '   ' }] }],
    ['an upper-case language', { languages: ['EN'] }],
    ['a blank display name', { displayName: '  ' }],
    ['a sidebar over 10,000 characters', { description: 'x'.repeat(10_001) }],
    ['a posting warning over 500 characters', { postingWarning: 'x'.repeat(501) }],
  ])('%s is community.invalid and writes nothing', async (_, fields) => {
    const { admin } = await world();
    expect(await createCommunityAs(admin, { name: 'bad', ...fields })).toEqual({ ok: false, reason: 'community.invalid' });
    expect(await db().select({ id: actors.id }).from(actors).where(eq(actors.name, 'bad'))).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });

  test('an admin whose two-factor went off after authorize() is refused by the recheck, with nothing written', async () => {
    const { people, admin } = await world();
    const grant = await grantFor('community.create', admin, { name: 'late' });
    await writer().update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, people.admin.userId!));
    const keys = await newRsaKeyPair();
    await expect(createCommunity(grant, { fields: {}, keys })).rejects.toThrowError(new Refused('community.create', 'auth.admin_required'));
    expect(await db().select({ id: actors.id }).from(actors).where(eq(actors.name, 'late'))).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });
});
