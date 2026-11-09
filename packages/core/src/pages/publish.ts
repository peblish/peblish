import type { Principal } from '@peblish/schema/authz';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { authorize } from '../authz/authorize.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { prepareRevision } from './prepare.ts';
import { pageRevisions, pages } from './tables.ts';

/**
 * Puts a draft live: inserts the revision (the draft's title and Markdown with the operator's
 * details and today's date filled in), points the page at it, logs it in the modlog (non-public)
 * and emits page.changed, in one transaction. The policy and this body both fill the tokens
 * from rows they hold locked, so a leftover token or an emptied detail refuses the publish
 * (page.unresolved_tokens) instead of putting a placeholder in front of visitors.
 */
export const publishPage = defineMutation({
  action: 'page.publish',
  emits: ['page.changed'],
  recheck: true,
  async run(t, grant) {
    const { slug, language } = grant.subject;
    const now = new Date();
    const prepared = await prepareRevision(t.db, grant.subject, true, now);
    if (!prepared.ok) throw new Refused('page.publish', prepared.reason);
    const revisionId = uuidv7();
    await t.db.insert(pageRevisions).values({
      id: revisionId,
      slug,
      language,
      title: prepared.title,
      bodyMd: prepared.bodyMd,
      effectiveAt: now,
      publishedBy: grant.actorId,
    });
    await t.db
      .update(pages)
      .set({ publishedRevision: revisionId })
      .where(and(eq(pages.slug, slug), eq(pages.language, language)));
    await writeModlog(t.db, grant, {
      community: null,
      target: null,
      reason: null,
      details: { public: false, page: { slug, language, revision: revisionId } },
    });
    await t.emit({ type: 'page.changed', v: 1, slug, language, change: 'published', revisionId, actorId: grant.actorId });
    return { revisionId };
  },
});

/** Takes a page off the site: the pointer goes, the draft and every revision stay. Logged like a publish. */
export const unpublishPage = defineMutation({
  action: 'page.unpublish',
  emits: ['page.changed'],
  recheck: true,
  async run(t, grant) {
    const { slug, language } = grant.subject;
    const [page] = await t.db
      .select({ revision: pages.publishedRevision })
      .from(pages)
      .where(and(eq(pages.slug, slug), eq(pages.language, language)))
      .for('no key update');
    if (!page?.revision) throw new Refused('page.unpublish', 'page.not_published');
    await t.db
      .update(pages)
      .set({ publishedRevision: null })
      .where(and(eq(pages.slug, slug), eq(pages.language, language)));
    await writeModlog(t.db, grant, {
      community: null,
      target: null,
      reason: null,
      details: { public: false, page: { slug, language, revision: page.revision } },
    });
    await t.emit({ type: 'page.changed', v: 1, slug, language, change: 'unpublished', revisionId: null, actorId: grant.actorId });
    return {};
  },
});

type PageRef = { slug: string; language: string };

/** page.publish for web; the result names the new revision. */
export async function publishPageAs(principal: Principal, page: PageRef): Promise<Result<{ revisionId: string }>> {
  const decision = await authorize('page.publish', principal, page);
  if (!decision.ok) return decision;
  return refusedAsResult(() => publishPage(decision.grant, undefined));
}

/** page.unpublish for web. */
export async function unpublishPageAs(principal: Principal, page: PageRef): Promise<Result<object>> {
  const decision = await authorize('page.unpublish', principal, page);
  if (!decision.ok) return decision;
  return refusedAsResult(() => unpublishPage(decision.grant, undefined));
}
