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
