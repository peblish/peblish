import { siteSettings as contract, type SiteSettingKey, type SiteSettingValue } from '@peblish/schema/site-settings';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { siteSettings } from '../db/tables/site.ts';

// Seeded by G0 so every lane can read the kill switches; lane ADM owns c/settings and is the
// only writer.
/**
 * Keys every page draws (the shell reads them on each document): a stored value that fails the contract is read
 * as the default rather than thrown, so one bad row cannot take every page down; readSettingsChecked names it for
 * the admin page. Every other key refuses a bad value, as before.
 */
const presentational: ReadonlySet<SiteSettingKey> = new Set(['site.banner', 'site.width']);

/** The stored value checked against its contract: null when it fails and the key falls back to its default. */
function checkedValue<K extends SiteSettingKey>(key: K, value: unknown): SiteSettingValue<K> | null {
  const { schema } = contract[key];
  if (!presentational.has(key)) return schema.assert(value);
  const result = schema(value);
  return result instanceof type.errors ? null : result;
}

/** A site setting's stored value, or its contract default when no row exists (or, for the banner and the width, when the row is unreadable). */
export async function readSetting<K extends SiteSettingKey>(key: K, q: Queryable = db()): Promise<SiteSettingValue<K>> {
  const [row] = await q.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, key));
  return (row && checkedValue(key, row.value)) ?? contract[key].default;
}

/** Every site setting, each as stored or at its contract default: what the admin settings page shows. */
export type SiteSettings = { [K in SiteSettingKey]: SiteSettingValue<K> };

export async function readSettings(q: Queryable = db()): Promise<SiteSettings> {
  return (await readSettingsChecked(q)).values;
}

/** Every site setting, and the keys whose stored row was unreadable and is shown at its default (in sorted order). */
export async function readSettingsChecked(q: Queryable = db()): Promise<{ values: SiteSettings; unreadable: SiteSettingKey[] }> {
  const rows = await q.select({ key: siteSettings.key, value: siteSettings.value }).from(siteSettings);
  const stored = new Map(rows.map(({ key, value }) => [key, value]));
  const unreadable: SiteSettingKey[] = [];
  // One generic step per key keeps each value tied to its own contract.
  const read = <K extends SiteSettingKey>(key: K): SiteSettingValue<K> => {
    if (!stored.has(key)) return contract[key].default;
    const value = checkedValue(key, stored.get(key));
    if (value !== null) return value;
    unreadable.push(key);
    return contract[key].default;
  };
  const values: SiteSettings = {
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
    'site.brand': read('site.brand'),
    'site.width': read('site.width'),
    'site.banner': read('site.banner'),
  };
  return { values, unreadable: unreadable.sort() };
}
