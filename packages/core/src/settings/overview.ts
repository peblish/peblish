import { localHandles } from '../identity/handles.ts';
import { accountCount } from '../registration/settings.ts';
import { db } from '../db/read.ts';
import { readSettingsChecked } from './read.ts';

/**
 * What the admin settings page shows: every setting, the keys whose stored value was unreadable (shown at their
 * default), the accounts the cap counts, and this instance's host (the brand's fallback).
 */
export async function settingsOverview() {
  const q = db();
  const [{ values, unreadable }, accounts, { host }] = await Promise.all([readSettingsChecked(q), accountCount(q), localHandles()]);
  return { values, unreadable, accounts, host };
}
