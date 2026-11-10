import type { Uuid } from '@peblish/schema/ids';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { authUser } from '../../db/tables/auth.ts';
import { siteBans } from '../../bans/tables.ts';
import { allow, deny, forNoKeyUpdate, forShare, type PolicyRequest, type PolicyResult } from '../policy.ts';

// Lane MODF: site-level ban and unban of a Person, local or remote (M06). Community-scope
// moderation (remove, restore, lock, pin, community ban) lives in actions/moderation.ts, owned
// by lane AZ. Both emit mod.ban (communityId null here).
//
// A site ban is an INSERT, so the policies lock the target actor row FOR NO KEY UPDATE, the
// row the ban mutation locks before inserting and the banned actor's own rechecked writes
// lock FOR SHARE in the principal refresh (PolicyRequest.lock). The ban row is read the same
// way: a new ban replaces an expired one.
//
// Who may act: a two-factor admin on anyone; or a remote principal on its own people. A remote
// instance's Block aimed at this instance bans one of its own people (Lemmy and PieFed send
// it only for them, and receivers never check admin status: the origin rule is all there is),
// under owner authority. An announced activity is refused: a community speaks for its own
// content, not for the site.

type Subject = { targetActorId: Uuid };

const target = (request: PolicyRequest<Subject>) =>
  forNoKeyUpdate(
    request.db
      .select({
        id: actors.id,
        kind: actors.kind,
        local: actors.local,
        userId: actors.userId,
        instanceId: actors.instanceId,
        deletedAt: actors.deletedAt,
      })
      .from(actors)
      .where(eq(actors.id, request.subject.targetActorId)),
    request.lock,
  );

/** Whether the target is banned from the site now (a row that has not expired), by a ban of this source when one is asked for. */
async function siteBanned(request: PolicyRequest<Subject>, source?: 'remote'): Promise<boolean> {
  const [row] = await forNoKeyUpdate(
    request.db
      .select({ actorId: siteBans.actorId })
      .from(siteBans)
      .where(
        and(
          eq(siteBans.actorId, request.subject.targetActorId),
          or(isNull(siteBans.expiresAt), gt(siteBans.expiresAt, sql`now()`)),
          source ? eq(siteBans.source, source) : undefined,
        ),
      ),
    request.lock,
  );
  return !!row;
}

/** The refusal the ban state calls for, or null when the action may go on; `source` limits which bans an unban can see. */
const banState = async (request: PolicyRequest<Subject>, banning: boolean, source?: 'remote'): Promise<PolicyResult | null> => {
  if (banning) return (await siteBanned(request)) ? deny('target.site_banned') : null;
  return (await siteBanned(request, source)) ? null : deny('target.not_site_banned');
};

const siteBanBy =
  (banning: boolean) =>
  async (request: PolicyRequest<Subject>): Promise<PolicyResult> => {
    const { principal, lock, db } = request;
    if (principal.kind === 'remote') {
      if (principal.announcedBy) return deny('mod.announce_mismatch');
      return remoteSiteBan(request, banning);
    }
    if (principal.kind !== 'local' || principal.siteRole !== 'admin') return deny('auth.admin_required');
    const [person] = await target(request);
    // A Service (a bot) is a person for a ban; the instance's Application is refused as protected below.
    if (!person || person.kind === 'Group') return deny('target.not_found');
    if (person.id === principal.actorId || person.kind === 'Application') return deny('target.protected');
    if (person.userId) {
      const [user] = await forShare(db.select({ role: authUser.role }).from(authUser).where(eq(authUser.id, person.userId)), lock);
      if (user?.role === 'admin') return deny('target.protected');
    }
    if (banning && person.deletedAt) return deny('target.deleted');
    return (await banState(request, banning)) ?? allow({ kind: 'site-admin', actorId: principal.actorId });
  };

/** A peer bans, or lifts the ban of, one of its own people: the instance of the acting actor must be the target's. */
async function remoteSiteBan(request: PolicyRequest<Subject>, banning: boolean): Promise<PolicyResult> {
  const { principal, db, lock } = request;
  const [person] = await target(request);
  if (!person || (person.kind !== 'Person' && person.kind !== 'Service')) return deny('target.not_found');
  if (person.local) return deny('ban.not_remote');
  if (person.id === principal.actorId) return deny('target.protected');
  const [actor] = await forShare(db.select({ instanceId: actors.instanceId }).from(actors).where(eq(actors.id, principal.actorId)), lock);
  if (actor?.instanceId !== person.instanceId) return deny('ban.origin_mismatch');
  if (banning && person.deletedAt) return deny('target.deleted');
  // An Undo from the peer lifts only a ban a peer set: ours stays.
  return (await banState(request, banning, 'remote')) ?? allow({ kind: 'owner', actorId: principal.actorId });
}

export const policies = {
  'mod.site_ban': siteBanBy(true),
  'mod.site_unban': siteBanBy(false),
};
