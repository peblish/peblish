import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server';
import { negotiateLocale } from './negotiate.ts';

/**
 * The document request's negotiated locale, dehydrated into the page so the client hydrates
 * with the same value. The answer depends on Accept-Language, and the response says so.
 */
export const getRequestLocale = createServerFn({ method: 'GET' }).handler(() => {
  setResponseHeader('vary', 'Accept-Language');
  return negotiateLocale(getRequestHeader('accept-language'));
});
