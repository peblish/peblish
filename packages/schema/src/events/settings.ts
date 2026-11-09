import { type } from 'arktype';
import { Uuid } from '../ids.ts';
import { siteSettings } from '../site-settings.ts';

// Owned by lane ADM (wave 3).
const SiteSettingKey = type.enumerated(...(Object.keys(siteSettings) as (keyof typeof siteSettings)[]));

export const events = {
  /** One or more site settings changed value; the modlog row (public: false) holds each key's before and after. */
  'settings.updated': type({ type: "'settings.updated'", v: '1', keys: SiteSettingKey.array(), actorId: Uuid, modlogId: Uuid }),
  /** A CMS page's draft was saved, or its live revision was published or withdrawn; revisionId is null unless published. */
  'page.changed': type({
    type: "'page.changed'",
    v: '1',
    slug: 'string',
    language: 'string',
    change: "'saved' | 'published' | 'unpublished'",
    revisionId: Uuid.or('null'),
    actorId: Uuid,
  }),
};
