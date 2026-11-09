import type { Principal } from '@peblish/schema/authz';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { modlog } from '../db/tables/moderation.ts';
import { siteSettings } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, writeCounts } from '../testing/seed-az.ts';
import { person, remote, seedCommunityWorld } from '../testing/seed-f.ts';
import { Refused } from '../tx/refused.ts';
import { readSetting } from './read.ts';
import { invalidSetting, updateSettings, updateSettingsAs } from './write.ts';

beforeEach(truncateAll);

const world = async () => {
  const w = await seedCommunityWorld();
  return { ...w, admin: person(w.people.admin.id, 'admin') };
};
const stored = async (key: string) => (await db().select().from(siteSettings).where(eq(siteSettings.key, key)))[0];

describe('settings.update policy', () => {
  test('only an admin with two-factor is allowed, and each other principal gets its exact reason, before and after the write starts', async () => {
    const { people, admin } = await world();
    const table: [string, Principal, string][] = [
      ['anonymous', { kind: 'anonymous' }, 'auth.required'],
      ['a local user', person(people.user.id), 'auth.admin_required'],
      ['an admin the database has without two-factor', person(people.adminWithoutTwoFactor.id, 'admin'), 'admin.two_factor_required'],
      ['a remote actor', remote(people.remoteUser.id), 'auth.admin_required'],
    ];
    for (const [who, principal, reason] of table)
      expect(await authorize('settings.update', principal, { keys: ['site.name'] }), who).toEqual({ ok: false, reason });
    expect(await authorize('settings.update', admin, { keys: ['site.name'] })).toMatchObject({
      ok: true,
      grant: { authority: { kind: 'site-admin', actorId: people.admin.id } },
    });
  });

  test('an admin whose two-factor went off after authorize() is refused by the recheck, with nothing written', async () => {
    const { people, admin } = await world();
    const grant = await grantFor('settings.update', admin, { keys: ['site.name'] });
    await writer().update(authUser).set({ twoFactorEnabled: false }).where(eq(authUser.id, people.admin.userId!));
    await expect(updateSettings(grant, { 'site.name': 'Feddit' })).rejects.toThrowError(
      new Refused('settings.update', 'auth.admin_required'),
    );
    expect(await stored('site.name')).toBeUndefined();
    expect(await writeCounts()).toEqual({ modlog: 0, outbox: 0 });
  });
});

describe('updateSettings', () => {
  test('a bad value, a bad key or a bad domain is settings.invalid and nothing is written, even next to a good one', async () => {
    const { admin } = await world();
    const bad: [string, Parameters<typeof updateSettingsAs>[1]][] = [
      ['a name over 40 characters', { 'site.name': 'x'.repeat(41) }],
      ['a boolean as text', { 'registration.enabled': 'yes' as never }],
      ['a negative cap', { 'registration.cap': -1 }],
      ['a fractional cap', { 'registration.cap': 2.5 }],
      ['a cap that is not a number', { 'registration.cap': Number.NaN }],
      ['a contact that is not an email', { 'contact.email': 'not an email' }],
      ['a trusted domain with a path', { 'modlog.trusted_instances': ['lemmy.test/x'] }],
      ['a key the contract does not have', { 'no.such_key': true } as never],
    ];
    for (const [why, patch] of bad)
      expect(await updateSettingsAs(admin, { 'site.description': 'fine', ...patch }), why).toEqual({
        ok: false,
        reason: 'settings.invalid',
      });
    expect(await db().select().from(siteSettings)).toEqual([]);
    expect(await writeCounts()).toEqual({ modlog: 0, outbox: 0 });
  });

  test('a patch that changes nothing writes nothing, not even a modlog row or an event', async () => {
    const { admin } = await world();
    expect(await updateSettingsAs(admin, { 'site.name': '', 'registration.enabled': true })).toEqual({
      ok: true,
      changed: [],
      modlogId: null,
    });
    expect(await writeCounts()).toEqual({ modlog: 0, outbox: 0 });
    await updateSettingsAs(admin, { 'site.name': 'Feddit' });
    const before = await stored('site.name');
    expect(await updateSettingsAs(admin, { 'site.name': ' Feddit ' })).toMatchObject({ ok: true, changed: [] });
    expect(await stored('site.name')).toEqual(before);
    expect(await writeCounts()).toEqual({ modlog: 1, outbox: 1 });
  });

  test('a change writes the value, one non-public modlog row with each key before and after, and the event, in one transaction', async () => {
    const { people, admin } = await world();
    const result = await updateSettingsAs(admin, {
      'site.name': 'Feddit',
      'registration.cap': 40,
      'modlog.trusted_instances': [' Lemmy.World ', 'lemmy.world', 'piefed.social'],
      'posting.enabled': true,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.changed).toEqual(['modlog.trusted_instances', 'registration.cap', 'site.name']);
    expect(await readSetting('site.name')).toBe('Feddit');
    expect(await readSetting('modlog.trusted_instances')).toEqual(['lemmy.world', 'piefed.social']);
    expect(await stored('site.name')).toMatchObject({ value: 'Feddit', updatedBy: people.admin.id });
    const rows = await db().select().from(modlog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'settings.update',
      actorId: people.admin.id,
      communityId: null,
      targetActorId: null,
      targetPostId: null,
      targetCommentId: null,
      public: false,
      authority: { kind: 'site-admin', actorId: people.admin.id },
      details: {
        public: false,
        changes: {
          'site.name': { before: '', after: 'Feddit' },
          'registration.cap': { before: 25, after: 40 },
          'modlog.trusted_instances': { before: [], after: ['lemmy.world', 'piefed.social'] },
        },
      },
    });
    expect(await outboxEvents()).toEqual([
      { type: 'settings.updated', v: 1, keys: result.changed, actorId: people.admin.id, modlogId: rows[0]!.id },
    ]);
    const [same] = await db().execute<{ same: boolean }>(
      sql`select (select (tx_id::text::numeric % 4294967296)::text from outbox) = (select xmin::text from modlog) as same`,
    );
    expect(same?.same).toBe(true);
    const [row] = await db().execute<{ same: boolean }>(
      sql`select (select xmin::text from site_settings where key = 'site.name') = (select xmin::text from modlog) as same`,
    );
    expect(row?.same).toBe(true);
  });

  test('a changed key whose row is missing is written from its default, and the log keeps the default as before', async () => {
    const { admin } = await world();
    await updateSettingsAs(admin, { 'uploads.enabled': true });
    const [entry] = await db().select({ details: modlog.details }).from(modlog);
    expect(entry?.details).toMatchObject({ changes: { 'uploads.enabled': { before: false, after: true } } });
  });
});

test('invalidSetting names the first key a patch would be refused for', () => {
  expect(invalidSetting({ 'site.name': 'Feddit', 'registration.cap': 3 })).toBeNull();
  expect(invalidSetting({ 'contact.email': 'nope', 'registration.cap': -2 })).toBe('contact.email');
});
