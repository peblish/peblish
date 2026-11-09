import { siteSettings } from '@peblish/schema/site-settings';
import { expect, test } from 'vitest';
import { savePatch, switchPatch } from './-form.ts';

test('the save form becomes a patch of known keys, with lines split, CRLF folded and a bad cap left for the contract to refuse', () => {
  const patch = savePatch({
    'site.name': ' Feddit ',
    'operator.address': 'Main Street 1\r\n10115 Berlin',
    'registration.cap': '40',
    'remote_nsfw.accepted': 'on',
    'modlog.trusted_instances': 'lemmy.world\r\n\r\n  piefed.social \n',
  });
  expect(Object.keys(patch).every((key) => key in siteSettings)).toBe(true);
  expect(patch).toMatchObject({
    'site.name': ' Feddit ',
    'operator.address': 'Main Street 1\n10115 Berlin',
    'registration.cap': 40,
    'remote_nsfw.accepted': true,
    'modlog.trusted_instances': ['lemmy.world', 'piefed.social'],
  });
  expect(savePatch({ 'registration.cap': '4x' })['registration.cap']).toBeNaN();
  expect(savePatch({})['remote_nsfw.accepted']).toBe(false);
});

test('a switch form names a kill switch and the state to set; anything else is no switch', () => {
  expect(switchPatch({ key: 'inbox.enabled', state: 'off' })).toEqual({ 'inbox.enabled': false });
  expect(switchPatch({ key: 'uploads.enabled', state: 'on' })).toEqual({ 'uploads.enabled': true });
  expect(switchPatch({ key: 'site.name', state: 'on' })).toBeNull();
  expect(switchPatch({ key: 'inbox.enabled', state: 'toggle' })).toBeNull();
  expect(switchPatch({})).toBeNull();
});
