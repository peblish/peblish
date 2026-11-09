import { siteSettings as contract } from '@peblish/schema/site-settings';
import { and, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { forShare } from '../authz/policy.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { siteSettings } from '../db/tables/site.ts';

/** The beta cap on accounts (decision 2026-11-08: default 25, the admin raises it through ADM). */
export const REGISTRATION_CAP_KEY = 'registration.cap';

/**
 * The registration kill switch and the cap, read FOR SHARE under `lock` so flipping either
 * waits for a registration in flight (or the registration's recheck sees the new value).
 */
export async function registrationSettings(q: Queryable, lock = false): Promise<{ enabled: boolean; cap: number }> {
  const rows = await forShare(
    q
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(inArray(siteSettings.key, ['registration.enabled', REGISTRATION_CAP_KEY]))
      // Key order by code point, as the settings writer (settings/write.ts) sorts and locks them, so the two cannot deadlock.
      .orderBy(sql`${siteSettings.key} collate "C"`),
    lock,
  );
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const enabled = value('registration.enabled');
  const cap = value(REGISTRATION_CAP_KEY);
  return {
    enabled: enabled === undefined ? contract['registration.enabled'].default : contract['registration.enabled'].schema.assert(enabled),
    cap: cap === undefined ? contract[REGISTRATION_CAP_KEY].default : contract[REGISTRATION_CAP_KEY].schema.assert(cap),
  };
}

/** Accounts the cap counts: local people with a login who have not deleted it. */
export async function accountCount(q: Queryable): Promise<number> {
  const [row] = await q
    .select({ n: count() })
    .from(actors)
    .where(and(eq(actors.local, true), eq(actors.kind, 'Person'), isNotNull(actors.userId), isNull(actors.deletedAt)));
  return row?.n ?? 0;
}

/** The admin invites page's header: the kill switch, the cap and how many accounts count toward it. */
export async function registrationOverview(): Promise<{ enabled: boolean; cap: number; accounts: number }> {
  const [settings, accounts] = await Promise.all([registrationSettings(db()), accountCount(db())]);
  return { ...settings, accounts };
}
