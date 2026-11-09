import type { Uuid } from '@peblish/schema/ids';
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { inboxRaw } from '../db/tables/federation.ts';
import { instances } from '../db/tables/instances.ts';
import { deliveries } from '../delivery/tables.ts';
import { defineMutation } from '../tx/mutation.ts';
import { instanceHealth } from './tables.ts';

// Owned by lane REM. The dormant-instance policy. An instance whose deliveries have failed for a
// week and that has sent nothing in that week is dormant: the delivery worker skips it (rows end
// `skipped`) except for one probe a day. A probe that is delivered, or any activity the
// instance sends, revives it. The health job (health/job.ts) derives all of it from FED-A's
// `deliveries` table and the inbox, so delivery needs one question only: isDormant.
//
// The week is counted from the first failure the job saw (`instance_health.failing_since`), not
// from the age of the failed rows: a delivery row can be days old before its first attempt
// (the worker was down), and that is no evidence about the peer.

/** The policy's figures, as data. */
export const dormancy = {
  /** Deliveries that keep failing, seen failing this long by the health job, make an instance a candidate... */
  failingForMs: 7 * 24 * 60 * 60 * 1000,
  /** ...if it also sent us nothing for this long. */
  silentForMs: 7 * 24 * 60 * 60 * 1000,
  /** A dormant instance gets one delivery through this often. */
  probeEveryMs: 24 * 60 * 60 * 1000,
  /** A failed delivery in this window keeps the run "ongoing": a peer we stopped sending to is not failing. */
  ongoingWithinMs: 2 * 24 * 60 * 60 * 1000,
  /** One old failure is not a dead server. */
  minFailures: 3,
  /**
   * A probe claimed at question time (isDormant) that has no delivery attempt to show for it this
   * long after is given back: the worker died or lost the row before it sent anything.
   */
  probeSettleMs: 60 * 60 * 1000,
} as const;

export type FailingRun = { instanceId: Uuid };

/**
 * Instances whose deliveries fail and have not succeeded since: the failed (or retrying) rows
 * newer than the instance's last delivered row, grouped. A run counts while its latest failure is
 * within `ongoingWithinMs` and there are `minFailures` of them. How long it has lasted is the
 * health job's record (`failing_since`), not read from these rows.
 */
export async function failingRuns(now: Date): Promise<FailingRun[]> {
  const recent = new Date(now.getTime() - dormancy.ongoingWithinMs).toISOString();
  // The last success is looked up once for each instance with a failure, not once for each failure.
  const rows = await db().execute<{ instanceId: Uuid }>(sql`
    with failing as (
      select d.instance_id, d.created_at
      from ${deliveries} d
      where d.instance_id is not null and (d.state = 'failed' or (d.state = 'pending' and d.attempts > 0))
    ), last_ok as materialized (
      select f.instance_id,
        (select max(ok.settled_at) from ${deliveries} ok where ok.instance_id = f.instance_id and ok.state = 'delivered') as at
      from (select distinct instance_id from failing) f
    )
    select f.instance_id as "instanceId"
    from failing f join last_ok l on l.instance_id = f.instance_id
    where f.created_at > coalesce(l.at, '-infinity')
    group by f.instance_id
    having max(f.created_at) >= ${recent}::timestamptz
      and count(*) >= ${dormancy.minFailures}`);
  return rows.map((row) => ({ instanceId: row.instanceId }));
}

/** Whether any actor of the instance sent an inbox POST we stored after `since`. */
async function heardFrom(instanceId: Uuid, since: Date): Promise<boolean> {
  const rows = await db()
    .select({ one: sql<number>`1` })
    .from(inboxRaw)
    .innerJoin(actors, eq(actors.apId, inboxRaw.actorApId))
    .where(and(eq(actors.instanceId, instanceId), sql`${inboxRaw.receivedAt} > ${since.toISOString()}::timestamptz`))
    .limit(1);
  return rows.length > 0;
}

/** Whether a delivery to the instance succeeded after `since`. */
async function deliveredSince(instanceId: Uuid, since: Date): Promise<boolean> {
  const rows = await db()
    .select({ one: sql<number>`1` })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.instanceId, instanceId),
        eq(deliveries.state, 'delivered'),
        sql`${deliveries.settledAt} > ${since.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type HealthChange =
  | { state: 'dormant'; failingSince: Date; now: Date }
  | { state: 'active'; by: 'probe' | 'inbound'; now: Date }
  /** Its deliveries are failing and this is the first time the job saw it: the clock of the week starts. */
  | { state: 'failing'; now: Date }
  /** Its deliveries are no longer failing (a success, or nothing new fails): the clock is dropped. */
  | { state: 'recovered'; now: Date }
  /** The probe claimed at `claimedAt` never made a request: the next question may probe again. */
  | { state: 'probe_unused'; claimedAt: Date; now: Date };

/**
 * Marks the grant's instance dormant, or active again, or keeps the job's record of since when
 * its deliveries fail. Idempotent: two workers marking the same instance end with one change
 * and one event. Going dormant counts as the latest probe, so the first one is a day away.
 */
export const setInstanceHealth = defineMutation({
  action: 'remote.instance_health',
  emits: ['instance.dormant', 'instance.revived'],
  async run(t, grant, input: HealthChange) {
    const { instanceId } = grant.subject;
    const [instance] = await t.db
      .select({ domain: instances.domain, local: instances.local })
      .from(instances)
      .where(eq(instances.id, instanceId));
    if (!instance || instance.local) return { changed: false };
    if (input.state === 'dormant') {
      const changed = await t.db
        .insert(instanceHealth)
        .values({
          instanceId,
          state: 'dormant',
          failingSince: input.failingSince,
          dormantSince: input.now,
          lastProbeAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: instanceHealth.instanceId,
          set: {
            state: 'dormant',
            failingSince: input.failingSince,
            dormantSince: input.now,
            lastProbeAt: input.now,
            updatedAt: input.now,
          },
          setWhere: ne(instanceHealth.state, 'dormant'),
        })
        .returning({ instanceId: instanceHealth.instanceId });
      if (changed.length === 0) return { changed: false };
      await t.emit({ type: 'instance.dormant', v: 1, instanceId, domain: instance.domain });
      return { changed: true };
    }
    if (input.state === 'failing') {
      // Never touches a dormant row; keeps the first sighting of an ongoing run.
      const started = await t.db
        .insert(instanceHealth)
        .values({ instanceId, state: 'active', failingSince: input.now, updatedAt: input.now })
        .onConflictDoUpdate({
          target: instanceHealth.instanceId,
          set: {
            failingSince: sql`coalesce(${instanceHealth.failingSince}, ${input.now.toISOString()}::timestamptz)`,
            updatedAt: input.now,
          },
          setWhere: eq(instanceHealth.state, 'active'),
        })
        .returning({ failingSince: instanceHealth.failingSince });
      return { changed: started.length > 0 };
    }
    if (input.state === 'recovered') {
      const cleared = await t.db
        .update(instanceHealth)
        .set({ failingSince: null, updatedAt: input.now })
        .where(
          and(
            eq(instanceHealth.instanceId, instanceId),
            eq(instanceHealth.state, 'active'),
            sql`${instanceHealth.failingSince} is not null`,
          ),
        )
        .returning({ instanceId: instanceHealth.instanceId });
      return { changed: cleared.length > 0 };
    }
    if (input.state === 'probe_unused') {
      // Only the claim that is named: a newer probe, claimed since, stands.
      const released = await t.db
        .update(instanceHealth)
        .set({ lastProbeAt: new Date(input.now.getTime() - dormancy.probeEveryMs), updatedAt: input.now })
        .where(
          and(
            eq(instanceHealth.instanceId, instanceId),
            eq(instanceHealth.state, 'dormant'),
            eq(instanceHealth.lastProbeAt, input.claimedAt),
          ),
        )
        .returning({ instanceId: instanceHealth.instanceId });
      return { changed: released.length > 0 };
    }
    const changed = await t.db
      .update(instanceHealth)
      .set({ state: 'active', revivedAt: input.now, updatedAt: input.now, failingSince: null })
      .where(and(eq(instanceHealth.instanceId, instanceId), eq(instanceHealth.state, 'dormant')))
      .returning({ instanceId: instanceHealth.instanceId });
    if (changed.length === 0) return { changed: false };
    await t.emit({ type: 'instance.revived', v: 1, instanceId, domain: instance.domain, by: input.by });
    return { changed: true };
  },
});

/** Lets one delivery through to a dormant instance when its last probe is a day old. */
export const claimProbe = defineMutation({
  action: 'remote.instance_probe',
  emits: ['instance.probed'],
  async run(t, grant, input: { now: Date }) {
    const { instanceId } = grant.subject;
    const dueBefore = new Date(input.now.getTime() - dormancy.probeEveryMs);
    const claimed = await t.db
      .update(instanceHealth)
      .set({ lastProbeAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(instanceHealth.instanceId, instanceId),
          eq(instanceHealth.state, 'dormant'),
          or(isNull(instanceHealth.lastProbeAt), lte(instanceHealth.lastProbeAt, dueBefore)),
        ),
      )
      .returning({ instanceId: instanceHealth.instanceId });
    if (claimed.length === 0) return { probe: false };
    const [instance] = await t.db.select({ domain: instances.domain }).from(instances).where(eq(instances.id, instanceId));
    await t.emit({ type: 'instance.probed', v: 1, instanceId, domain: instance?.domain ?? '' });
    return { probe: true };
  },
});

/**
 * Whether deliveries to the instance are skipped. An instance with no health row, or an active
 * one, is not dormant. A dormant one is, except that the first question a day after its last
 * probe is answered "no" (that delivery is the probe) and every other is "yes".
 */
export async function isDormant(instanceId: Uuid, now = new Date()): Promise<boolean> {
  const [row] = await db().select({ state: instanceHealth.state }).from(instanceHealth).where(eq(instanceHealth.instanceId, instanceId));
  if (row?.state !== 'dormant') return false;
  const decision = await authorize('remote.instance_probe', await systemPrincipal(db(), 'scheduled'), { instanceId });
  if (!decision.ok) return true;
  return !(await claimProbe(decision.grant, { now })).probe;
}

async function setHealth(instanceId: Uuid, change: HealthChange): Promise<boolean> {
  const decision = await authorize('remote.instance_health', await systemPrincipal(db(), 'scheduled'), { instanceId });
  if (!decision.ok) throw new Error(`remote.instance_health refused: ${decision.reason}`);
  return (await setInstanceHealth(decision.grant, change)).changed;
}

/**
 * Whether a delivery to the instance shows that a probe claimed at `claimedAt` was really tried:
 * a delivery that ended after it (delivered, failed, or skipped on its retry after a first
 * attempt), or one waiting to retry that has an answer or an error of the peer's recorded. A
 * delivery skipped at once because the instance is dormant is no evidence.
 */
async function probeWasTried(instanceId: Uuid, claimedAt: Date): Promise<boolean> {
  const since = claimedAt.toISOString();
  const rows = await db()
    .select({ one: sql<number>`1` })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.instanceId, instanceId),
        or(
          and(sql`${deliveries.settledAt} >= ${since}::timestamptz`, inArray(deliveries.state, ['delivered', 'failed'])),
          and(sql`${deliveries.settledAt} >= ${since}::timestamptz`, eq(deliveries.state, 'skipped'), sql`${deliveries.attempts} >= 2`),
          and(
            eq(deliveries.state, 'pending'),
            sql`${deliveries.attempts} >= 1`,
            or(
              sql`${deliveries.lastStatus} is not null`,
              sql`${deliveries.lastError} is not null and ${deliveries.lastError} <> 'the instance is dormant'`,
            ),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * One pass of the health job. First the dormant instances that gave a sign of life since they
 * went dormant (a delivery that succeeded, an activity they sent) are revived, and a probe that
 * never reached the network is given back; then the instances whose deliveries are failing are
 * noted (the first sighting starts their week), and those that have failed for a week and sent
 * nothing in it become dormant. An instance that stopped failing is forgotten. Returns what changed.
 */
export async function evaluateInstanceHealth(now = new Date()): Promise<{ dormant: number; revived: number }> {
  let revived = 0;
  let dormant = 0;
  const held = await db().select().from(instanceHealth).where(eq(instanceHealth.state, 'dormant'));
  for (const row of held) {
    const since = row.dormantSince ?? new Date(0);
    const by = (await deliveredSince(row.instanceId, since)) ? 'probe' : (await heardFrom(row.instanceId, since)) ? 'inbound' : null;
    if (by) {
      if (await setHealth(row.instanceId, { state: 'active', by, now })) revived += 1;
      continue;
    }
    // A real claim (the stamp differs from the one going dormant sets), old enough that its
    // delivery would have been tried, and nothing shows it was: the worker died first.
    const claimedAt = row.lastProbeAt;
    const claimed =
      claimedAt &&
      claimedAt.getTime() !== row.dormantSince?.getTime() &&
      claimedAt.getTime() > now.getTime() - dormancy.probeEveryMs &&
      claimedAt.getTime() + dormancy.probeSettleMs <= now.getTime();
    if (claimed && !(await probeWasTried(row.instanceId, claimedAt))) {
      await setHealth(row.instanceId, { state: 'probe_unused', claimedAt, now });
    }
  }

  const rows = new Map((await db().select().from(instanceHealth)).map((row) => [row.instanceId, row]));
  const failing = await failingRuns(now);
  const failingIds = new Set(failing.map((run) => run.instanceId));
  const silentSince = new Date(now.getTime() - dormancy.silentForMs);
  for (const { instanceId } of failing) {
    const row = rows.get(instanceId);
    if (row?.state === 'dormant') continue;
    let failingSince = row?.failingSince ?? null;
    if (!failingSince) {
      await setHealth(instanceId, { state: 'failing', now });
      failingSince = now;
    }
    if (failingSince.getTime() > now.getTime() - dormancy.failingForMs || (await heardFrom(instanceId, silentSince))) continue;
    if (await setHealth(instanceId, { state: 'dormant', failingSince, now })) dormant += 1;
  }
  for (const row of rows.values()) {
    if (row.state === 'active' && row.failingSince && !failingIds.has(row.instanceId))
      await setHealth(row.instanceId, { state: 'recovered', now });
  }
  return { dormant, revived };
}
