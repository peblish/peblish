/** The CMS pages the instance serves at `/<slug>`: fixed for now, so a link to one never breaks and a new one is a code change. */
export const pageSlugs = [
  'terms',
  'privacy',
  'rules',
  'moderation-policy',
  'federation-policy',
  'dmca',
  'illegal-content',
  'take-it-down',
  'under-16',
  'about',
] as const;
export type PageSlug = (typeof pageSlugs)[number];

/** The languages a page can be written in; English is the one every page starts with and falls back to. */
export const pageLanguages = ['en', 'de'] as const;
export type PageLanguage = (typeof pageLanguages)[number];

export const isPageSlug = (value: string): value is PageSlug => pageSlugs.some((slug) => slug === value);
export const isPageLanguage = (value: string): value is PageLanguage => pageLanguages.some((language) => language === value);
