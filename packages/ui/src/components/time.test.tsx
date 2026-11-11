import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Time, absoluteTime, compactAge } from './time.tsx';

const now = new Date('2026-11-09T12:00:00Z');

test('ages are the largest whole unit, at least a minute, in the locale', () => {
  expect(compactAge('2026-11-09T11:59:40Z', now, 'en-US')).toBe('1m');
  expect(compactAge('2026-11-09T09:00:00Z', now, 'en-US')).toBe('3h');
  expect(compactAge('2026-11-08T12:00:00Z', now, 'en-US')).toBe('1d');
  expect(compactAge('2026-11-09T09:00:00Z', now, 'de-DE')).toMatch(/^3\s*(h|Std)/);
  // A time in the future (clock skew) reads as the minimum, not a negative age.
  expect(compactAge('2026-11-09T12:05:00Z', now, 'en-US')).toBe('1m');
});

// Browsers throw a TypeError when dateStyle or timeStyle meets timeZoneName, so the absolute time
// uses explicit fields; the same text must come out on the server and in the browser (UTC).
test('the absolute time is in UTC, with the zone named, in the locale', () => {
  expect(absoluteTime('2026-11-09T12:00:00Z', 'en-US')).toBe('Nov 9, 2026, 12:00 PM UTC');
  expect(absoluteTime('2026-11-09T12:00:00Z', 'de-DE')).toBe('9. Nov. 2026, 12:00 UTC');
});

test('the absolute time never combines a style with a zone name', () => {
  const real = Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions[] = [];
  Intl.DateTimeFormat = new Proxy(real, {
    construct(target, args: [string, Intl.DateTimeFormatOptions]) {
      options.push(args[1]);
      return new target(...args);
    },
  });
  try {
    absoluteTime('2026-11-09T12:00:00Z', 'fr-FR');
  } finally {
    Intl.DateTimeFormat = real;
  }
  expect(options).toHaveLength(1);
  expect(options[0]).toHaveProperty('timeZoneName');
  expect(options[0]).not.toHaveProperty('dateStyle');
  expect(options[0]).not.toHaveProperty('timeStyle');
});

const iso = '2026-11-03T23:30:00Z';

test('the date format prints the date alone, in UTC, with the full time as the title', () => {
  expect(renderToStaticMarkup(<Time iso={iso} locale="en-US" format="date" />)).toBe(
    '<time dateTime="2026-11-03T23:30:00Z" title="Nov 3, 2026, 11:30 PM UTC">Nov 3, 2026</time>',
  );
  expect(renderToStaticMarkup(<Time iso={iso} locale="de-DE" format="date" />)).toBe(
    '<time dateTime="2026-11-03T23:30:00Z" title="3. Nov. 2026, 23:30 UTC">3. Nov. 2026</time>',
  );
});

test('the date-time format prints the absolute time', () => {
  expect(renderToStaticMarkup(<Time iso={iso} locale="en-US" format="date-time" />)).toBe(
    '<time dateTime="2026-11-03T23:30:00Z" title="Nov 3, 2026, 11:30 PM UTC">Nov 3, 2026, 11:30 PM UTC</time>',
  );
  expect(renderToStaticMarkup(<Time iso={iso} locale="de-DE" format="date-time" />)).toBe(
    '<time dateTime="2026-11-03T23:30:00Z" title="3. Nov. 2026, 23:30 UTC">3. Nov. 2026, 23:30 UTC</time>',
  );
});

test('the age stays the default', () => {
  expect(renderToStaticMarkup(<Time iso={iso} locale="en-US" now={new Date('2026-11-04T02:30:00Z')} />)).toBe(
    '<time dateTime="2026-11-03T23:30:00Z" title="Nov 3, 2026, 11:30 PM UTC">3h</time>',
  );
});

test('the time format prints the clock time alone, 24-hour, in UTC', () => {
  expect(renderToStaticMarkup(<Time iso="2026-11-03T09:05:00Z" locale="en-US" format="time" />)).toBe(
    '<time dateTime="2026-11-03T09:05:00Z" title="Nov 3, 2026, 09:05 AM UTC">09:05</time>',
  );
  expect(renderToStaticMarkup(<Time iso={iso} locale="en-US" format="time" />)).toContain('>23:30</time>');
  expect(renderToStaticMarkup(<Time iso={iso} locale="de-DE" format="time" />)).toBe(
    '<time dateTime="2026-11-03T23:30:00Z" title="3. Nov. 2026, 23:30 UTC">23:30</time>',
  );
  // The moderation log's own formatter, which this replaces, prints the same text.
  const modlog = (locale: string) =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(new Date(iso));
  expect(renderToStaticMarkup(<Time iso={iso} locale="de-DE" format="time" />)).toContain(`>${modlog('de-DE')}</time>`);
  expect(renderToStaticMarkup(<Time iso={iso} locale="en-US" format="time" />)).toContain(`>${modlog('en-US')}</time>`);
});
