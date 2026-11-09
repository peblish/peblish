import { Uuid } from '@peblish/schema/ids';

// Hide NSFW as two per-browser cookies (decision COMM 2; no account setting, action or event).
// Absent means hide. `peblish_nsfw=show` is "Show always" (a year); `peblish_nsfw_once` lists the
// communities opened with "Show once" and lasts until the browser closes. Both are HttpOnly,
// SameSite=Lax and Secure on https. Pure, so core's readPost and web's routes share one codec.

/** What this browser chose to show. Declared viewers only: the age declaration is checked apart. */
export type NsfwChoice = { always: boolean; once: readonly Uuid[] };

/** The default: Hide NSFW on. */
export const hideNsfw: NsfwChoice = { always: false, once: [] };
/** For feeds and an author's own edit page, where the per-post cover or the author's right decides. */
export const showNsfw: NsfwChoice = { always: true, once: [] };

export const NSFW_ALWAYS_COOKIE = 'peblish_nsfw';
export const NSFW_ONCE_COOKIE = 'peblish_nsfw_once';
/** Most communities one browser can hold open at once; a longer cookie is ignored whole. */
export const nsfwOnceMax = 10;

const year = 365 * 24 * 60 * 60;

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(/;\s*/)) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1);
  }
  return null;
}

/** The choice a Cookie header carries; anything malformed counts as absent (hide). */
export function parseNsfwChoice(header: string | null): NsfwChoice {
  const raw = cookieValue(header, NSFW_ONCE_COOKIE);
  const ids = raw ? raw.split(',') : [];
  const once = ids.length > 0 && ids.length <= nsfwOnceMax && ids.every((id) => Uuid.allows(id)) ? (ids as Uuid[]) : [];
  return { always: cookieValue(header, NSFW_ALWAYS_COOKIE) === 'show', once };
}

export type NsfwIntent = 'once' | 'always' | 'hide';

/** The choice after a gate form: `once` adds this community (newest kept past the limit), `hide` clears both. */
export function chooseNsfw(current: NsfwChoice, intent: NsfwIntent, communityId: Uuid): NsfwChoice {
  if (intent === 'hide') return hideNsfw;
  if (intent === 'always') return { ...current, always: true };
  const once = [...current.once.filter((id) => id !== communityId), communityId].slice(-nsfwOnceMax);
  return { ...current, once };
}

/** Set-Cookie values that store `choice`; a part that is off is expired in the browser. */
export function nsfwSetCookies(choice: NsfwChoice, secure: boolean): string[] {
  const flags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return [
    choice.always ? `${NSFW_ALWAYS_COOKIE}=show; ${flags}; Max-Age=${year}` : `${NSFW_ALWAYS_COOKIE}=; ${flags}; Max-Age=0`,
    choice.once.length > 0 ? `${NSFW_ONCE_COOKIE}=${choice.once.join(',')}; ${flags}` : `${NSFW_ONCE_COOKIE}=; ${flags}; Max-Age=0`,
  ];
}

/** Whether this browser's choice opens a flagged community. */
export const shows = (choice: NsfwChoice, communityId: Uuid): boolean => choice.always || choice.once.includes(communityId);
