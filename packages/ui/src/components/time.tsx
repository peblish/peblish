// Compact ages ("3h", "2m"), dates, dates with times and clock times for <time>, in the request's locale.

const units = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
] as const;

const formatters = new Map<string, Intl.NumberFormat>();
function unitFormat(locale: string, unit: (typeof units)[number][0]) {
  const key = `${locale}/${unit}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 0 });
    formatters.set(key, format);
  }
  return format;
}

/** "3h", "2m", "1d": the largest whole unit since `iso`, at least a minute. */
export function compactAge(iso: string, now: Date, locale: string): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? (['minute', 60] as const);
  return unitFormat(locale, unit).format(Math.max(1, Math.floor(seconds / size)));
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormat(locale: string, withTime: boolean) {
  const key = `${locale}/${withTime ? 'date-time' : 'date'}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    // Explicit fields, not dateStyle: browsers refuse a style combined with timeZoneName.
    format = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' } : {}),
      timeZone: 'UTC',
    });
    dateTimeFormats.set(key, format);
  }
  return format;
}

/** Date and time in UTC, so the server and the browser print the same text. */
export function absoluteTime(iso: string, locale: string): string {
  return dateTimeFormat(locale, true).format(new Date(iso));
}

/** The date alone ("Nov 3, 2026", "3. Nov. 2026"), in UTC like `absoluteTime`. */
export function absoluteDate(iso: string, locale: string): string {
  return dateTimeFormat(locale, false).format(new Date(iso));
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** The clock time alone, 24-hour, in UTC ("09:05"): a row under a day's heading. */
export function absoluteClock(iso: string, locale: string): string {
  let format = clockFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
    clockFormats.set(locale, format);
  }
  return format.format(new Date(iso));
}

const clock = () => new Date();

export interface TimeProps {
  iso: string;
  locale: string;
  /**
   * `age` (the default): the compact age ("3h"). `date`: the date alone. `date-time`: the date and
   * time in UTC. `time`: the clock time alone, 24-hour, in UTC (under a heading that names the
   * day). The full date and time is always the `title`.
   */
  format?: 'age' | 'date' | 'date-time' | 'time';
  /** The clock for the age, so a test or a story can fix it. */
  now?: Date | undefined;
}

/**
 * A <time> for `iso`. The age depends on the clock, so the server's text can differ from the
 * browser's by a unit; the browser keeps the server's until the next render. The dates are in
 * UTC, so they match on both sides.
 */
export function Time({ iso, locale, format = 'age', now }: TimeProps) {
  const title = absoluteTime(iso, locale);
  if (format === 'age')
    return (
      <time dateTime={iso} title={title} suppressHydrationWarning>
        {compactAge(iso, now ?? clock(), locale)}
      </time>
    );
  return (
    <time dateTime={iso} title={title}>
      {format === 'date' ? absoluteDate(iso, locale) : format === 'time' ? absoluteClock(iso, locale) : title}
    </time>
  );
}
