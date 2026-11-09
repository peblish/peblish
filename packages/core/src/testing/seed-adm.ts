import { ModlogDetails } from '@peblish/schema/modlog';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { modlog } from '../db/tables/moderation.ts';
import { siteSettings } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { pageRevisions, pages } from '../pages/tables.ts';
import { PASSWORD, seedAccount, seedTwoFactor } from './seed-a.ts';

// Lane ADM's seed, a CLI for the e2e run (`node packages/core/src/testing/seed-adm.ts e2e | e2e-pages | e2e-switches`).
// Test code only.

/** The settings the Settings spec saves, and those the Pages spec fills: back to their contract defaults (a missing row is the default). */
const savedBySettingsSpec = ['site.name', 'site.description', 'modlog.trusted_instances', 'remote_nsfw.accepted'] as const;
const filledByPagesSpec = ['operator.name', 'operator.address', 'operator.jurisdiction', 'contact.email'] as const;

async function resetSettings(keys: readonly string[]): Promise<void> {
  await writer()
    .delete(siteSettings)
    .where(inArray(siteSettings.key, [...keys]));
}

/**
 * No pages and no revisions: the state a fresh instance starts in. Revisions are append-only
 * (trigger in 0009); a lane database may be emptied, so the guard is suspended for the delete.
 */
async function resetPages(): Promise<void> {
  await writer().transaction(async (t) => {
    await t.update(pages).set({ publishedRevision: null });
    await t.execute(sql`alter table page_revisions disable trigger page_revisions_append_only`);
    await t.delete(pageRevisions);
    await t.execute(sql`alter table page_revisions enable trigger page_revisions_append_only`);
    await t.delete(pages);
  });
}

/**
 * An admin for the ADM specs: their own account (not lane A's e2e admin, whose two-factor secret
 * the auth specs reset), created once, with two-factor on under a known secret on every run. Each
 * spec file has its own, because the server takes a TOTP code once per 30-second step and the
 * files run side by side.
 */
async function seedAdmin(name: string, secretKey: string) {
  const [existing] = await db().select({ userId: actors.userId }).from(actors).where(eq(actors.name, name));
  const userId = existing?.userId ?? (await seedAccount(name, { role: 'admin' })).userId;
  const { secret, backupCodes } = await seedTwoFactor(userId, secretKey);
  return { name, email: `${name}@example.test`, password: PASSWORD, totpSecret: secret, backupCodes };
}

/** A member with no admin role, for the specs that check the admin pages turn them away. */
export async function seedAdmMember() {
  const name = 'adm_member';
  const find = async () => (await db().select({ id: actors.id }).from(actors).where(eq(actors.name, name)))[0];
  if (!(await find())) {
    // Both ADM spec files seed side by side: on a fresh database the other may have made it first.
    await seedAccount(name).catch(async (error: unknown) => {
      if (!(await find())) throw error;
    });
  }
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
      await resetSettings(savedBySettingsSpec);
      console.log(
        JSON.stringify({ admin: await seedAdmin('adm_admin', 'peblish-e2e-adm-totp-secret-0123'), member: await seedAdmMember() }),
      );
    } else if (command === 'e2e-pages') {
      await resetSettings(filledByPagesSpec);
      await resetPages();
      console.log(
        JSON.stringify({ admin: await seedAdmin('adm_pages_admin', 'peblish-e2e-adm-pages-secret-01'), member: await seedAdmMember() }),
      );
    } else if (command === 'e2e-switches') {
      console.log(JSON.stringify({ admin: await seedAdmin('adm_switch_admin', 'peblish-e2e-adm-switch-secret-01') }));
    } else if (command === 'settings-log') console.log(JSON.stringify(await settingsLog()));
    else throw new Error('usage: node packages/core/src/testing/seed-adm.ts e2e | e2e-pages | e2e-switches | settings-log');
  } finally {
    await closePools();
  }
}
