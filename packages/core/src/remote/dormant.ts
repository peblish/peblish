import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
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

/** The policy's figures, as data. */
export const dormancy = {
  /** An unbroken run of failed deliveries at least this old makes an instance a candidate... */
  failingForMs: 7 * 24 * 60 * 60 * 1000,
  /** ...if it also sent us nothing for this long. */
  silentForMs: 7 * 24 * 60 * 60 * 1000,
  /** A dormant instance gets one delivery through this often. */
  probeEveryMs: 24 * 60 * 60 * 1000,
  /** A failed delivery in this window keeps the run "ongoing": a peer we stopped sending to is not failing. */
  ongoingWithinMs: 2 * 24 * 60 * 60 * 1000,
  /** One old failure is not a dead server. */
  minFailures: 3,
} as const;

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

export type FailingRun = { instanceId: Uuid; failingSince: Date };

/**
 * Instances whose deliveries fail and have not succeeded since: the failed (or retrying)
 * rows newer than the instance's last delivered row, grouped. A run counts when its earliest
 * failure is at least `failingForMs` old, its latest is within `ongoingWithinMs`, and there are
 * `minFailures` of them.
 */
export async function failingRuns(now: Date): Promise<FailingRun[]> {
  const oldest = new Date(now.getTime() - dormancy.failingForMs).toISOString();
  const recent = new Date(now.getTime() - dormancy.ongoingWithinMs).toISOString();
  // The last success is looked up once for each instance with a failure, not once for each failure.
  const rows = await db().execute<{ instanceId: Uuid; failingSince: string | Date }>(sql`
    with failing as (
      select d.instance_id, d.created_at
      from ${deliveries} d
      where d.instance_id is not null and (d.state = 'failed' or (d.state = 'pending' and d.attempts > 0))
    ), last_ok as materialized (
      select f.instance_id,
        (select max(ok.settled_at) from ${deliveries} ok where ok.instance_id = f.instance_id and ok.state = 'delivered') as at
      from (select distinct instance_id from failing) f
    )
    select f.instance_id as "instanceId", min(f.created_at) as "failingSince"
    from failing f join last_ok l on l.instance_id = f.instance_id
    where f.created_at > coalesce(l.at, '-infinity')
    group by f.instance_id
    having min(f.created_at) <= ${oldest}::timestamptz
      and max(f.created_at) >= ${recent}::timestamptz
      and count(*) >= ${dormancy.minFailures}`);
  return rows.map((row) => ({ instanceId: row.instanceId, failingSince: asDate(row.failingSince) }));
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

export type HealthChange = { state: 'dormant'; failingSince: Date; now: Date } | { state: 'active'; by: 'probe' | 'inbound'; now: Date };

/**
 * Marks the grant's instance dormant, or active again. Idempotent: two workers marking the
 * same instance end with one change and one event. Going dormant counts as the latest probe,
 * so the first one is a day away.
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
    const changed = await t.db
      .update(instanceHealth)
      .set({ state: 'active', revivedAt: input.now, updatedAt: input.now })
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
 * One pass of the health job. First the dormant instances that gave a sign of life since they
 * went dormant (a delivery that succeeded, an activity they sent) are revived; then the
 * failing runs that are old enough and silent become dormant. Returns what changed.
 */
export async function evaluateInstanceHealth(now = new Date()): Promise<{ dormant: number; revived: number }> {
  let revived = 0;
  let dormant = 0;
  const held = await db().select().from(instanceHealth).where(eq(instanceHealth.state, 'dormant'));
  for (const row of held) {
    const since = row.dormantSince ?? new Date(0);
    const by = (await deliveredSince(row.instanceId, since)) ? 'probe' : (await heardFrom(row.instanceId, since)) ? 'inbound' : null;
    if (by && (await setHealth(row.instanceId, { state: 'active', by, now }))) revived += 1;
  }
  const stillDormant = new Set(
    (await db().select({ id: instanceHealth.instanceId }).from(instanceHealth).where(eq(instanceHealth.state, 'dormant'))).map(
      (row) => row.id,
    ),
  );
  const silentSince = new Date(now.getTime() - dormancy.silentForMs);
  for (const run of await failingRuns(now)) {
    if (stillDormant.has(run.instanceId) || (await heardFrom(run.instanceId, silentSince))) continue;
    if (await setHealth(run.instanceId, { state: 'dormant', failingSince: run.failingSince, now })) dormant += 1;
  }
  return { dormant, revived };
}
