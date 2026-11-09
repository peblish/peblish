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

/** Every site setting, each as stored or at its contract default: what the admin settings page shows. */
export type SiteSettings = { [K in SiteSettingKey]: SiteSettingValue<K> };

export async function readSettings(q: Queryable = db()): Promise<SiteSettings> {
  const rows = await q.select({ key: siteSettings.key, value: siteSettings.value }).from(siteSettings);
  const stored = new Map(rows.map(({ key, value }) => [key, value]));
  // One generic step per key keeps each value tied to its own contract.
  const read = <K extends SiteSettingKey>(key: K): SiteSettingValue<K> => {
    const { schema, default: fallback } = contract[key];
    return stored.has(key) ? schema.assert(stored.get(key)) : fallback;
  };
  return {
    'registration.enabled': read('registration.enabled'),
    'remote_media.enabled': read('remote_media.enabled'),
    'inbox.enabled': read('inbox.enabled'),
    'uploads.enabled': read('uploads.enabled'),
    'registration.cap': read('registration.cap'),
    'modlog.trusted_instances': read('modlog.trusted_instances'),
    'site.name': read('site.name'),
    'site.description': read('site.description'),
    'operator.name': read('operator.name'),
    'operator.address': read('operator.address'),
    'operator.jurisdiction': read('operator.jurisdiction'),
    'contact.email': read('contact.email'),
    'posting.enabled': read('posting.enabled'),
    'delivery.enabled': read('delivery.enabled'),
    'remote_nsfw.accepted': read('remote_nsfw.accepted'),
  };
}
