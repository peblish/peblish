import { siteSettings } from '@peblish/schema/site-settings';
import { expect, test } from 'vitest';
import { bannerPatch, savePatch, switchPatch, widthPatch } from './-form.ts';

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

const banner = {
  'banner.enabled': 'on',
  'banner.title': ' Read-only window ',
  'banner.message': 'Posting pauses tonight.\r\nReading works.',
  'banner.tone': 'accent',
  'banner.colour': '#6E4BD8',
  'banner.emphasis': 'solid',
  'banner.align': 'start',
  'banner.icon': 'wrench',
  'banner.dismissible': 'on',
  'banner.primary.label': 'Details',
  'banner.primary.href': '/about',
  'banner.link.label': '',
  'banner.link.href': '',
};

test('the banner form becomes the whole banner, trimmed, with revision 0 for the writer to replace', () => {
  expect(bannerPatch(banner)).toEqual({
    patch: {
      'site.banner': {
        enabled: true,
        revision: 0,
        title: 'Read-only window',
        message: 'Posting pauses tonight.\nReading works.',
        icon: 'wrench',
        tone: 'accent',
        colour: '#6E4BD8',
        emphasis: 'solid',
        align: 'start',
        dismissible: true,
        primary: { label: 'Details', href: '/about' },
        link: null,
      },
    },
  });
  // Switches that are off are not in the form; a short colour is read as the field submits it.
  expect(bannerPatch({ ...banner, 'banner.enabled': '', 'banner.dismissible': '', 'banner.colour': '#abc' })).toMatchObject({
    patch: { 'site.banner': { enabled: false, dismissible: false, colour: '#aabbcc' } },
  });
});

test('a refused banner names the field to mark', () => {
  const field = (change: Record<string, string>) => bannerPatch({ ...banner, ...change });
  expect(field({ 'banner.message': '  ' })).toEqual({ field: 'banner.message' });
  // Off, it may be empty.
  expect(field({ 'banner.message': '', 'banner.enabled': '' })).toHaveProperty('patch');
  expect(field({ 'banner.message': 'x'.repeat(141) })).toEqual({ field: 'banner.message' });
  expect(field({ 'banner.title': 'x'.repeat(33) })).toEqual({ field: 'banner.title' });
  expect(field({ 'banner.link.label': 'Rules' })).toEqual({ field: 'banner.link.href' });
  expect(field({ 'banner.primary.label': '' })).toEqual({ field: 'banner.primary.label' });
  expect(field({ 'banner.primary.label': 'x'.repeat(17) })).toEqual({ field: 'banner.primary.label' });
  for (const href of ['https://example.test/', '//example.test', '/\\example.test', 'javascript:alert(1)', 'about'])
    expect(field({ 'banner.primary.href': href }), href).toEqual({ field: 'banner.primary.href' });
  expect(field({ 'banner.tone': 'custom', 'banner.colour': '' })).toEqual({ field: 'banner.colour' });
  expect(field({ 'banner.tone': 'custom', 'banner.colour': 'red' })).toEqual({ field: 'banner.colour' });
  expect(field({ 'banner.tone': 'purple' })).toEqual({ field: 'banner.tone' });
  expect(field({ 'banner.icon': 'skull' })).toEqual({ field: 'banner.icon' });
  // Another tone keeps a valid colour where the field was emptied.
  expect(field({ 'banner.colour': '' })).toMatchObject({ patch: { 'site.banner': { colour: '#007ba7' } } });
  expect(field({ 'banner.colour': 'red' })).toMatchObject({ patch: { 'site.banner': { colour: '#007ba7' } } });
});

test('the width form names one of the three presets', () => {
  expect(widthPatch({ 'site.width': 'wide' })).toEqual({ 'site.width': 'wide' });
  expect(widthPatch({ 'site.width': 'full' })).toBeNull();
  expect(widthPatch({})).toBeNull();
});
