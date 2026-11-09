import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { prepareRevision } from './prepare.ts';
import { pageLanguages, pageSlugs, type PageLanguage, type PageSlug } from './slugs.ts';
import { pageRevisions, pages } from './tables.ts';

/** Where a page stands in one language: live, live with edits not yet published, a draft only, or not written. */
export type PageStatus = 'published' | 'changed' | 'draft' | 'missing';

export type PageRow = {
  slug: PageSlug;
  language: PageLanguage;
  status: PageStatus;
  /** When the live revision took effect and who published it; null unless a revision is live. */
  published: { at: string; by: string | null } | null;
  /** When the draft was last saved and by whom; null when it does not exist. */
  edited: { at: string; by: string | null } | null;
};

/** The ten slugs in two languages, each with its status: what the admin pages list shows. */
export async function listPages(q: Queryable = db()): Promise<PageRow[]> {
  const rows = await q
    .select({
      slug: pages.slug,
      language: pages.language,
      updatedAt: pages.updatedAt,
      editedBy: actors.name,
      revision: pages.publishedRevision,
    })
    .from(pages)
    .leftJoin(actors, eq(actors.id, pages.updatedBy));
  const live = await q
    .select({ id: pageRevisions.id, at: pageRevisions.effectiveAt, createdAt: pageRevisions.createdAt, by: actors.name })
    .from(pageRevisions)
    .innerJoin(pages, eq(pages.publishedRevision, pageRevisions.id))
    .leftJoin(actors, eq(actors.id, pageRevisions.publishedBy));
  const liveById = new Map(live.map((row) => [row.id, row]));
  const byPage = new Map(rows.map((row) => [`${row.slug}/${row.language}`, row]));
  return pageSlugs.flatMap((slug) =>
    pageLanguages.map((language): PageRow => {
      const draft = byPage.get(`${slug}/${language}`);
      if (!draft) return { slug, language, status: 'missing', published: null, edited: null };
      const revision = draft.revision ? liveById.get(draft.revision) : undefined;
      const edited = { at: draft.updatedAt.toISOString(), by: draft.editedBy };
      if (!revision) return { slug, language, status: 'draft', published: null, edited };
      return {
        slug,
        language,
        // A save after the publish is an edit the visitors do not see yet.
        status: draft.updatedAt > revision.createdAt ? 'changed' : 'published',
        published: { at: revision.at.toISOString(), by: revision.by },
        edited,
      };
    }),
  );
}

/** One draft for the editor; null when that language has none yet. */
export async function readDraft(slug: string, language: string, q: Queryable = db()) {
  const [row] = await q
    .select({ title: pages.title, bodyMd: pages.bodyMd, updatedAt: pages.updatedAt })
    .from(pages)
    .where(and(eq(pages.slug, slug), eq(pages.language, language)));
  return row ? { title: row.title, bodyMd: row.bodyMd, updatedAt: row.updatedAt.toISOString() } : null;
}

export type PublishedPage = { slug: PageSlug; language: PageLanguage; title: string; bodyMd: string; effectiveAt: string };

/** Every page with a live revision, in each language, newest revision per page. */
async function livePages(q: Queryable): Promise<PublishedPage[]> {
  const rows = await q
    .select({
      slug: pageRevisions.slug,
      language: pageRevisions.language,
      title: pageRevisions.title,
      bodyMd: pageRevisions.bodyMd,
      effectiveAt: pageRevisions.effectiveAt,
    })
    .from(pages)
    .innerJoin(pageRevisions, eq(pageRevisions.id, pages.publishedRevision))
    .where(isNotNull(pages.publishedRevision))
    .orderBy(desc(pageRevisions.effectiveAt));
  return rows.flatMap((row) => {
    const slug = pageSlugs.find((known) => known === row.slug);
    const language = pageLanguages.find((known) => known === row.language);
    return slug && language ? [{ slug, language, title: row.title, bodyMd: row.bodyMd, effectiveAt: row.effectiveAt.toISOString() }] : [];
  });
}

/**
 * The public pages for a reader: for each slug the live revision in `language`, else the English
 * one (so a reader never loses a page for lack of a translation), in the order of `pageSlugs`.
 */
export async function publishedPages(language: string, q: Queryable = db()): Promise<PublishedPage[]> {
  const live = await livePages(q);
  return pageSlugs.flatMap((slug) => {
    const own = live.find((page) => page.slug === slug && page.language === language);
    const page = own ?? live.find((candidate) => candidate.slug === slug && candidate.language === 'en');
    return page ? [page] : [];
  });
}

/** One public page for a reader, or null when none is live in their language or English. */
export async function readPublishedPage(slug: string, language: string, q: Queryable = db()): Promise<PublishedPage | null> {
  return (await publishedPages(language, q)).find((page) => page.slug === slug) ?? null;
}

/** The tokens a publish of this draft would still find unresolved right now (none when it is ready, or when there is no draft). */
export async function unresolvedTokens(slug: string, language: string, q: Queryable = db()): Promise<string[]> {
  const prepared = await prepareRevision(q, { slug, language }, false);
  return prepared.ok ? [] : prepared.unresolved;
}
