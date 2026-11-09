import { localHandles } from '@peblish/core/identity/handles';
import { publishedPages } from '@peblish/core/pages/read';
import { isPageSlug, type PageSlug } from '@peblish/core/pages/slugs';
import { readSetting } from '@peblish/core/settings/read';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { negotiateLocale } from '../../i18n/negotiate.ts';
import { createMarkdownRenderer } from '../../server/markdown.ts';

/** One entry of the "Legal and safety" list: where a live page is, and what it is called in the reader's language. */
export type LegalLink = { slug: PageSlug; title: string };

export type LegalPageData = {
  slug: PageSlug;
  /** The live page in the reader's language, else English; null for /about while no About is published. */
  page: { language: string; title: string; html: string } | null;
  /** /about only: what to show when no About page is published. */
  about: { name: string; description: string } | null;
  links: LegalLink[];
};

/**
 * The public page at /<slug>: the live revision in the reader's language (Accept-Language), else
 * English, rendered as Markdown, with the list of every live page. Null (a 404) for an unknown slug
 * or a page nobody has published; /about with no About page still answers, with the instance's
 * name and description. The response varies by language, so it says so.
 */
export const loadLegalPage = createServerFn({ method: 'GET' })
  .validator(type({ slug: 'string' }))
  .handler(async ({ data }): Promise<LegalPageData | null> => {
    const { slug } = data;
    if (!isPageSlug(slug)) return null;
    setResponseHeader('vary', 'Accept-Language');
    const language = new Intl.Locale(negotiateLocale(getRequestHeader('accept-language'))).language;
    const live = await publishedPages(language);
    const links = live.map(({ slug: pageSlug, title }) => ({ slug: pageSlug, title }));
    const found = live.find((candidate) => candidate.slug === slug);
    if (found) {
      const renderer = await createMarkdownRenderer();
      return { slug, page: { language: found.language, title: found.title, html: renderer.render(found.bodyMd).html }, about: null, links };
    }
    if (slug !== 'about') return null;
    const [name, description, { host }] = await Promise.all([readSetting('site.name'), readSetting('site.description'), localHandles()]);
    return { slug, page: null, about: { name: name || host, description }, links };
  });
