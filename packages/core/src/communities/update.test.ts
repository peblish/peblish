import type { Principal } from '@peblish/schema/authz';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { actors, communityLanguages } from '../db/tables/actors.ts';
import { communityModerators, modlog } from '../db/tables/moderation.ts';
import { outbox } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { readModlog } from '../modlog/read.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedCommunityRemoval, seedModerator } from '../testing/seed-az.ts';
import { person, remote, sampleCommunity, seedCommunityWorld } from '../testing/seed-f.ts';
import { seedActor } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { createCommunityAs } from './create.ts';
import { communityRules } from './tables.ts';
import { updateCommunity, updateCommunityAs } from './update.ts';

beforeEach(truncateAll);

/** The cast, a community made by the admin, its owner and moderator (not admins), and every principal's view of it. */
async function setup() {
  const world = await seedCommunityWorld();
  const { people } = world;
  const admin = person(people.admin.id, 'admin');
  const made = await createCommunityAs(admin, { name: 'news', ...sampleCommunity });
  if (!made.ok) throw new Error(made.reason);
  const community = { id: made.id };
  await seedModerator(community, people.member, { role: 'owner' });
  await seedModerator(community, people.moderator);
  await writer().delete(outbox); // the create's event is not under test here
  return { ...world, admin, community };
}

const row = async (id: string) => (await db().select().from(actors).where(eq(actors.id, id)))[0]!;

describe('community.update policy', () => {
  test('the owner, a moderator and a site admin are allowed; everyone else gets the exact reason', async () => {
    const { people, admin, community } = await setup();
    const subject = { communityId: community.id };
    const refused: [string, Principal, string][] = [
      ['anonymous', { kind: 'anonymous' }, 'auth.required'],
      ['a local user', person(people.user.id), 'mod.moderator_required'],
      ['an admin without two-factor, as the session reports it', person(people.adminWithoutTwoFactor.id), 'mod.moderator_required'],
      ['a remote actor', remote(people.remoteUser.id), 'auth.required'],
    ];
    for (const [who, principal, reason] of refused)
      expect(await authorize('community.update', principal, subject), who).toEqual({ ok: false, reason });

    const allowed: [string, Principal, object][] = [
      ['the owner', person(people.member.id), { kind: 'local-role', actorId: people.member.id, role: 'owner', communityId: community.id }],
      [
        'a moderator',
        person(people.moderator.id),
        { kind: 'local-role', actorId: people.moderator.id, role: 'moderator', communityId: community.id },
      ],
      ['an admin with two-factor', admin, { kind: 'site-admin', actorId: people.admin.id }],
    ];
    for (const [who, principal, authority] of allowed) {
      expect(await authorize('community.update', principal, subject), who).toMatchObject({ ok: true, grant: { authority } });
    }
  });

  test('only a live local community can be edited here', async () => {
    const { instances, people, admin, community } = await setup();
    const technology = await seedActor(instances.lemmy, 'Group', 'technology');
    const deleted = await seedActor(instances.local, 'Group', 'gone', { deletedAt: new Date() });
    const removed = await seedActor(instances.local, 'Group', 'closed');
    await seedCommunityRemoval(removed);
    const table: [string, string, string][] = [
      ['a remote community', technology.id, 'community.not_local'],
      ['a deleted community', deleted.id, 'community.deleted'],
      ['a removed community', removed.id, 'community.removed'],
      ['a Person', people.user.id, 'target.not_found'],
      ['no such actor', '0198f3a2-0000-7000-8000-000000000000', 'target.not_found'],
    ];
    for (const [what, communityId, reason] of table) {
      expect(await authorize('community.update', admin, { communityId }), what).toEqual({ ok: false, reason });
    }
    expect(await authorize('community.update', admin, { communityId: community.id })).toMatchObject({ ok: true });
  });
});

describe('community.update', () => {
  test('a patch changes the fields it names and keeps the rest, the name and the ap_id included', async () => {
    const { people, community } = await setup();
    const before = await row(community.id);
    const result = await updateCommunityAs(person(people.moderator.id), community.id, { postingRestrictedToMods: true });
    expect(result).toEqual({ ok: true });
    const after = await row(community.id);
    expect(after).toMatchObject({
      name: 'news',
      apId: before.apId,
      displayName: before.displayName,
      summaryMd: before.summaryMd,
      summaryHtml: before.summaryHtml,
      postingWarning: before.postingWarning,
      sensitive: false,
      postingRestrictedToMods: true,
    });
    expect(before.updatedAt).toBeNull();
    expect(after.updatedAt).toBeInstanceOf(Date);
    const languages = await db().select({ language: communityLanguages.language }).from(communityLanguages);
    expect(languages.map((entry) => entry.language).sort()).toEqual(['de', 'en']);
    expect(await db().select({ title: communityRules.title }).from(communityRules)).toHaveLength(3);
  });

  test('every field can change: Markdown re-rendered, null clears, languages and rules replaced in the order given', async () => {
    const { people, community } = await setup();
    const result = await updateCommunityAs(person(people.member.id), community.id, {
      displayName: null,
      description: 'Now with a [link](https://example.test/).',
      sensitive: true,
      postingWarning: null,
      languages: ['fr'],
      rules: [{ title: 'Second', body: '**bold**' }, { title: 'First' }],
    });
    expect(result).toEqual({ ok: true });
    expect(await row(community.id)).toMatchObject({
      displayName: null,
      summaryMd: 'Now with a [link](https://example.test/).',
      sensitive: true,
      postingWarning: null,
    });
    expect((await row(community.id)).summaryHtml).toContain('<a href="https://example.test/"');
    expect(await db().select({ language: communityLanguages.language }).from(communityLanguages)).toEqual([{ language: 'fr' }]);
    const rules = await db().select().from(communityRules).orderBy(communityRules.position);
    expect(
      rules.map(({ position, title, bodyHtml }) => ({ position, title, hasHtml: bodyHtml?.includes('<strong>bold</strong>') ?? false })),
    ).toEqual([
      { position: 1, title: 'Second', hasHtml: true },
      { position: 2, title: 'First', hasHtml: false },
    ]);

    await updateCommunityAs(person(people.member.id), community.id, { description: null, rules: [], languages: [] });
    expect(await row(community.id)).toMatchObject({ summaryMd: null, summaryHtml: null });
    expect(await db().select().from(communityRules)).toEqual([]);
    expect(await db().select().from(communityLanguages)).toEqual([]);
  });

  test('not safe for life keeps the age gate on, whichever of the two a later patch names', async () => {
    const { people, community } = await setup();
    const owner = person(people.member.id);
    await updateCommunityAs(owner, community.id, { nsfl: true });
    expect(await row(community.id)).toMatchObject({ sensitive: true, nsfl: true });
    await updateCommunityAs(owner, community.id, { sensitive: false });
    expect(await row(community.id)).toMatchObject({ sensitive: true, nsfl: true });
    await updateCommunityAs(owner, community.id, { nsfl: false, sensitive: false });
    expect(await row(community.id)).toMatchObject({ sensitive: false, nsfl: false });
  });

  test('emits actor.updated for the Group in the update transaction', async () => {
    const { people, community } = await setup();
    await updateCommunityAs(person(people.moderator.id), community.id, { displayName: 'Renamed' });
    expect(await outboxEvents()).toEqual([{ type: 'actor.updated', v: 1, actorId: community.id, kind: 'Group', local: true }]);
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox) = (select xmin::text from actors where id = ${community.id}) as same`,
    );
    expect(same?.same).toBe(true);
  });

  test('logs each edit in the modlog under whoever made it, in the update transaction', async () => {
    const { people, admin, community } = await setup();
    await updateCommunityAs(person(people.member.id), community.id, { displayName: 'By the owner' });
    await updateCommunityAs(person(people.moderator.id), community.id, { postingWarning: null });
    await updateCommunityAs(admin, community.id, { rules: [] });
    const edits = await readModlog({ communityId: community.id, action: 'community.update' }, { audience: 'public' });
    expect(
      edits.map(({ actorId, authority, communityApId, targetActorId, reason }) => ({
        actorId,
        authority,
        communityApId,
        targetActorId,
        reason,
      })),
    ).toEqual([
      {
        actorId: people.admin.id,
        authority: { kind: 'site-admin', actorId: people.admin.id },
        communityApId: 'https://feddit.test/ap/c.news',
        targetActorId: null,
        reason: null,
      },
      {
        actorId: people.moderator.id,
        authority: { kind: 'local-role', actorId: people.moderator.id, role: 'moderator', communityId: community.id },
        communityApId: 'https://feddit.test/ap/c.news',
        targetActorId: null,
        reason: null,
      },
      {
        actorId: people.member.id,
        authority: { kind: 'local-role', actorId: people.member.id, role: 'owner', communityId: community.id },
        communityApId: 'https://feddit.test/ap/c.news',
        targetActorId: null,
        reason: null,
      },
    ]);
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select xmin::text from modlog where id = ${edits[0]!.id}) = (select xmin::text from actors where id = ${community.id}) as same`,
    );
    expect(same?.same).toBe(true);
  });

  test('discoverable and indexable can be set, and the modlog row names only the fields that changed', async () => {
    const { people, community } = await setup();
    const owner = person(people.member.id);
    expect(await row(community.id)).toMatchObject({ discoverable: true, indexable: true });
    // The form sends everything: only the differing fields are logged, in a stable order.
    await updateCommunityAs(owner, community.id, {
      displayName: 'Local news',
      description: 'A new sidebar',
      sensitive: false,
      postingRestrictedToMods: true,
      postingWarning: 'Read the rules before you post.',
      discoverable: false,
      indexable: true,
      languages: ['de', 'en'],
      rules: [{ title: 'Be civil', body: 'Changed' }, { title: 'Stay on topic' }, { title: 'No spam' }],
    });
    expect(await row(community.id)).toMatchObject({ discoverable: false, indexable: true, postingRestrictedToMods: true });
    await updateCommunityAs(owner, community.id, { displayName: 'Local news' });
    const entries = await db().select({ details: modlog.details }).from(modlog).orderBy(modlog.createdAt);
    expect(entries.at(-2)?.details).toEqual({ fields: ['postingRestrictedToMods', 'discoverable', 'description', 'rules'] });
    expect(entries.at(-1)?.details).toEqual({ fields: [] });
  });

  test('a moderator removed after authorize() is refused by the recheck, with nothing written', async () => {
    const { people, community } = await setup();
    const grant = await grantFor('community.update', person(people.moderator.id), { communityId: community.id });
    await writer().delete(communityModerators).where(eq(communityModerators.moderatorId, people.moderator.id));
    await expect(updateCommunity(grant, { displayName: 'Too late' })).rejects.toThrowError(
      new Refused('community.update', 'mod.moderator_required'),
    );
    expect((await row(community.id)).displayName).toBe('Local news');
    expect(await readModlog({ communityId: community.id, action: 'community.update' }, { audience: 'staff' })).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });

  test('a patch outside the limits is community.invalid and changes nothing', async () => {
    const { people, community } = await setup();
    expect(await updateCommunityAs(person(people.member.id), community.id, { languages: ['english'] })).toEqual({
      ok: false,
      reason: 'community.invalid',
    });
    expect(await readModlog({ communityId: community.id, action: 'community.update' }, { audience: 'staff' })).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });
});
