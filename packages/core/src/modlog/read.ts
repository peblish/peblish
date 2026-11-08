import { ModlogDetails, ModlogFilter, type ModlogAudience, type ModlogEntry } from '@peblish/schema/modlog';
import { Authority } from '@peblish/schema/authz';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';

const isPublic = sql`coalesce((${modlog.details}->>'public')::boolean, true)`;

/** The host an actor's ap_id lives on, or null when it is not a URL. */
const hostOf = (apId: string) => URL.parse(apId)?.host ?? null;

/**
 * The modlog, newest first, filtered by community, actor, action and time range [since,
 * until). The public audience sees only public rows; staff (a community's moderators, site
 * admins: the caller decides) see all. A reason written on another instance is returned only
 * when that instance's domain is in `trustedInstances` (the actor's ap_id decides where a row
 * was written); otherwise it is withheld and reasonWithheld says so.
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
  if (options.audience === 'public') conditions.push(isPublic);
  const rows = await q
    .select()
    .from(modlog)
    .where(and(...conditions))
    .orderBy(desc(modlog.createdAt), desc(modlog.id))
    .limit(limit);
  const trusted = new Set([
    hostOf((await localInstance(q)).origin),
    ...(options.trustedInstances ?? []).map((domain) => domain.toLowerCase()),
  ]);
  return rows.map((row) => {
    const host = hostOf(row.actorApId);
    const shown = host !== null && trusted.has(host);
    const details = ModlogDetails.assert(row.details);
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
      authority: Authority.assert(row.authority),
      details,
      public: details.public ?? true,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
