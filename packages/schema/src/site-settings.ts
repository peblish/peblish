import { type } from 'arktype';

// The site settings key contract. Anyone may read; only lane ADM's admin settings service
// writes (c/settings). A missing row means the default below.
export const siteSettings = {
  /** Kill switch for sign-up, invites included. */
  'registration.enabled': { schema: type('boolean'), default: true },
  /** Kill switch for the remote-media proxy and link previews. */
  'remote_media.enabled': { schema: type('boolean'), default: true },
  /** Kill switch for inbound federation: the inbox answers 503 with Retry-After. */
  'inbox.enabled': { schema: type('boolean'), default: true },
  /** Image uploads stay off until M26 scanning is live (decision 4). */
  'uploads.enabled': { schema: type('boolean'), default: false },
};

export type SiteSettingKey = keyof typeof siteSettings;
export type SiteSettingValue<K extends SiteSettingKey> = (typeof siteSettings)[K]['default'];
export const killSwitches = [
  'registration.enabled',
  'remote_media.enabled',
  'inbox.enabled',
  'uploads.enabled',
] as const satisfies readonly SiteSettingKey[];
