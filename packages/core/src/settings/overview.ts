import { localHandles } from '../identity/handles.ts';
import { accountCount } from '../registration/settings.ts';
import { db } from '../db/read.ts';
import { readSettings } from './read.ts';

/** What the admin settings page shows: every setting, the accounts the cap counts, and this instance's host (the brand's fallback). */
export async function settingsOverview() {
  const q = db();
  const [values, accounts, { host }] = await Promise.all([readSettings(q), accountCount(q), localHandles()]);
  return { values, accounts, host };
}
