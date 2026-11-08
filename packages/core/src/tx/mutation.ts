import type { EventType, OutboxEvent } from '@peblish/schema/events';
import { Authorized } from '../authz/brand.ts';
import type { ActionName } from '../authz/policy.ts';
import type { WriteTx } from '../db/write.ts';
import { tx, type Tx } from './tx.ts';

/** Mutations defined so far, for mutationInfo() and the registry test. */
const defined = new WeakMap<object, MutationInfo>();

export type MutationInfo = { action: ActionName; emits: readonly EventType[] };

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
 * a transaction with the outbox (registry test: mutations.test.ts).
 */
export function defineMutation<A extends ActionName, E extends EventType, I, O>(spec: {
  action: A;
  emits: readonly [E, ...E[]];
  run: (t: MutationTx<E>, grant: Authorized<A>, input: I) => Promise<O>;
}): Mutation<A, I, O> {
  const within = async (t: Tx, grant: Authorized<A>, input: I): Promise<O> => {
    if (!Authorized.verify(grant, spec.action)) throw new TypeError(`${spec.action} needs a grant from authorize()`);
    const emit = async (event: Extract<OutboxEvent, { type: E }>) => {
      if (!spec.emits.includes(event.type)) throw new TypeError(`${spec.action} may not emit ${event.type}`);
      await t.emit(event);
    };
    return spec.run({ db: t.db, emit }, grant, input);
  };
  const mutation = Object.assign((grant: Authorized<A>, input: I) => tx((t) => within(t, grant, input)), { within });
  defined.set(mutation, { action: spec.action, emits: spec.emits });
  return mutation;
}

/** The action and events of a mutation, or undefined for anything else. */
export function mutationInfo(value: unknown): MutationInfo | undefined {
  return typeof value === 'function' ? defined.get(value) : undefined;
}
