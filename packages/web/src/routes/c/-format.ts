// Numbers, dates and ages for the community page, formatted once in the loader so hydration
// formats nothing (no client Intl at hydration). `now` is the request's clock.

const units = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
] as const;

/** "12 minutes ago", "3 days ago" in the locale: the largest whole unit, "now" under a minute. */
export function agoText(locale: string, iso: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  const unit = units.find(([, size]) => seconds >= size);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return unit ? format.format(-Math.floor(seconds / unit[1]), unit[0]) : format.format(0, 'second');
}

/** "2 Jun 2023", by the UTC calendar. */
export const dateText = (locale: string, iso: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));

/** A language's name in the locale; the code itself when the platform has none. */
export function languageName(locale: string, code: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
