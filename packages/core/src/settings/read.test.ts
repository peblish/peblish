import { siteSettings as contract } from '@peblish/schema/site-settings';
import { beforeEach, expect, test } from 'vitest';
import { siteSettings } from '../db/tables/site.ts';
import { truncateAll } from '../testing/db.ts';
import { tx } from '../tx/tx.ts';
import { readSetting, readSettings } from './read.ts';

beforeEach(truncateAll);

test('kill switches read their contract default until a row exists', async () => {
  expect(await readSetting('uploads.enabled')).toBe(false);
  expect(await readSetting('inbox.enabled')).toBe(true);
  await tx(async (t) => {
    await t.db.insert(siteSettings).values({ key: 'inbox.enabled', value: false });
  });
  expect(await readSetting('inbox.enabled')).toBe(false);
});

test('a stored value of the wrong type is refused, not trusted', async () => {
  await tx(async (t) => {
    await t.db.insert(siteSettings).values({ key: 'registration.enabled', value: 'yes' });
  });
  await expect(readSetting('registration.enabled')).rejects.toThrow();
});

test('readSettings gives every key: the stored value, else its contract default', async () => {
  await tx(async (t) => {
    await t.db.insert(siteSettings).values({ key: 'site.name', value: 'Feddit' });
  });
  const all = await readSettings();
  expect(Object.keys(all).sort()).toEqual(Object.keys(contract).sort());
  expect(all).toMatchObject({ 'site.name': 'Feddit', 'registration.cap': 25, 'uploads.enabled': false, 'remote_nsfw.accepted': false });
});
