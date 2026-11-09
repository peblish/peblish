import { catalogues } from '../registry/i18n.gen.ts';

// One catalogue per area (i18n/<area>.json, registered by glob), each keyed by language.
// Messages fall back to English; {name} placeholders are replaced from `params`.

type Catalogues = typeof catalogues;
export type Area = keyof Catalogues;
export type MessageKey<A extends Area> = keyof Catalogues[A]['en'] & string;

function messagesFor(catalogue: Record<string, Record<string, string>>, locale: string): Record<string, string> {
  const language = new Intl.Locale(locale).language;
  return catalogue[locale] ?? catalogue[language] ?? {};
}

export function translate<A extends Area>(
  locale: string,
  area: A,
  key: MessageKey<A>,
  params: Record<string, string | number> = {},
): string {
  const catalogue: Record<string, Record<string, string>> = catalogues[area];
  const message = messagesFor(catalogue, locale)[key] ?? catalogue.en?.[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}

/** The base of every `<base>.one` key: a message that varies with a count. */
export type PluralBase<A extends Area> = MessageKey<A> extends infer K ? (K extends `${infer Base}.one` ? Base : never) : never;

/**
 * A message that depends on a count, from the keys `<base>.one` and `<base>.other` (and
 * `.zero`, `.two`, `.few`, `.many` for languages that need them), picked by the locale's plural
 * rules. `{count}` is filled in with the number formatted for the locale.
 */
export function translatePlural<A extends Area>(
  locale: string,
  area: A,
  base: PluralBase<A>,
  count: number,
  params: Record<string, string | number> = {},
): string {
  const category = new Intl.PluralRules(locale).select(count);
  const catalogue: Record<string, Record<string, string>> = catalogues[area];
  const known = (key: string) => key in (messagesFor(catalogue, locale) ?? {}) || key in (catalogue.en ?? {});
  const key = known(`${base}.${category}`) ? `${base}.${category}` : `${base}.other`;
  return translate(locale, area, key as MessageKey<A>, { ...params, count: new Intl.NumberFormat(locale).format(count) });
}
