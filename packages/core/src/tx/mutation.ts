import type { EventType, OutboxEvent } from '@peblish/schema/events';
import { authorize } from '../authz/authorize.ts';
import { Authorized } from '../authz/brand.ts';
import type { ActionName } from '../authz/policy.ts';
import type { WriteTx } from '../db/write.ts';
import { Refused } from './refused.ts';
import { tx, type OpenTx } from './tx.ts';

/** Mutations defined so far, for mutationInfo() and the registry test. */
const defined = new WeakMap<object, MutationInfo>();

/** Which mutations' bodies ran a rechecked mutation through within(), by the handle they were given. */
const recheckedOn = new WeakMap<object, Set<ActionName>>();

export type MutationInfo = { action: ActionName; emits: readonly EventType[]; recheck: boolean | 'inner' };

/** A person's own writes and report handling: a site ban or a lost moderator role that lands after authorize() must refuse them. */
const personWrites = [
  'profile.update',
  'block.add',
  'block.remove',
  'age.declare',
  'notification.read',
  'notification.read_all',
  'report.create',
  'report.resolve',
  'report.route',
] as const;

/**
 * The actions whose mutations must set recheck: true (or 'inner'), exactly: post.create,
 * comment.create, every action named mod.* and the person writes above. Other actions a ban or
 * a lock revokes (vote.cast, say) may and should set it too; only these are enforced.
 */
export function requiresRecheck(action: string): boolean {
  return action === 'post.create' || action === 'comment.create' || action.startsWith('mod.') || personWrites.some((a) => a === action);
}
type RevocableAction = 'post.create' | 'comment.create' | `mod.${string}` | (typeof personWrites)[number];
type RecheckOption<A extends string> = A extends RevocableAction ? { recheck: true | 'inner' } : { recheck?: boolean | 'inner' };

/** What a mutation's body sees: the transaction's handle and an emit limited to its declared events. */
export type MutationTx<E extends EventType> = {
  readonly db: WriteTx;
  emit(event: Extract<OutboxEvent, { type: E }>): Promise<void>;
};

export interface Mutation<A extends ActionName, I, O> {
  /** Runs in its own transaction. */
  (grant: Authorized<A>, input: I): Promise<O>;
  /**
   * Runs inside an open transaction: the inbound pipeline's dedupe, apply, enqueue, another
   * mutation's body, or an outbox consumer's batch.
   */
  within(t: OpenTx, grant: Authorized<A>, input: I): Promise<O>;
}

/**
 * The only way core code writes state: a mutation names its authz action and the outbox
 * events it may emit, requires an Authorized grant for that action, and runs its body in
 * a transaction with the outbox (registry test: mutations.test.ts). The body takes target
 * ids from grant.subject, never from input.
 *
 * recheck re-runs the action's policy inside the transaction and hands the body the fresh
 * grant, so a ban, lock or removal that landed after authorize() is honoured; a deny throws
 * Refused and writes nothing. Required for actions a moderator, a ban or a lock can revoke
 * (requiresRecheck): the type demands it and definition throws without it, so an internal
 * mutation behind a wrapper cannot skip it either.
 *
 * recheck: 'inner' is for an outer mutation that must lock a row before the recheck reads it
 * (the acting actor's row, which the principal refresh reads FOR SHARE): its body locks, then
 * runs a rechecked mutation of the same action with .within on the handle it was given. The
 * outer throws if its body returns without having done so.
 */
export function defineMutation<A extends ActionName, E extends EventType, I, O>(
  spec: {
    action: A;
    emits: readonly [E, ...E[]];
    run: (t: MutationTx<E>, grant: Authorized<A>, input: I) => Promise<O>;
  } & RecheckOption<A>,
): Mutation<A, I, O> {
  const recheck = !('recheck' in spec) || spec.recheck === undefined ? false : spec.recheck;
  if (requiresRecheck(spec.action) && !recheck)
    throw new TypeError(`${spec.action} can be revoked, so its mutation must set recheck: true`);
  const within = async (t: OpenTx, grant: Authorized<A>, input: I): Promise<O> => {
    if (!Authorized.verify(grant, spec.action)) throw new TypeError(`${spec.action} needs a grant from authorize()`);
    let current = grant;
    if (recheck === true) {
      const decision = await authorize(spec.action, grant.principal, grant.subject, { db: t.db, lock: true });
      if (!decision.ok) throw new Refused(spec.action, decision.reason);
      current = decision.grant;
      let done = recheckedOn.get(t);
      if (!done) recheckedOn.set(t, (done = new Set()));
      done.add(spec.action);
    }
    const emit = async (event: Extract<OutboxEvent, { type: E }>) => {
      if (!spec.emits.includes(event.type)) throw new TypeError(`${spec.action} may not emit ${event.type}`);
      await t.emit(event);
    };
    const handle = { db: t.db, emit };
    const result = await spec.run(handle, current, input);
    if (recheck === 'inner' && !recheckedOn.get(handle)?.has(spec.action))
      throw new TypeError(`${spec.action} declares recheck: 'inner', but its body ran no rechecked ${spec.action} mutation`);
    return result;
  };
  const mutation = Object.assign((grant: Authorized<A>, input: I) => tx((t) => within(t, grant, input)), { within });
  defined.set(mutation, { action: spec.action, emits: spec.emits, recheck });
  return mutation;
}

/** The action and events of a mutation, or undefined for anything else. */
export function mutationInfo(value: unknown): MutationInfo | undefined {
  return typeof value === 'function' ? defined.get(value) : undefined;
}
