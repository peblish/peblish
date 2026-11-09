import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, CommunityView } from '@peblish/schema/views';
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors, communityLanguages } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { communityRules } from './tables.ts';

// Read models of communities (lane F). A community that is deleted or removed by an admin reads
// as absent. Every URL and id comes from the stored row: an imported community keeps the
// ap_id it had (G0 contract 6), so nothing here rebuilds one from a name.

export type CommunityRule = { position: number; title: string; bodyMd: string | null; bodyHtml: string | null };

/**
 * One community for its page and its edit form: the shared CommunityView plus what only a
 * page needs. `summaryMd` is the Markdown source of a local sidebar, which pages render
 * themselves; `summaryHtml` is the stored HTML (federation's form for a local community, the
 * sanitised remote HTML for a remote one). Rules and the posting warning exist for local
 * communities only; a remote community's are empty.
 */
export type CommunityDetail = CommunityView & {
  nsfl: boolean;
  postingWarning: string | null;
  summaryMd: string | null;
  /** ISO 639 codes, sorted. */
  languages: string[];
  rules: CommunityRule[];
};

/** A row of the community list: what the composer's picker and the sidebar show. */
export type CommunityListItem = Pick<CommunityView, 'actor' | 'sensitive' | 'postingRestrictedToMods' | 'subscribers'> & { nsfl: boolean };

export type CommunityModerator = { actor: ActorRef; role: 'owner' | 'moderator' };

/** A follower whose Follow was accepted counts as a subscriber, local or remote. */
const subscriberCount = sql<number>`(select count(*)::int from ${follows} where ${follows.followeeId} = ${actors.id} and ${follows.state} = 'accepted')`;
const notRemoved = sql`not exists (select 1 from ${communityRemovals} where ${communityRemovals.communityId} = ${actors.id})`;

const refColumns = {
  id: actors.id,
  apId: actors.apId,
  kind: actors.kind,
  name: actors.name,
  displayName: actors.displayName,
  local: actors.local,
  host: instances.domain,
};

/** name for a local actor, name@host for a remote one (views.ts: ActorRef.handle). */
function actorRef(row: {
  id: Uuid;
  apId: string;
  kind: ActorRef['kind'];
  name: string;
  displayName: string | null;
  local: boolean;
  host: string;
}): ActorRef {
  return {
    id: row.id,
    apId: row.apId,
    kind: row.kind,
    name: row.name,
    displayName: row.displayName,
    local: row.local,
    handle: row.local ? row.name : `${row.name}@${row.host}`,
  };
}

/** A community by id (any Group, local or remote) or by local name (any case), or null. */
export async function readCommunity(key: { id: Uuid } | { name: string }, q: Queryable = readDb()): Promise<CommunityDetail | null> {
  const [row] = await q
    .select({
      ...refColumns,
      summaryMd: actors.summaryMd,
      summaryHtml: actors.summaryHtml,
      sensitive: actors.sensitive,
      nsfl: actors.nsfl,
      postingRestrictedToMods: actors.postingRestrictedToMods,
      postingWarning: actors.postingWarning,
      subscribers: subscriberCount,
    })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(actors.kind, 'Group'),
        isNull(actors.deletedAt),
        notRemoved,
        'id' in key ? eq(actors.id, key.id) : and(eq(actors.local, true), sql`lower(${actors.name}) = ${key.name.toLowerCase()}`),
      ),
    );
  if (!row) return null;
  const [languages, rules] = await Promise.all([
    q
      .select({ language: communityLanguages.language })
      .from(communityLanguages)
      .where(eq(communityLanguages.communityId, row.id))
      .orderBy(asc(communityLanguages.language)),
    q
      .select({
        position: communityRules.position,
        title: communityRules.title,
        bodyMd: communityRules.bodyMd,
        bodyHtml: communityRules.bodyHtml,
      })
      .from(communityRules)
      .where(eq(communityRules.communityId, row.id))
      .orderBy(asc(communityRules.position)),
  ]);
  return {
    actor: actorRef(row),
    summaryHtml: row.summaryHtml,
    summaryMd: row.summaryMd,
    sensitive: row.sensitive,
    nsfl: row.nsfl,
    postingRestrictedToMods: row.postingRestrictedToMods,
    postingWarning: row.postingWarning,
    subscribers: row.subscribers,
    languages: languages.map((entry) => entry.language),
    rules,
  };
}

/**
 * The communities of this instance (imported ones included), by name. `includeSensitive`
 * defaults to false: the caller passes true only for a viewer who declared 16+ and has not
 * hidden NSFW, since a signed-out or undeclared viewer never sees an age-gated community
 * listed. At most `limit` rows (200 by default, 500 at most); the beta has a handful.
 */
export async function listLocalCommunities(
  options: { includeSensitive?: boolean; limit?: number } = {},
  q: Queryable = readDb(),
): Promise<CommunityListItem[]> {
  const rows = await q
    .select({
      ...refColumns,
      sensitive: actors.sensitive,
      nsfl: actors.nsfl,
      postingRestrictedToMods: actors.postingRestrictedToMods,
      subscribers: subscriberCount,
    })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(actors.kind, 'Group'),
        eq(actors.local, true),
        isNull(actors.deletedAt),
        notRemoved,
        options.includeSensitive ? undefined : eq(actors.sensitive, false),
      ),
    )
    .orderBy(sql`lower(${actors.name})`)
    .limit(Math.min(Math.max(options.limit ?? 200, 1), 500));
  return rows.map((row) => ({
    actor: actorRef(row),
    sensitive: row.sensitive,
    nsfl: row.nsfl,
    postingRestrictedToMods: row.postingRestrictedToMods,
    subscribers: row.subscribers,
  }));
}

/**
 * The community's moderators who hold a role now, owners first, then in the order appointed.
 * The freshness rule is roles.ts's (`fresh`): a local row until its expiry, if any, a mirrored
 * remote row only once verified and until its expiry.
 */
export async function listModerators(communityId: Uuid, q: Queryable = readDb()): Promise<CommunityModerator[]> {
  const rows = await q
    .select({ ...refColumns, role: communityModerators.role })
    .from(communityModerators)
    .innerJoin(actors, eq(actors.id, communityModerators.moderatorId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(communityModerators.communityId, communityId),
        isNull(actors.deletedAt),
        or(
          and(
            eq(communityModerators.source, 'local'),
            or(isNull(communityModerators.expiresAt), gt(communityModerators.expiresAt, sql`now()`)),
          ),
          and(
            eq(communityModerators.source, 'remote'),
            isNotNull(communityModerators.verifiedAt),
            gt(communityModerators.expiresAt, sql`now()`),
          ),
        ),
      ),
    )
    .orderBy(sql`${communityModerators.role} = 'owner' desc`, asc(communityModerators.createdAt), asc(actors.id));
  return rows.map((row) => ({ actor: actorRef(row), role: row.role }));
}
