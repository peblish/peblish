import type { RefusalReason } from './refusal.ts';
import type { Uuid } from './ids.ts';

// Lane A implements this for invite-only registration (M20).
export type InviteCheck = { ok: true; inviteId: Uuid; inviterActorId: Uuid | null } | { ok: false; reason: RefusalReason };

export interface InviteGate {
  /** Whether `code` may register now (exists, unexpired, unrevoked, uses left), without using it. */
  check(code: string): Promise<InviteCheck>;
  /**
   * Uses the invite for `actorId` atomically (one statement guards the use count) and records
   * the invite chain. Fails with the same reasons as `check` when the invite is no longer usable.
   */
  redeem(code: string, actorId: Uuid): Promise<InviteCheck>;
}
