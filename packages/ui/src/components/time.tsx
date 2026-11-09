// Compact ages ("3h", "2m") and absolute dates for <time>, in the request's locale.

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

const absoluteFormats = new Map<string, Intl.DateTimeFormat>();

/** Date and time in UTC, so the server and the browser print the same text. */
export function absoluteTime(iso: string, locale: string): string {
  let format = absoluteFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    });
    absoluteFormats.set(locale, format);
  }
  return format.format(new Date(iso));
}

const clock = () => new Date();

/**
 * A <time> showing the compact age. The age depends on the clock, so the server's text can
 * differ from the browser's by a unit; the browser keeps the server's until the next render.
 */
export function Time({ iso, locale, now }: { iso: string; locale: string; now?: Date | undefined }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso, locale)} suppressHydrationWarning>
      {compactAge(iso, now ?? clock(), locale)}
    </time>
  );
}
