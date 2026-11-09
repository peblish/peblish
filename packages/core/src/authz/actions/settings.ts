import type { ActingPrincipal } from '@peblish/schema/authz';
import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../db/read.ts';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import type { Frozen } from '../frozen.ts';
import { isPageLanguage, isPageSlug } from '../../pages/slugs.ts';
import { prepareRevision } from '../../pages/prepare.ts';
import { pages } from '../../pages/tables.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Owned by lane ADM: site settings and CMS pages. Only an admin with two-factor writes either.
// Under lock the admin's login row is read FOR SHARE, as lane A's and F's admin policies do; no
// write body here updates it. The setting rows a write changes are locked by the write itself
// (settings/write.ts), which is what makes a flip wait for a reader holding the row FOR SHARE.

/** A site admin with two-factor on, as lane A's admin policies decide it; the deny, or null. */
export async function denyUnlessAdmin(principal: Frozen<ActingPrincipal>, db: Queryable, lock: boolean): Promise<PolicyResult | null> {
  if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
  const [admin] = await forShare(
    db
      .select({ role: authUser.role, twoFactorEnabled: authUser.twoFactorEnabled })
      .from(actors)
      .innerJoin(authUser, eq(authUser.id, actors.userId))
      .where(eq(actors.id, principal.actorId)),
    lock,
  );
  if (admin?.role !== 'admin') return deny('auth.admin_required');
  if (!admin.twoFactorEnabled) return deny('admin.two_factor_required');
  return null;
}

type PageSubject = { slug: string; language: string };

/** The admin check, then the page must be one the instance has: a fixed slug in a known language. */
async function pageDenial({ principal, subject, db, lock }: PolicyRequest<PageSubject>): Promise<PolicyResult | null> {
  const denied = await denyUnlessAdmin(principal, db, lock);
  if (denied) return denied;
  return isPageSlug(subject.slug) && isPageLanguage(subject.language) ? null : deny('target.not_found');
}

export const policies = {
  /** An admin with two-factor changes site settings. The subject names the keys, which the body takes from the grant. */
  'settings.update': async ({ principal, db, lock }: PolicyRequest<{ keys: string[] }>) =>
    (await denyUnlessAdmin(principal, db, lock)) ?? allow({ kind: 'site-admin', actorId: principal.actorId }),

  /** An admin with two-factor saves the draft of a page, creating it when that language has none yet. The body writes the draft row; no decision rests on it. */
  'page.save': async (request: PolicyRequest<PageSubject>) =>
    (await pageDenial(request)) ?? allow({ kind: 'site-admin', actorId: request.principal.actorId }),

  /**
   * An admin with two-factor publishes a draft that exists and has nothing left to fill: the
   * draft is read FOR NO KEY UPDATE (the body points it at the new revision) and the operator's
   * details FOR SHARE, and every {{TOKEN}} must resolve (page.unresolved_tokens).
   */
  'page.publish': async (request: PolicyRequest<PageSubject>) => {
    const denied = await pageDenial(request);
    if (denied) return denied;
    const prepared = await prepareRevision(request.db, request.subject, request.lock);
    return prepared.ok ? allow({ kind: 'site-admin', actorId: request.principal.actorId }) : deny(prepared.reason);
  },

  /** An admin with two-factor withdraws a published page; the draft stays. The draft row is read FOR NO KEY UPDATE, as the body updates it. */
  'page.unpublish': async (request: PolicyRequest<PageSubject>) => {
    const denied = await pageDenial(request);
    if (denied) return denied;
    const [draft] = await forNoKeyUpdate(
      request.db
        .select({ published: pages.publishedRevision })
        .from(pages)
        .where(and(eq(pages.slug, request.subject.slug), eq(pages.language, request.subject.language))),
      request.lock,
    );
    if (!draft) return deny('target.not_found');
    if (!draft.published) return deny('page.not_published');
    return allow({ kind: 'site-admin', actorId: request.principal.actorId });
  },
};
