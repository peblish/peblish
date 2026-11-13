import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { logLine } from '../log-line.ts';
import { defineMutation } from '../tx/mutation.ts';
import { MAX_TAGS_PER_PURGE, purgeTags, type HttpFetch, type PurgeResult } from './cloudflare.ts';
import type { EdgeConfig } from './config.ts';
import { STATUS_ROW } from './ready.ts';
import { edgePurges, edgeStatus } from './tables.ts';
import { ALL_TAG, CHECK_TAG, type Purge } from './tags.ts';
import { CHECK_AFTER_MS, ECHO_MS, FIRST_BACKOFF_MS, LEASE_MS, MAX_BACKOFF_MS, SEND_GAP_MS } from './timing.ts';

// Paying the purge debt (debt.ts). Any worker may: a claim takes the due rows under a lease and
// a token, inside a transaction that also holds the readiness row FOR UPDATE, so two workers
// never send at once and requests stay SEND_GAP_MS apart across all of them. The request goes
// out between the claim and the settle, in no transaction. The settle touches only the rows that
// carry its token: a tag owed again while the request was in flight is a row of its own and
// stays owed. A worker that dies after its claim leaves rows whose lease runs out; the next
// claim takes them again. With nothing due and a readiness record older than CHECK_AFTER_MS, the
// claim is the idle check instead: a purge of a tag no answer carries, which proves the token.

export type Claim = { token: string; kind: 'check' } | { token: string; kind: 'purge'; purge: Purge };

const held = (token: string) => eq(edgePurges.claimToken, token);

/** Drops claimed rows that are owed again unclaimed (the twin is enough), so giving the rest back cannot collide. */
const dropTwins = (where: ReturnType<typeof sql>) => sql`
  delete from ${edgePurges} p where ${where}
    and exists (select 1 from ${edgePurges} q where q.claim_token is null and q.tag = p.tag and q.send = p.send)`;

export const claimPurges = defineMutation({
  action: 'edge.purge_claim',
  emits: ['edge.purge_failed'],
  async run(t, _grant, input: { now: Date }): Promise<Claim | null> {
    const now = input.now;
    await t.db.insert(edgeStatus).values({ name: STATUS_ROW }).onConflictDoNothing();
    const [status] = await t.db.select().from(edgeStatus).where(eq(edgeStatus.name, STATUS_ROW)).for('update');
    if (!status) throw new Error('the edge status row is missing');
    if (status.retryAt && status.retryAt > now) return null;
    if (status.sentAt && status.sentAt.getTime() > now.getTime() - SEND_GAP_MS) return null;
    // A sender that died mid-send: its rows are owed again.
    const expired = and(isNotNull(edgePurges.claimToken), lte(edgePurges.leaseUntil, now));
    await t.db.execute(dropTwins(sql`p.claim_token is not null and p.lease_until <= ${now.toISOString()}::timestamptz`));
    await t.db.update(edgePurges).set({ claimToken: null, leaseUntil: null }).where(expired);
    const dueNow = and(isNull(edgePurges.claimToken), lte(edgePurges.dueAt, now));
    const due = await t.db
      .select({ id: edgePurges.id, tag: edgePurges.tag })
      .from(edgePurges)
      .where(dueNow)
      .orderBy(edgePurges.dueAt)
      .limit(MAX_TAGS_PER_PURGE + 1);
    const token = randomUUID();
    let claim: Claim;
    if (due.length === 0) {
      const proven = status.verifiedAt && status.verifiedAt.getTime() > now.getTime() - CHECK_AFTER_MS;
      if (proven) return null;
      claim = { token, kind: 'check' };
    } else {
      const wide = due.length > MAX_TAGS_PER_PURGE || due.some((row) => row.tag === ALL_TAG);
      await t.db
        .update(edgePurges)
        .set({ claimToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) })
        .where(
          wide
            ? dueNow
            : inArray(
                edgePurges.id,
                due.map((row) => row.id),
              ),
        );
      claim = { token, kind: 'purge', purge: wide ? 'all' : [...new Set(due.map((row) => row.tag))] };
    }
    await t.db.update(edgeStatus).set({ sentAt: now, updatedAt: now }).where(eq(edgeStatus.name, STATUS_ROW));
    return claim;
  },
});

export type Settled = { failuresBefore: number; failures: number };

export const settlePurges = defineMutation({
  action: 'edge.purge_settle',
  emits: ['edge.purge_failed'],
  async run(t, grant, input: { wide: boolean; result: PurgeResult; now: Date }): Promise<Settled> {
    const { token } = grant.subject;
    const { now, result } = input;
    await t.db.insert(edgeStatus).values({ name: STATUS_ROW }).onConflictDoNothing();
    const [status] = await t.db.select().from(edgeStatus).where(eq(edgeStatus.name, STATUS_ROW)).for('update');
    const failuresBefore = status?.failures ?? 0;
    if (result.ok) {
      const firsts = await t.db
        .selectDistinct({ tag: edgePurges.tag })
        .from(edgePurges)
        .where(and(held(token), eq(edgePurges.send, 1)));
      // A wide purge covers every tag it took, so one wide echo covers their echoes.
      const echoes = input.wide ? (firsts.length > 0 ? [ALL_TAG] : []) : firsts.map((row) => row.tag);
      if (echoes.length > 0) {
        await t.db
          .insert(edgePurges)
          .values(echoes.map((tag) => ({ tag, send: 2, dueAt: new Date(now.getTime() + ECHO_MS) })))
          .onConflictDoUpdate({
            target: [edgePurges.tag, edgePurges.send],
            targetWhere: sql`${edgePurges.claimToken} is null`,
            set: { dueAt: sql`greatest(${edgePurges.dueAt}, excluded.due_at)` },
          });
      }
      await t.db.delete(edgePurges).where(held(token));
      await t.db
        .update(edgeStatus)
        .set({ verifiedAt: now, failures: 0, lastError: null, retryAt: null, updatedAt: now })
        .where(eq(edgeStatus.name, STATUS_ROW));
      return { failuresBefore, failures: 0 };
    }
    // Given back, owed as they were.
    await t.db.execute(dropTwins(sql`p.claim_token = ${token}::uuid`));
    await t.db.update(edgePurges).set({ claimToken: null, leaseUntil: null }).where(held(token));
    const failures = failuresBefore + 1;
    const backoff = Math.min(FIRST_BACKOFF_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
    const wait = Math.max(backoff, result.retryAfterMs ?? 0);
    await t.db
      .update(edgeStatus)
      .set({
        failures,
        lastError: result.why.slice(0, 200),
        retryAt: new Date(now.getTime() + wait),
        updatedAt: now,
        // A refused token is not a working purge path from this moment.
        ...(result.refused && { verifiedAt: null }),
      })
      .where(eq(edgeStatus.name, STATUS_ROW));
    await t.emit({
      type: 'edge.purge_failed',
      v: 1,
      actorId: grant.actorId,
      failures,
      refused: result.refused,
      why: result.why.slice(0, 200),
    });
    return { failuresBefore, failures };
  },
});

export type FlushDeps = { fetch?: HttpFetch; now?: () => Date };

/** A line through the log boundary's rules (one line, no control characters, bounded). */
const log = (method: 'log' | 'error', text: string) => console[method](logLine([text]));

/**
 * One payment: claims what is due (or the idle check), sends it, settles it. Returns what
 * happened. A refused token is logged every time; any other failure the first time and at each
 * doubling of the run of failures; the first success after failures says so.
 */
export async function flushPurges(
  config: EdgeConfig,
  { fetch, now = () => new Date() }: FlushDeps = {},
): Promise<'idle' | 'sent' | 'failed'> {
  const principal = await systemPrincipal(db(), 'scheduled');
  const claimed = await authorize('edge.purge_claim', principal, {});
  if (!claimed.ok) throw new Error(`edge.purge_claim refused: ${claimed.reason}`);
  const claim = await claimPurges(claimed.grant, { now: now() });
  if (!claim) return 'idle';
  const purge = claim.kind === 'check' ? [CHECK_TAG] : claim.purge;
  const result = await purgeTags(config, purge, { fetch });
  const settling = await authorize('edge.purge_settle', principal, { token: claim.token });
  if (!settling.ok) throw new Error(`edge.purge_settle refused: ${settling.reason}`);
  const { failuresBefore, failures } = await settlePurges(settling.grant, { wide: purge === 'all', result, now: now() });
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
