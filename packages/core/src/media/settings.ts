import { siteSettings as contract } from '@peblish/schema/site-settings';
import { eq } from 'drizzle-orm';
import { forShare } from '../authz/policy.ts';
import type { Queryable } from '../db/read.ts';
import { siteSettings } from '../db/tables/site.ts';

/**
 * A kill switch's value, read FOR SHARE under `lock` so that flipping it waits for a write in
 * flight (or the write's recheck sees the new value).
 */
export async function switchedOn(db: Queryable, key: 'uploads.enabled' | 'remote_media.enabled', lock: boolean): Promise<boolean> {
  const [row] = await forShare(db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, key)), lock);
  return row ? contract[key].schema.assert(row.value) : contract[key].default;
}
