import { defaultBanner } from '@peblish/schema/banner';
import { siteSettings as contract } from '@peblish/schema/site-settings';
import { beforeEach, expect, test } from 'vitest';
import { siteSettings } from '../db/tables/site.ts';
import { truncateAll } from '../testing/db.ts';
import { tx } from '../tx/tx.ts';
import { readSetting, readSettings, readSettingsChecked } from './read.ts';

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

// The banner and the width are drawn on every page: a stored value that fails the contract (an older shape, a
// hand edit) is read as the default, never thrown, and readSettingsChecked names it for the admin page.
const stored = async (key: string, value: unknown) =>
  tx(async (t) => {
    await t.db.insert(siteSettings).values({ key, value }).onConflictDoUpdate({ target: siteSettings.key, set: { value } });
  });

test('a malformed banner or width reads as the default, and is named as unreadable', async () => {
  const valid = { ...defaultBanner, enabled: true, message: 'Posting pauses tonight.', revision: 4 };
  const { icon: _icon, ...missing } = valid;
  for (const [what, value] of [
    ['a wrong enum', { ...valid, icon: 'typo' }],
    ['a missing field', missing],
    ['an extra field', { ...valid, extra: true }],
    ['a wrong type', { ...valid, enabled: 'yes' }],
    ['a non-object', 'on'],
  ] as const) {
    await stored('site.banner', value);
    expect(await readSetting('site.banner'), what).toEqual(defaultBanner);
    expect((await readSettingsChecked()).unreadable, what).toEqual(['site.banner']);
  }
  await stored('site.width', 'full');
  expect(await readSetting('site.width')).toBe('default');
  expect((await readSettingsChecked()).unreadable).toEqual(['site.banner', 'site.width']);
  // A valid value reads exactly as before.
  await stored('site.banner', valid);
  await stored('site.width', 'wide');
  expect(await readSetting('site.banner')).toEqual(valid);
  expect(await readSettingsChecked()).toMatchObject({ values: { 'site.banner': valid, 'site.width': 'wide' }, unreadable: [] });
  expect((await readSettings())['site.banner']).toEqual(valid);
});
