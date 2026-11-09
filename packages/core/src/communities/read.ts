import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, CommunityView } from '@peblish/schema/views';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors, communityLanguages } from '../db/tables/actors.ts';
import { follows } from '../db/tables/follows.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { sanitizeRemoteHtml, type SanitizeHooks } from '../markdown/sanitize.ts';
import { communityRemovals } from '../moderation/tables.ts';
import { communityRules } from './tables.ts';

// Read models of communities (lane F). A community that is deleted or removed by an admin reads
// as absent. Every URL and id comes from the stored row: an imported community keeps the
// ap_id it had (G0 contract 6), so nothing here rebuilds one from a name.

export type CommunityRule = { position: number; title: string; bodyMd: string | null; bodyHtml: string | null };

/**
 * One community for its page and its edit form: the shared CommunityView plus what only a
 * page needs. `summaryMd` is the Markdown source of a local sidebar, which pages render
 * themselves; `summaryHtml` is the HTML to print: federation's form as stored for a local
 * community, and for a remote one the peer's HTML sanitised on read (see readCommunity).
 * Rules and the posting warning exist for local communities only; a remote community's are
 * empty.
 */
export type CommunityDetail = CommunityView & {
  nsfl: boolean;
  /** Search consent (Mastodon's discoverable and indexable); a page is `noindex` when `indexable` is false. */
  discoverable: boolean;
  indexable: boolean;
  postingWarning: string | null;
  summaryMd: string | null;
  /**
   * The stored image URLs, raw. Nothing here sets them yet (uploads are off), but imported and
   * remote communities have them. A page must not put either in an `<img>` as it is: pass it
   * through `createMarkdownRenderer(site).image()` (web/server/markdown.ts), which keeps this
   * instance's own URLs, sends a remote one through the signed media proxy and answers null when
   * it must not load (decision 5: viewers' addresses never reach remote hosts).
   */
  iconUrl: string | null;
  bannerUrl: string | null;
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

/**
 * A remote Group's `summary` is peer HTML, stored as it arrived. It is sanitised against the
 * Group's ap_id here, so no caller can print it raw. An image loads only where the page's hook
 * (the renderer's `image()`) sends it, normally the signed media proxy; without a hook, or when
 * the hook answers null, it shows as a link, never as a remote `<img src>`.
 */
function remoteSummary(html: string | null, apId: string, hooks: SanitizeHooks): string | null {
  if (html === null) return null;
  return sanitizeRemoteHtml(html, { baseUrl: apId, images: hooks.rewriteImageUrl ? 'inline' : 'link', ...hooks }).html;
}

/**
 * A community by id (any Group, local or remote) or by local name (any case), or null. A local
 * community's `summaryHtml` is returned as stored; a remote one's is sanitised on read, with
 * images as links unless `hooks.rewriteImageUrl` says where to load them from.
 */
export async function readCommunity(
  key: { id: Uuid } | { name: string },
  q: Queryable = readDb(),
  hooks: SanitizeHooks = {},
): Promise<CommunityDetail | null> {
  const [row] = await q
    .select({
      ...refColumns,
      summaryMd: actors.summaryMd,
      summaryHtml: actors.summaryHtml,
      iconUrl: actors.iconUrl,
      bannerUrl: actors.bannerUrl,
      sensitive: actors.sensitive,
      nsfl: actors.nsfl,
      discoverable: actors.discoverable,
      indexable: actors.indexable,
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
    summaryHtml: row.local ? row.summaryHtml : remoteSummary(row.summaryHtml, row.apId, hooks),
    summaryMd: row.summaryMd,
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
    sensitive: row.sensitive,
    nsfl: row.nsfl,
    discoverable: row.discoverable,
    indexable: row.indexable,
    postingRestrictedToMods: row.postingRestrictedToMods,
    postingWarning: row.postingWarning,
    subscribers: row.subscribers,
    languages: languages.map((entry) => entry.language),
    rules,
  };
}

/**
 * The id of the community a path names: `name` (any case) is a local community, `name@host` a
 * remote one, and `name@<this instance's domain>` the local one again. Null when nothing matches.
 * It does not look at deletion or removal: readCommunity and readCommunityPage answer for that.
 */
export async function findCommunityId(handle: string, q: Queryable = readDb()): Promise<Uuid | null> {
  const at = handle.lastIndexOf('@');
  const name = (at < 0 ? handle : handle.slice(0, at)).toLowerCase();
  const host = at < 0 ? null : handle.slice(at + 1).toLowerCase();
  if (!name || host === '') return null;
  const [row] = await q
    .select({ id: actors.id, local: actors.local })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        eq(actors.kind, 'Group'),
        sql`lower(${actors.name}) = ${name}`,
        host === null ? eq(actors.local, true) : sql`lower(${instances.domain}) = ${host}`,
      ),
    )
    .orderBy(asc(actors.createdAt), asc(actors.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The communities of this instance (imported ones included), by name. `includeSensitive`
 * defaults to false, which leaves out every community flagged sensitive or NSFL: the caller
 * passes true only for a viewer who declared 16+ and has not hidden NSFW, since a signed-out
 * or undeclared viewer never sees an age-gated community listed. At most `limit` rows (200 by default, 500 at most); the beta has a handful.
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
        // Not safe for life implies the age gate for communities made here, but an imported one may carry only nsfl.
        options.includeSensitive ? undefined : and(eq(actors.sensitive, false), eq(actors.nsfl, false)),
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
 * The freshness rule is roles.ts's (`freshModerator`): a local row until its expiry, if any, a
 * mirrored remote row only once verified and until its expiry.
 */
export async function listModerators(communityId: Uuid, q: Queryable = readDb()): Promise<CommunityModerator[]> {
  const rows = await q
    .select({ ...refColumns, role: communityModerators.role })
    .from(communityModerators)
    .innerJoin(actors, eq(actors.id, communityModerators.moderatorId))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(and(eq(communityModerators.communityId, communityId), isNull(actors.deletedAt), freshModerator))
    .orderBy(sql`${communityModerators.role} = 'owner' desc`, asc(communityModerators.createdAt), asc(actors.id));
  return rows.map((row) => ({ actor: actorRef(row), role: row.role }));
}
