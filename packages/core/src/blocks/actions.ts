import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import type { BlockTarget } from '../authz/actions/blocks.ts';
import type { Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { instances } from '../db/tables/instances.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { addBlock, removeBlock } from './mutations.ts';
import { communityBlocks, instanceBlocks, personBlocks } from './tables.ts';

// The block list as web calls it: authorize, run the mutation, answer with a result (a refusal
// from the precheck or from the mutation alike), plus the reads the settings page draws and
// the lookup that turns what someone typed into a target.

export type { BlockTarget } from '../authz/actions/blocks.ts';

export async function addBlockAs(principal: Principal, target: BlockTarget): Promise<Result<{ created: boolean; unfollowed: number }>> {
  const decision = await authorize('block.add', principal, { target });
  if (!decision.ok) return decision;
  return refusedAsResult(() => addBlock(decision.grant));
}

/** Lifting a block that is not there succeeds with `removed: false`. */
export async function removeBlockAs(principal: Principal, target: BlockTarget): Promise<Result<{ removed: boolean }>> {
  const decision = await authorize('block.remove', principal, { target });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removeBlock(decision.grant));
}

export type BlockKind = BlockTarget['kind'];

/** One blocked person or community, newest block first in the lists. */
export type BlockedActor = { actor: ActorRef; blockedAt: string };
/** One blocked instance with what it hides: the people and the communities stored from it. */
export type BlockedInstance = { id: Uuid; domain: string; blockedAt: string; people: number; communities: number };

/** The people or communities a person blocks, newest first. Deleted ones stay listed, so they can be unblocked. */
export async function listBlocks(q: Queryable, blockerId: Uuid, kind: 'person' | 'community'): Promise<BlockedActor[]> {
  const [table, targetColumn] =
    kind === 'person' ? ([personBlocks, personBlocks.blockedId] as const) : ([communityBlocks, communityBlocks.communityId] as const);
  const rows = await q
    .select({
      id: actors.id,
      apId: actors.apId,
      kind: actors.kind,
      name: actors.name,
      displayName: actors.displayName,
      local: actors.local,
      domain: instances.domain,
      blockedAt: table.createdAt,
    })
    .from(table)
    .innerJoin(actors, eq(actors.id, targetColumn))
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(eq(table.blockerId, blockerId))
    .orderBy(desc(table.createdAt), desc(actors.id));
  return rows.map(({ domain, blockedAt, ...actor }) => ({
    actor: { ...actor, handle: actor.local ? actor.name : `${actor.name}@${domain}` },
    blockedAt: blockedAt.toISOString(),
  }));
}

/** The instances a person blocks, newest first, each with the number of people and communities it hides. */
export async function listInstanceBlocks(q: Queryable, blockerId: Uuid): Promise<BlockedInstance[]> {
  const rows = await q
    .select({ id: instances.id, domain: instances.domain, blockedAt: instanceBlocks.createdAt })
    .from(instanceBlocks)
    .innerJoin(instances, eq(instances.id, instanceBlocks.instanceId))
    .where(eq(instanceBlocks.blockerId, blockerId))
    .orderBy(desc(instanceBlocks.createdAt), desc(instances.id));
  if (rows.length === 0) return [];
  const footprint = await q
    .select({
      instanceId: actors.instanceId,
      groups: sql<number>`count(*) filter (where ${actors.kind} = 'Group')`.mapWith(Number),
      people: sql<number>`count(*) filter (where ${actors.kind} in ('Person', 'Service'))`.mapWith(Number),
    })
    .from(actors)
    .where(
      and(
        sql`${actors.deletedAt} is null`,
        inArray(
          actors.instanceId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .groupBy(actors.instanceId);
  const byInstance = new Map(footprint.map((row) => [row.instanceId, row]));
  return rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    blockedAt: row.blockedAt.toISOString(),
    people: byInstance.get(row.id)?.people ?? 0,
    communities: byInstance.get(row.id)?.groups ?? 0,
  }));
}

/** How many of each kind a person blocks: the tab counts. */
export async function blockCounts(q: Queryable, blockerId: Uuid): Promise<Record<BlockKind, number>> {
  const [[person], [community], [instance]] = await Promise.all([
    q.select({ n: count() }).from(personBlocks).where(eq(personBlocks.blockerId, blockerId)),
    q.select({ n: count() }).from(communityBlocks).where(eq(communityBlocks.blockerId, blockerId)),
    q.select({ n: count() }).from(instanceBlocks).where(eq(instanceBlocks.blockerId, blockerId)),
  ]);
  return { person: person?.n ?? 0, community: community?.n ?? 0, instance: instance?.n ?? 0 };
}

export type ResolvedBlock = { target: BlockTarget; label: string };
export type ResolveError = 'handle.invalid' | 'handle.not_found';

const namePattern = /^[\p{L}\p{N}_.-]{1,100}$/u;
const hostPattern = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * Turns what someone typed into a target, against the actors and instances this server
 * stores (it fetches nothing): `@name@host` (or `@name`, a local person) for a person,
 * `!name@host` for a community, a host or a URL for an instance. `handle.invalid` is a shape
 * that cannot be a handle; `handle.not_found` is a well-formed one with no match here.
 */
export async function resolveBlockTarget(
  q: Queryable,
  kind: BlockKind,
  input: string,
): Promise<Result<ResolvedBlock> | { ok: false; reason: ResolveError }> {
  const typed = input.trim();
  if (kind === 'instance') {
    let host = typed;
    if (host.includes('://')) {
      try {
        host = new URL(host).host;
      } catch {
        return { ok: false, reason: 'handle.invalid' };
      }
    } else {
      host = host.split(/[/?#]/, 1)[0] ?? '';
    }
    host = host.toLowerCase();
    if (!hostPattern.test(host)) return { ok: false, reason: 'handle.invalid' };
    const [row] = await q.select({ id: instances.id, domain: instances.domain }).from(instances).where(eq(instances.domain, host));
    return row
      ? { ok: true, target: { kind: 'instance', instanceId: row.id }, label: row.domain }
      : { ok: false, reason: 'handle.not_found' };
  }

  const sigil = kind === 'person' ? '@' : '!';
  const bare = typed.startsWith(sigil) ? typed.slice(1) : typed;
  const [name = '', host, ...rest] = bare.split('@');
  if (rest.length > 0 || !namePattern.test(name) || (host !== undefined && !hostPattern.test(host.toLowerCase()))) {
    return { ok: false, reason: 'handle.invalid' };
  }
  const kinds = kind === 'person' ? (['Person', 'Service'] as const) : (['Group'] as const);
  const rows = await q
    .select({ id: actors.id, name: actors.name, local: actors.local, domain: instances.domain })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(
      and(
        inArray(actors.kind, [...kinds]),
        sql`lower(${actors.name}) = ${name.toLowerCase()}`,
        host === undefined ? eq(instances.local, true) : eq(instances.domain, host.toLowerCase()),
      ),
    );
  // A remote name may differ from another only by case; prefer the exact one.
  const match = rows.find((row) => row.name === name) ?? rows[0];
  if (!match) return { ok: false, reason: 'handle.not_found' };
  const handle = match.local ? match.name : `${match.name}@${match.domain}`;
  return { ok: true, target: { kind, actorId: match.id }, label: `${sigil}${handle}` };
}
