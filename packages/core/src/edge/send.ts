import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import type { WriteTx } from '../db/write.ts';
import { logLine } from '../log-line.ts';
import { defineMutation } from '../tx/mutation.ts';
import { MAX_TAGS_PER_PURGE, purgeTags, type HttpFetch, type PurgeResult } from './cloudflare.ts';
import type { EdgeConfig } from './config.ts';
import { collapseEchoes } from './debt.ts';
import { STATUS_ROW } from './ready.ts';
import { edgePurges, edgeStatus } from './tables.ts';
import { ALL_TAG, CHECK_TAG, type Purge } from './tags.ts';
import { CHECK_AFTER_MS, ECHO_MS, FIRST_BACKOFF_MS, interval, LEASE_MS, MAX_BACKOFF_MS, SEND_GAP_MS } from './timing.ts';

// Paying the purge debt (debt.ts). Any worker may; every time is the database's.
//
// 1. Claim: in a transaction holding the readiness row FOR UPDATE, when no batch is in flight
//    (the row's own claim is empty or its lease ran out), no failure is being waited out and the
//    last request was let out SEND_GAP_MS ago or more, take the due rows (or, with none due and no
//    recent proof, the idle check) under a token and a LEASE_MS lease. Rows of a sender whose
//    lease ran out are owed again first, coalesced with each other and with what is owed so the
//    unique index can never be broken.
// 2. Start: just before the request, let it out only if this batch still holds the row and the
//    gap since the last request let out has passed, and record the time. A sender that paused
//    after its claim and lost its lease does not send.
// 3. Settle: only the rows carrying the token. Success owes each first send's second send
//    ECHO_MS later and records the proof; failure gives the rows back and backs off.

export type Claim = { token: string; kind: 'check' | 'purge'; purge: Purge };

const now = sql`now()`;
const ago = (ms: number) => sql`now() - ${interval(ms)}::interval`;
const later = (ms: number) => sql`now() + ${interval(ms)}::interval`;

/**
 * Gives rows back to the queue: the rows `which` selects, coalesced with every unclaimed row of
 * the same tag and send (one survivor each, unclaimed first, keeping the earliest due time of a
 * first send and the latest of a second send), so returning any set of claims, from any number of
 * senders, can never collide on the unique index of unclaimed rows.
 */
async function giveBack(db: WriteTx, which: SQL): Promise<void> {
  await db.execute(sql`
    with pool as (
      select id,
        row_number() over (partition by tag, send order by (claim_token is null) desc, id) as rank,
        case when send = 2 then max(due_at) over w else min(due_at) over w end as due
      from ${edgePurges}
      where claim_token is null or (${which})
      window w as (partition by tag, send)
    ), dropped as (
      delete from ${edgePurges} p using pool where p.id = pool.id and pool.rank > 1
    )
    update ${edgePurges} p set claim_token = null, lease_until = null, due_at = pool.due
    from pool where p.id = pool.id and pool.rank = 1`);
}

async function lockStatus(db: WriteTx) {
  await db.insert(edgeStatus).values({ name: STATUS_ROW }).onConflictDoNothing();
  const [status] = await db
    .select({
      zoneId: edgeStatus.zoneId,
      busy: sql<boolean>`${edgeStatus.claimToken} is not null and ${edgeStatus.leaseUntil} > now()`,
      waiting: sql<boolean>`coalesce(${edgeStatus.retryAt} > now(), false)`,
      spaced: sql<boolean>`${edgeStatus.sentAt} is null or ${edgeStatus.sentAt} <= ${ago(SEND_GAP_MS)}`,
      proven: sql<boolean>`coalesce(${edgeStatus.verifiedAt} > ${ago(CHECK_AFTER_MS)}, false)`,
      claimToken: edgeStatus.claimToken,
      failures: edgeStatus.failures,
    })
    .from(edgeStatus)
    .where(eq(edgeStatus.name, STATUS_ROW))
    .for('update');
  if (!status) throw new Error('the edge status row is missing');
  return status;
}

const status = eq(edgeStatus.name, STATUS_ROW);

export const claimPurges = defineMutation({
  action: 'edge.purge_claim',
  emits: ['edge.purge_failed'],
  async run(t, _grant, input: { zoneId: string }): Promise<Claim | null> {
    const row = await lockStatus(t.db);
    if (row.busy || row.waiting || !row.spaced) return null;
    await giveBack(t.db, sql`claim_token is not null and lease_until <= now()`);
    const dueNow = and(isNull(edgePurges.claimToken), sql`${edgePurges.dueAt} <= now()`);
    const due = await t.db
      .select({ id: edgePurges.id, tag: edgePurges.tag })
      .from(edgePurges)
      .where(dueNow)
      .orderBy(edgePurges.dueAt)
      .limit(MAX_TAGS_PER_PURGE + 1);
    const token = randomUUID();
    let claim: Claim;
    if (due.length === 0) {
      if (row.proven && row.zoneId === input.zoneId) return null;
      claim = { token, kind: 'check', purge: [CHECK_TAG] };
    } else {
      const wide = due.length > MAX_TAGS_PER_PURGE || due.some((one) => one.tag === ALL_TAG);
      await t.db
        .update(edgePurges)
        .set({ claimToken: token, leaseUntil: later(LEASE_MS) })
        .where(
          wide
            ? dueNow
            : inArray(
                edgePurges.id,
                due.map((one) => one.id),
              ),
        );
      claim = { token, kind: 'purge', purge: wide ? 'all' : [...new Set(due.map((one) => one.tag))] };
    }
    await t.db
      .update(edgeStatus)
      .set({ claimToken: token, leaseUntil: later(LEASE_MS), updatedAt: now })
      .where(status);
    return claim;
  },
});

/** Lets the claimed batch's request out, if the batch still holds the row and the gap has passed since the last one. */
export const startPurge = defineMutation({
  action: 'edge.purge_settle',
  emits: ['edge.purge_failed'],
  async run(t, grant, _input: void): Promise<boolean> {
    const started = await t.db
      .update(edgeStatus)
      .set({ sentAt: now, updatedAt: now })
      .where(
        and(
          status,
          eq(edgeStatus.claimToken, grant.subject.token),
          sql`${edgeStatus.leaseUntil} > now()`,
          sql`(${edgeStatus.sentAt} is null or ${edgeStatus.sentAt} <= ${ago(SEND_GAP_MS)})`,
        ),
      )
      .returning({ name: edgeStatus.name });
    return started.length > 0;
  },
});

export type Settled = { failuresBefore: number; failures: number };

export const settlePurges = defineMutation({
  action: 'edge.purge_settle',
  emits: ['edge.purge_failed'],
  async run(t, grant, input: { wide: boolean; result: PurgeResult | null; zoneId: string }): Promise<Settled> {
    const { token } = grant.subject;
    const { result } = input;
    const row = await lockStatus(t.db);
    const failuresBefore = row.failures;
    if (row.claimToken === token) await t.db.update(edgeStatus).set({ claimToken: null, leaseUntil: null }).where(status);
    const held = eq(edgePurges.claimToken, token);
    if (result === null) {
      // Not let out: owed as before, nothing learned about the token.
      await giveBack(t.db, sql`claim_token = ${token}::uuid`);
      return { failuresBefore, failures: failuresBefore };
    }
    if (result.ok) {
      const firsts = await t.db
        .selectDistinct({ tag: edgePurges.tag })
        .from(edgePurges)
        .where(and(held, eq(edgePurges.send, 1)));
      // A wide purge covers every tag it took, so one wide echo covers their echoes.
      const echoes = input.wide ? (firsts.length > 0 ? [ALL_TAG] : []) : firsts.map((one) => one.tag);
      await t.db.delete(edgePurges).where(held);
      if (echoes.length > 0) {
        await t.db
          .insert(edgePurges)
          .values(echoes.map((tag) => ({ tag, send: 2, dueAt: later(ECHO_MS) })))
          .onConflictDoUpdate({
            target: [edgePurges.tag, edgePurges.send],
            targetWhere: sql`${edgePurges.claimToken} is null`,
            set: { dueAt: sql`greatest(${edgePurges.dueAt}, excluded.due_at)` },
          });
        await collapseEchoes(t.db);
      }
      await t.db
        .update(edgeStatus)
        .set({ zoneId: input.zoneId, verifiedAt: now, failures: 0, lastError: null, retryAt: null, updatedAt: now })
        .where(status);
      return { failuresBefore, failures: 0 };
    }
    await giveBack(t.db, sql`claim_token = ${token}::uuid`);
    const failures = failuresBefore + 1;
    const backoff = Math.min(FIRST_BACKOFF_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
    const wait = Math.max(backoff, result.retryAfterMs ?? 0);
    await t.db
      .update(edgeStatus)
      .set({
        failures,
        lastError: result.why.slice(0, 200),
        retryAt: later(wait),
        updatedAt: now,
        // A refused token is not a working purge path from this moment.
        ...(result.refused && { verifiedAt: null }),
      })
      .where(status);
    // One record per run of failures (the outbox is not pruned); edge_status keeps the count and the last error.
    if (failures === 1) {
      await t.emit({
        type: 'edge.purge_failed',
        v: 1,
        actorId: grant.actorId,
        failures,
        refused: result.refused,
        why: result.why.slice(0, 200),
      });
    }
    return { failuresBefore, failures };
  },
});

export type FlushDeps = { fetch?: HttpFetch };

/** A line through the log boundary's rules (one line, no control characters, bounded). */
const log = (method: 'log' | 'error', text: string) => console[method](logLine([text]));

/**
 * One payment: claims what is due (or the idle check), lets the request out, sends it, settles
 * it. A refused token is logged every time; any other failure the first time and at each
 * doubling of the run of failures; the first success after failures says so.
 */
export async function flushPurges(config: EdgeConfig, { fetch }: FlushDeps = {}): Promise<'idle' | 'sent' | 'failed'> {
  const principal = await systemPrincipal(db(), 'scheduled');
  const claimed = await authorize('edge.purge_claim', principal, {});
  if (!claimed.ok) throw new Error(`edge.purge_claim refused: ${claimed.reason}`);
  const claim = await claimPurges(claimed.grant, { zoneId: config.zoneId });
  if (!claim) return 'idle';
  const settling = await authorize('edge.purge_settle', principal, { token: claim.token });
  if (!settling.ok) throw new Error(`edge.purge_settle refused: ${settling.reason}`);
  const wide = claim.purge === 'all';
  if (!(await startPurge(settling.grant))) {
    await settlePurges(settling.grant, { wide, result: null, zoneId: config.zoneId });
    return 'idle';
  }
  const result = await purgeTags(config, claim.purge, { fetch });
  const { failuresBefore, failures } = await settlePurges(settling.grant, { wide, result, zoneId: config.zoneId });
  if (result.ok) {
    if (failuresBefore > 0) log('log', `edge cache: purge path works again after ${failuresBefore} failed requests`);
    return 'sent';
  }
  if (result.refused) {
    log('error', `edge cache: Cloudflare refused the purge request (${result.why}); proxy images are answered private until it works`);
  } else if ((failures & (failures - 1)) === 0) {
    log(
      'error',
      `edge cache: purge request failed ${failures} time${failures === 1 ? '' : 's'} in a row (${result.why}); the debt stays owed`,
    );
  }
  return 'failed';
}
