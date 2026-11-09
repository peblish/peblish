import type { Uuid } from '@peblish/schema/ids';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { communityState } from '../authz/state.ts';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { communityModerators } from '../db/tables/moderation.ts';
import { locked, vanished } from '../moderation/shared.ts';
import { writeModlog } from '../modlog/write.ts';
import { defineMutation } from '../tx/mutation.ts';

// Owned by lane FED-B (REM inherits it). A remote community publishes its moderators as a
// collection on its own origin; community_moderators keeps a copy (source 'remote') that
// grants nothing unless it was verified and has not expired (authz/roles.ts: freshModerator).
// The copy is refetched when the community announces a change (Add or Remove on the
// collection) and by a job before it runs out, so a removed moderator loses authority within a
// bounded time even if the Remove never reached us (spike carry-forward finding 1).

/** How long a mirrored row grants after it was last confirmed. */
export const moderatorsTtlMs = 12 * 60 * 60 * 1000;
/** A mirror with less than this left is refreshed by the job. */
export const refreshWithinMs = 2 * 60 * 60 * 1000;
/** Most moderators mirrored for one community; a longer list is cut (nobody moderates with fifty). */
export const maxMirrored = 50;

/** How long a community whose collection had nobody in it is left alone before it is fetched again. */
export const emptyMirrorBackoffMs = 6 * 60 * 60 * 1000;

// Communities to leave alone until a time, kept in memory per process (on globalThis because the web
// build can hold two copies of a module): without a row to show when a community was last asked,
// one with an empty collection would be due at every run of the job and take a slot of every batch.
const deferred = ((globalThis as { __peblishMirrorDeferred?: Map<Uuid, number> }).__peblishMirrorDeferred ??= new Map());
const deferredMax = 10_000;

/** Leaves `communityId` out of communitiesDueForMirror for `ms`. */
export function deferMirror(communityId: Uuid, ms: number, now = Date.now()): void {
  deferred.delete(communityId);
  deferred.set(communityId, now + ms);
  if (deferred.size > deferredMax) deferred.delete(deferred.keys().next().value!);
}

/** Forgets every deferral (tests). */
export const forgetDeferredMirrors = (): void => deferred.clear();

export type MirrorInput = {
  /** Actor ids of the collection's members, as federation resolved them. */
  moderatorIds: readonly Uuid[];
  /** The collection the list was read from, kept in the modlog for the record. */
  collection: string;
};

/**
 * Replaces the community's remote moderator rows with `moderatorIds`: new members are added,
 * members still listed are confirmed again (verified now, expiring in twelve hours), members
 * no longer listed are removed. Every addition and removal writes a modlog row (kept out of
 * the public log: it records what the peer published, not a decision made here) and emits
 * mod.role, so the moderator cache forgets the actor. Rows a local owner appointed
 * (source 'local') are never touched. The community row is locked first.
 */
export const mirrorModerators = defineMutation({
  action: 'remote.moderators_mirror',
  emits: ['mod.role'],
  async run(t, grant, input: MirrorInput) {
    const { communityId } = grant.subject;
    const community = await communityState(locked(t.db), communityId);
    if (!community) throw vanished(`community ${communityId}`);
    const wanted = new Map<Uuid, string>();
    const listed = [...new Set(input.moderatorIds)].slice(0, maxMirrored);
    if (listed.length > 0) {
      const people = await t.db
        .select({ id: actors.id, apId: actors.apId })
        .from(actors)
        .where(and(inArray(actors.id, listed), inArray(actors.kind, ['Person', 'Service']), sql`${actors.deletedAt} is null`));
      for (const person of people) wanted.set(person.id, person.apId);
    }
    const held = await t.db
      .select({ id: communityModerators.moderatorId, source: communityModerators.source, apId: actors.apId })
      .from(communityModerators)
      .innerJoin(actors, eq(actors.id, communityModerators.moderatorId))
      .where(eq(communityModerators.communityId, communityId))
      .for('no key update', { of: communityModerators });
    const remote = new Map(held.filter((row) => row.source === 'remote').map((row) => [row.id, row.apId]));
    const local = new Set(held.filter((row) => row.source === 'local').map((row) => row.id));
    const now = new Date();
    const row = { role: 'moderator', source: 'remote', verifiedAt: now, expiresAt: new Date(now.getTime() + moderatorsTtlMs) } as const;
    const changed = async (actorId: Uuid, apId: string, role: 'moderator' | null) => {
      const modlogId = await writeModlog(t.db, grant, {
        community,
        target: { actorId, apId },
        reason: null,
        details: { public: false },
        activityApId: null,
      });
      await t.emit({ type: 'mod.role', v: 1, modlogId, moderatorId: grant.actorId, local: false, communityId, actorId, role });
    };
    let added = 0;
    let removed = 0;
    for (const [actorId, apId] of wanted) {
      if (local.has(actorId)) continue;
      await t.db
        .insert(communityModerators)
        .values({ communityId, moderatorId: actorId, ...row })
        .onConflictDoUpdate({
          target: [communityModerators.communityId, communityModerators.moderatorId],
          set: { verifiedAt: row.verifiedAt, expiresAt: row.expiresAt },
          setWhere: eq(communityModerators.source, 'remote'),
        });
      if (!remote.has(actorId)) {
        added += 1;
        await changed(actorId, apId, 'moderator');
      }
    }
    for (const [actorId, apId] of remote) {
      if (wanted.has(actorId)) continue;
      await t.db
        .delete(communityModerators)
        .where(and(eq(communityModerators.communityId, communityId), eq(communityModerators.moderatorId, actorId)));
      removed += 1;
      await changed(actorId, apId, null);
    }
    return { added, removed, confirmed: wanted.size - added };
  },
});

/**
 * Remote communities whose mirrored moderators are due a refetch: a local person follows them,
 * they publish a moderators collection, and they have no mirrored row yet or one that runs out
 * within `refreshWithinMs`, except those deferred (deferMirror). Oldest expiry first.
 */
export async function communitiesDueForMirror(q: Queryable, limit = 20, now = Date.now()): Promise<{ id: Uuid; apId: string }[]> {
  for (const [id, until] of deferred) if (until <= now) deferred.delete(id);
  const waiting = [...deferred.keys()];
  const notDeferred =
    waiting.length > 0
      ? sql`and a.id not in (${sql.join(
          waiting.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const rows = await q.execute<{ id: Uuid; apId: string }>(sql`
    select a.id, a.ap_id as "apId"
    from actors a
    where a.kind = 'Group' and not a.local and a.deleted_at is null and a.moderators_url is not null ${notDeferred}
      and exists (
        select 1 from follows f join actors p on p.id = f.follower_id where f.followee_id = a.id and p.local)
      and (
        not exists (select 1 from community_moderators m where m.community_id = a.id and m.source = 'remote')
        or exists (
          select 1 from community_moderators m
          where m.community_id = a.id and m.source = 'remote'
            and (m.expires_at is null or m.expires_at < now() + ${refreshWithinMs} * interval '1 millisecond')))
    order by (select min(m.expires_at) from community_moderators m where m.community_id = a.id and m.source = 'remote') nulls first, a.id
    limit ${limit}`);
  return [...rows];
}
