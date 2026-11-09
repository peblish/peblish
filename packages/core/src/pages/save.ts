import type { Principal } from '@peblish/schema/authz';
import { markdownMaxLength } from '@peblish/schema/markdown';
import { type } from 'arktype';
import { and, eq, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { pages } from './tables.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { isPageLanguage, isPageSlug, type PageLanguage, type PageSlug } from './slugs.ts';

/** A page's draft as saved: a title of 1 to 120 characters and Markdown up to the post limit (empty is fine). */
export const PageDraft = type({ title: '1 <= string <= 120', bodyMd: `string <= ${markdownMaxLength}` });
export type PageDraft = typeof PageDraft.infer;

/**
 * Saves a page's draft, creating the row the first time a language is written. Saving never
 * changes what is live. A save that changes nothing writes nothing, so "unpublished changes"
 * means a real edit. With `onlyIfMissing` an existing draft is left exactly as it is: how the
 * shipped drafts are added without overwriting an admin's edits. No modlog row: a draft is
 * not public until it is published.
 */
export const savePage = defineMutation({
  action: 'page.save',
  emits: ['page.changed'],
  recheck: true,
  async run(t, grant, input: { draft: PageDraft; onlyIfMissing?: boolean }) {
    const draft = PageDraft(input.draft);
    if (draft instanceof type.errors) throw new Refused('page.save', 'page.invalid');
    const { slug, language } = grant.subject;
    const row = { slug, language, title: draft.title, bodyMd: draft.bodyMd, updatedBy: grant.actorId };
    if (input.onlyIfMissing) {
      const inserted = await t.db.insert(pages).values(row).onConflictDoNothing().returning({ slug: pages.slug });
      if (inserted.length === 0) return { saved: false };
    } else {
      const [existing] = await t.db
        .select({ title: pages.title, bodyMd: pages.bodyMd })
        .from(pages)
        .where(and(eq(pages.slug, slug), eq(pages.language, language)))
        .for('no key update');
      if (existing?.title === draft.title && existing.bodyMd === draft.bodyMd) return { saved: false };
      await t.db
        .insert(pages)
        .values(row)
        .onConflictDoUpdate({
          target: [pages.slug, pages.language],
          set: { title: draft.title, bodyMd: draft.bodyMd, updatedBy: grant.actorId, updatedAt: sql`clock_timestamp()` },
        });
    }
    await t.emit({ type: 'page.changed', v: 1, slug, language, change: 'saved', revisionId: null, actorId: grant.actorId });
    return { saved: true };
  },
});

/** page.save for web: authorize first (an admin with two-factor, a known slug and language), then `page.invalid` for a draft the fields refuse. */
export async function savePageAs(
  principal: Principal,
  page: { slug: string; language: string },
  draft: PageDraft,
): Promise<Result<{ saved: boolean }>> {
  const decision = await authorize('page.save', principal, page);
  if (!decision.ok) return decision;
  if (PageDraft(draft) instanceof type.errors) return { ok: false, reason: 'page.invalid' };
  return refusedAsResult(() => savePage(decision.grant, { draft }));
}

/** A shipped draft: the page it is for (English) and its text. */
export type ShippedPage = { slug: PageSlug; draft: PageDraft };

/**
 * Adds the shipped drafts the instance does not have yet, as English drafts, and leaves every
 * page that exists untouched. Each page is its own authorize and write, so one refusal does
 * not undo the others; the result says how many were added.
 */
export async function seedShippedPages(principal: Principal, shipped: readonly ShippedPage[]): Promise<Result<{ added: number }>> {
  let added = 0;
  for (const { slug, draft } of shipped) {
    const page = { slug, language: 'en' satisfies PageLanguage };
    if (!isPageSlug(slug) || !isPageLanguage(page.language)) continue;
    const decision = await authorize('page.save', principal, page);
    if (!decision.ok) return decision;
    const result = await refusedAsResult(() => savePage(decision.grant, { draft, onlyIfMissing: true }));
    if (!result.ok) return result;
    if (result.saved) added += 1;
  }
  return { ok: true, added };
}
