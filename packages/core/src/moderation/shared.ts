import { ModInput } from '@peblish/schema/modlog';
import type { ModlogDetails } from '@peblish/schema/modlog';
import type { ActingPrincipal } from '@peblish/schema/authz';
import type { Frozen } from '../authz/frozen.ts';
import type { StateRead } from '../authz/state.ts';
import type { WriteTx } from '../db/write.ts';

// Helpers of the moderation mutations (lane AZ).

/** Reads inside the mutation's transaction, locked like the recheck that just ran. */
export const locked = (db: WriteTx): StateRead => ({ db, lock: true });

/** True when the action was taken on this instance, false when it arrived from a peer. */
export const isLocal = (principal: Frozen<ActingPrincipal>) => principal.kind !== 'remote';

/** The validated input and the modlog fields it carries. */
export function moderationInput(input: ModInput) {
  const valid = ModInput.assert(input);
  const details: ModlogDetails = valid.public === false ? { public: false } : {};
  return { reason: valid.reason ?? null, activityApId: valid.activityApId ?? null, details };
}

/** Thrown when the rows the recheck just allowed are gone, which the locks rule out. */
export const vanished = (what: string) => new Error(`${what} vanished after its recheck`);
