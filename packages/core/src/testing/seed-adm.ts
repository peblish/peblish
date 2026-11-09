import { ModlogDetails } from '@peblish/schema/modlog';
import { asc, eq, inArray } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { modlog } from '../db/tables/moderation.ts';
import { siteSettings } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { PASSWORD, seedAccount, seedTwoFactor } from './seed-a.ts';

// Lane ADM's seed, a CLI for the e2e run (`node packages/core/src/testing/seed-adm.ts e2e`).
// Test code only.

/** The settings the admin specs save, back to their contract defaults (a missing row is the default). */
const savedBySpecs = [
  'site.name',
  'site.description',
  'operator.name',
  'operator.address',
  'operator.jurisdiction',
  'contact.email',
  'modlog.trusted_instances',
  'remote_nsfw.accepted',
] as const;

export async function resetAdminSettings(): Promise<void> {
  await writer()
    .delete(siteSettings)
    .where(inArray(siteSettings.key, [...savedBySpecs]));
}

/**
 * The admin of the ADM specs: their own account (not lane A's e2e admin, whose two-factor secret
 * the auth specs reset), created once, with two-factor on under a known secret on every run.
 */
export async function seedAdmAdmin() {
  const name = 'adm_admin';
  const [existing] = await db().select({ userId: actors.userId }).from(actors).where(eq(actors.name, name));
  const userId = existing?.userId ?? (await seedAccount(name, { role: 'admin' })).userId;
  const { secret, backupCodes } = await seedTwoFactor(userId, 'peblish-e2e-adm-totp-secret-0123');
  return { name, email: `${name}@example.test`, password: PASSWORD, totpSecret: secret, backupCodes };
}

/** A member with no admin role, for the specs that check the admin pages turn them away. */
export async function seedAdmMember() {
  const name = 'adm_member';
  const [existing] = await db().select({ id: actors.id }).from(actors).where(eq(actors.name, name));
  if (!existing) await seedAccount(name);
  return { name, password: PASSWORD };
}

/** The changes each settings.update modlog row recorded, oldest first, with whether the row is public. */
export async function settingsLog() {
  const rows = await db()
    .select({ details: modlog.details, public: modlog.public })
    .from(modlog)
    .where(eq(modlog.action, 'settings.update'))
    .orderBy(asc(modlog.createdAt));
  return rows.map(({ details, public: isPublic }) => ({ changes: ModlogDetails.assert(details).changes ?? {}, public: isPublic }));
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') {
      await resetAdminSettings();
      console.log(JSON.stringify({ admin: await seedAdmAdmin(), member: await seedAdmMember() }));
    } else if (command === 'settings-log') console.log(JSON.stringify(await settingsLog()));
    else throw new Error('usage: node packages/core/src/testing/seed-adm.ts e2e | settings-log');
  } finally {
    await closePools();
  }
}
