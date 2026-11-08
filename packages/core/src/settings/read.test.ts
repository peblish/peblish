import { beforeEach, expect, test } from 'vitest';
import { siteSettings } from '../db/tables/site.ts';
import { truncateAll } from '../testing/db.ts';
import { tx } from '../tx/tx.ts';
import { readSetting } from './read.ts';

beforeEach(truncateAll);

test('kill switches read their contract default until a row exists', async () => {
  expect(await readSetting('uploads.enabled')).toBe(false);
  expect(await readSetting('inbox.enabled')).toBe(true);
  await tx(async (t) => { await t.db.insert(siteSettings).values({ key: 'inbox.enabled', value: false }); });
  expect(await readSetting('inbox.enabled')).toBe(false);
});

test('a stored value of the wrong type is refused, not trusted', async () => {
  await tx(async (t) => { await t.db.insert(siteSettings).values({ key: 'registration.enabled', value: 'yes' }); });
  await expect(readSetting('registration.enabled')).rejects.toThrow();
});
