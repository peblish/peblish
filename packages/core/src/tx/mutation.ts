import type { EventType, OutboxEvent } from '@peblish/schema/events';
import { authorize } from '../authz/authorize.ts';
import { Authorized } from '../authz/brand.ts';
import type { ActionName } from '../authz/policy.ts';
import type { WriteTx } from '../db/write.ts';
import { Refused } from './refused.ts';
import { tx, type Tx } from './tx.ts';

/** Mutations defined so far, for mutationInfo() and the registry test. */
const defined = new WeakMap<object, MutationInfo>();

export type MutationInfo = { action: ActionName; emits: readonly EventType[]; recheck: boolean };

/** Actions a moderator or a lock can revoke; their mutations must set recheck: true. */
export function requiresRecheck(action: string): boolean {
  return action === 'post.create' || action === 'comment.create' || action.startsWith('mod.');
}
type RevocableAction = 'post.create' | 'comment.create' | `mod.${string}`;
type RecheckOption<A extends string> = A extends RevocableAction ? { recheck: true } : { recheck?: boolean };

/** What a mutation's body sees: the transaction's handle and an emit limited to its declared events. */
export type MutationTx<E extends EventType> = {
  readonly db: WriteTx;
  emit(event: Extract<OutboxEvent, { type: E }>): Promise<void>;
};

export interface Mutation<A extends ActionName, I, O> {
  /** Runs in its own transaction. */
  (grant: Authorized<A>, input: I): Promise<O>;
  /** Runs inside an open transaction, such as the inbound pipeline's dedupe, apply, enqueue. */
  within(t: Tx, grant: Authorized<A>, input: I): Promise<O>;
}

/**
 * The only way core code writes state: a mutation names its authz action and the outbox
 * events it may emit, requires an Authorized grant for that action, and runs its body in
 * a transaction with the outbox (registry test: mutations.test.ts). The body takes target
 * ids from grant.subject, never from input.
 *
 * recheck re-runs the action's policy inside the transaction and hands the body the fresh
 * grant, so a ban, lock or removal that landed after authorize() is honoured; a deny throws
 * Refused and writes nothing. Required for actions a moderator or a lock can revoke (post
 * and comment create, every mod.* action): the type demands it and definition throws
 * without it, so an internal mutation behind a wrapper cannot skip it either.
 */
export function defineMutation<A extends ActionName, E extends EventType, I, O>(
  spec: {
    action: A;
    emits: readonly [E, ...E[]];
    run: (t: MutationTx<E>, grant: Authorized<A>, input: I) => Promise<O>;
  } & RecheckOption<A>,
): Mutation<A, I, O> {
  const recheck = 'recheck' in spec && spec.recheck === true;
  if (requiresRecheck(spec.action) && !recheck)
    throw new TypeError(`${spec.action} can be revoked, so its mutation must set recheck: true`);
  const within = async (t: Tx, grant: Authorized<A>, input: I): Promise<O> => {
    if (!Authorized.verify(grant, spec.action)) throw new TypeError(`${spec.action} needs a grant from authorize()`);
    let current = grant;
    if (recheck) {
      const decision = await authorize(spec.action, grant.principal, grant.subject, { db: t.db, lock: true });
      if (!decision.ok) throw new Refused(spec.action, decision.reason);
      current = decision.grant;
    }
    const emit = async (event: Extract<OutboxEvent, { type: E }>) => {
      if (!spec.emits.includes(event.type)) throw new TypeError(`${spec.action} may not emit ${event.type}`);
      await t.emit(event);
    };
    return spec.run({ db: t.db, emit }, current, input);
  };
  const mutation = Object.assign((grant: Authorized<A>, input: I) => tx((t) => within(t, grant, input)), { within });
  defined.set(mutation, { action: spec.action, emits: spec.emits, recheck });
  return mutation;
}

/** The action and events of a mutation, or undefined for anything else. */
export function mutationInfo(value: unknown): MutationInfo | undefined {
  return typeof value === 'function' ? defined.get(value) : undefined;
}
