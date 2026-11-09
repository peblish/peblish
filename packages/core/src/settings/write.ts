import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { siteSettings as contract, type SiteSettingKey, type SiteSettingValue } from '@peblish/schema/site-settings';
import { type } from 'arktype';
import { eq, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { authorize } from '../authz/authorize.ts';
import { siteSettings } from '../db/tables/site.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';

/** Some keys of the site settings contract, each with a value of that key's type. */
export type SettingsPatch = { [K in SiteSettingKey]?: SiteSettingValue<K> };

const isKey = (key: string): key is SiteSettingKey => Object.hasOwn(contract, key);

// A host as instances.domain stores it: lowercase labels, an optional port for lab hosts.
const DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/**
 * The value as stored: text trimmed, and the trusted instances as lowercase, unique domains.
 * What cannot be normalised passes through for the contract schema to refuse.
 */
function normalised(key: SiteSettingKey, value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (key === 'modlog.trusted_instances' && Array.isArray(value))
    return [...new Set(value.map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : entry)))];
  return value;
}

/** Each patched key checked against its contract, or null for an unknown key or a value that fails it. */
function checked(patch: SettingsPatch): [SiteSettingKey, unknown][] | null {
  const entries: [SiteSettingKey, unknown][] = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!isKey(key)) return null;
    const value = normalised(key, raw);
    if (contract[key].schema(value) instanceof type.errors) return null;
    if (key === 'modlog.trusted_instances' && !(value as string[]).every((domain) => DOMAIN.test(domain))) return null;
    entries.push([key, value]);
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * Changes site settings: the only writer of `site_settings`. The keys come from the grant's
 * subject, in sorted order so two admins saving at once take their locks the same way round;
 * a key with no row first gets its default (on conflict do nothing), so there is always a row
 * to lock. Locking the row waits for a kill-switch reader that holds it FOR SHARE (a write in
 * flight, see media/settings.ts and registration/settings.ts), and a reader that comes later
 * sees the new value. A patch that changes nothing writes nothing. A change writes one modlog
 * row (settings.update, no community or target, not public) with each changed key's value
 * before and after, and settings.updated, in the same transaction.
 */
export const updateSettings = defineMutation({
  action: 'settings.update',
  emits: ['settings.updated'],
  recheck: true,
  async run(t, grant, patch: SettingsPatch) {
    const entries = checked(patch);
    const keys = new Set(grant.subject.keys);
    if (!entries || entries.length !== keys.size || !entries.every(([key]) => keys.has(key)))
      throw new Refused('settings.update', 'settings.invalid');
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, after] of entries) {
      await t.db.insert(siteSettings).values({ key, value: contract[key].default }).onConflictDoNothing();
      const [row] = await t.db
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, key))
        .for('no key update');
      if (!row || isDeepStrictEqual(row.value, after)) continue;
      await t.db
        .update(siteSettings)
        .set({ value: after, updatedBy: grant.actorId, updatedAt: sql`now()` })
        .where(eq(siteSettings.key, key));
      changes[key] = { before: row.value, after };
    }
    const changed = Object.keys(changes).filter(isKey);
    if (changed.length === 0) return { changed, modlogId: null };
    const modlogId = await writeModlog(t.db, grant, { community: null, target: null, reason: null, details: { public: false, changes } });
    await t.emit({ type: 'settings.updated', v: 1, keys: changed, actorId: grant.actorId, modlogId });
    return { changed, modlogId };
  },
});

/**
 * settings.update for web: authorize first, so only an admin with two-factor learns whether
 * a value is acceptable, then `settings.invalid` for an unknown key or a bad value, and write.
 */
export async function updateSettingsAs(
  principal: Principal,
  patch: SettingsPatch,
): Promise<Result<{ changed: SiteSettingKey[]; modlogId: Uuid | null }>> {
  const decision = await authorize('settings.update', principal, { keys: Object.keys(patch).sort() });
  if (!decision.ok) return decision;
  if (!checked(patch)) return { ok: false, reason: 'settings.invalid' };
  return refusedAsResult(() => updateSettings(decision.grant, patch));
}
