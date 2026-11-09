import { type, type Type } from 'arktype';

// The site settings key contract. Anyone may read; only lane ADM's admin settings service
// writes (c/settings). A missing row means the default below.
const definitions = {
  /** Kill switch for sign-up, invites included. */
  'registration.enabled': { schema: type('boolean'), default: true },
  /** Kill switch for the remote-media proxy and link previews. */
  'remote_media.enabled': { schema: type('boolean'), default: true },
  /** Kill switch for inbound federation: the inbox answers 503 with Retry-After. */
  'inbox.enabled': { schema: type('boolean'), default: true },
  /** Image uploads stay off until M26 scanning is live (decision 4). */
  'uploads.enabled': { schema: type('boolean'), default: false },
  /** Beta cap on accounts: local people with a login who have not deleted it. Sign-up refuses at the cap. */
  'registration.cap': { schema: type('number.integer >= 0'), default: 25 },
  /** Instances (lowercase domains, as in instances.domain) whose modlog reasons the public modlog shows. */
  'modlog.trusted_instances': { schema: type('string[]'), default: [] },
  /** The instance's name: the sidebar brand, page titles and /about. Empty shows the host instead. */
  'site.name': { schema: type('string <= 40'), default: '' },
  /** A plain-text description for /about and the meta description. */
  'site.description': { schema: type('string <= 500'), default: '' },
  /** The operator's details, filled into the legal pages when they are published. */
  'operator.name': { schema: type('string <= 120'), default: '' },
  'operator.address': { schema: type('string <= 300'), default: '' },
  'operator.jurisdiction': { schema: type('string <= 80'), default: '' },
  /** The published contact point (legal pages, the statement of reasons' review route). */
  'contact.email': { schema: type("string.email | ''"), default: '' },
  /** Kill switch for new posts and comments by local people; remote content keeps arriving. */
  'posting.enabled': { schema: type('boolean'), default: true },
  /** Kill switch for outbound federation: deliveries stay pending until it is on again. */
  'delivery.enabled': { schema: type('boolean'), default: true },
  /** Whether posts marked sensitive (NSFW) are stored when they arrive from other instances; NSFL stays refused. */
  'remote_nsfw.accepted': { schema: type('boolean'), default: false },
};

/** One key: the schema a stored value must pass, and the value when no row exists. */
export type SiteSetting<T> = { schema: Type<T>; default: T };
export type SiteSettingKey = keyof typeof definitions;
export type SiteSettingValue<K extends SiteSettingKey> = (typeof definitions)[K]['schema']['infer'];
// A mapped type, so siteSettings[key] is SiteSetting<SiteSettingValue<K>> for a generic key too.
export const siteSettings: { [K in SiteSettingKey]: SiteSetting<SiteSettingValue<K>> } = definitions;

export const killSwitches = [
  'registration.enabled',
  'remote_media.enabled',
  'inbox.enabled',
  'uploads.enabled',
  'posting.enabled',
  'delivery.enabled',
] as const satisfies readonly SiteSettingKey[];
