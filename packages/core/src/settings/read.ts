import { siteSettings as contract, type SiteSettingKey, type SiteSettingValue } from '@peblish/schema/site-settings';
import { eq } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { siteSettings } from '../db/tables/site.ts';

// Seeded by G0 so every lane can read the kill switches; lane ADM owns c/settings and is the
// only writer.
/** A site setting's stored value, or its contract default when no row exists. */
export async function readSetting<K extends SiteSettingKey>(key: K, q: Queryable = db()): Promise<SiteSettingValue<K>> {
  const [row] = await q.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, key));
  const { schema, default: fallback } = contract[key];
  return row ? schema.assert(row.value) : fallback;
}
