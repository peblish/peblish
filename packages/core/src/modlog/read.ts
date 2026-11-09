import { ModlogDetails, ModlogFilter, type ModlogAudience, type ModlogEntry } from '@peblish/schema/modlog';
import { Authority } from '@peblish/schema/authz';
import { and, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';
import type { Uuid } from '@peblish/schema/ids';
import { readSetting } from '../settings/read.ts';

/** The host an actor's ap_id lives on, or null when it is not a URL. */
const hostOf = (apId: string) => URL.parse(apId)?.host ?? null;

/**
 * The ap_ids that vouch for a row: its actor, plus the announcing community when that
 * community's Announce was the authority (it may attribute the action to an actor on another
 * instance). Null for such a row with no community on record, which is then never trusted.
 */
function vouchers(actorApId: string, authority: Authority, details: ModlogDetails): string[] | null {
  if (authority.kind !== 'community-announce') return [actorApId];
  return details.announcedBy ? [actorApId, details.announcedBy] : null;
}

/**
 * The modlog, newest first, filtered by community, actor, action and time range [since,
 * until). The public audience sees only public rows; staff (a community's moderators, site
 * admins: the caller decides) see all. A reason written on another instance is returned only
 * when that instance's domain is in `trustedInstances`: the actor's instance (its ap_id decides
 * where a row was written) and, under community-announce authority, the announcing
 * community's too. Otherwise it is withheld and reasonWithheld says so. `trustedInstances`
 * defaults to the `modlog.trusted_instances` site setting; pass it to override.
 */
export async function readModlog(
  filter: ModlogFilter,
  options: { audience: ModlogAudience; trustedInstances?: readonly string[]; db?: Queryable },
): Promise<ModlogEntry[]> {
  const { communityId, actorId, action, since, until, limit = 50 } = ModlogFilter.assert(filter);
  const q = options.db ?? readDb();
  const conditions: SQL[] = [];
  if (communityId) conditions.push(eq(modlog.communityId, communityId));
  if (actorId) conditions.push(eq(modlog.actorId, actorId));
  if (action) conditions.push(eq(modlog.action, action));
  if (since) conditions.push(gte(modlog.createdAt, new Date(since)));
  if (until) conditions.push(lt(modlog.createdAt, new Date(until)));
  if (options.audience === 'public') conditions.push(eq(modlog.public, true));
  const rows = await q
    .select()
    .from(modlog)
    .where(and(...conditions))
    .orderBy(desc(modlog.createdAt), desc(modlog.id))
    .limit(limit);
  return entries(rows, q, options.trustedInstances);
}

/**
 * The modlog rows with these ids, newest first, under readModlog's audience and trust rules:
 * the public audience gets only public rows, and a reason from an untrusted instance is
 * withheld. Ids with no row (or no row the audience may see) are left out. For readers that
 * hold modlog ids already, such as notifications.
 */
export async function readModlogEntries(
  ids: readonly Uuid[],
  options: { audience: ModlogAudience; trustedInstances?: readonly string[]; db?: Queryable },
): Promise<ModlogEntry[]> {
  if (ids.length === 0) return [];
  const q = options.db ?? readDb();
  const conditions: SQL[] = [inArray(modlog.id, [...ids])];
  if (options.audience === 'public') conditions.push(eq(modlog.public, true));
  const rows = await q
    .select()
    .from(modlog)
    .where(and(...conditions))
    .orderBy(desc(modlog.createdAt), desc(modlog.id));
  return entries(rows, q, options.trustedInstances);
}

/** Rows as entries, each reason shown only when every instance that vouches for it is trusted. */
async function entries(
  rows: (typeof modlog.$inferSelect)[],
  q: Queryable,
  trustedInstances: readonly string[] | undefined,
): Promise<ModlogEntry[]> {
  if (rows.length === 0) return [];
  const trusted = new Set([
    hostOf((await localInstance(q)).origin),
    ...(trustedInstances ?? (await readSetting('modlog.trusted_instances', q))).map((domain) => domain.toLowerCase()),
  ]);
  const isTrusted = (apId: string) => {
    const host = hostOf(apId);
    return host !== null && trusted.has(host);
  };
  return rows.map((row) => {
    const details = ModlogDetails.assert(row.details);
    const authority = Authority.assert(row.authority);
    const shown = vouchers(row.actorApId, authority, details)?.every(isTrusted) ?? false;
    return {
      id: row.id,
      action: row.action,
      actorId: row.actorId,
      actorApId: row.actorApId,
      communityId: row.communityId,
      communityApId: row.communityApId,
      targetActorId: row.targetActorId,
      targetPostId: row.targetPostId,
      targetCommentId: row.targetCommentId,
      targetApId: row.targetApId,
      reason: shown ? row.reason : null,
      reasonWithheld: !shown && row.reason !== null,
      authority,
      details,
      public: row.public,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
