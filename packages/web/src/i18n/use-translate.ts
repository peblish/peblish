import { getRouteApi } from '@tanstack/react-router';
import { translate, type Area, type MessageKey } from './translate.ts';

const root = getRouteApi('__root__');

/** The request locale (server-detected) and a translator bound to it. */
export function useTranslate() {
  const { locale } = root.useLoaderData();
  return {
    locale,
    t: <A extends Area>(area: A, key: MessageKey<A>, params?: Record<string, string | number>) => translate(locale, area, key, params),
  };
}
