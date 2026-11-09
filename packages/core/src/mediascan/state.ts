import type { RefusalReason } from '@peblish/schema/refusal';
import { Refused } from '../tx/refused.ts';

// The scan state machine of a media row (db/tables/media.ts scan_state). Anything not listed is
// refused. `blocked` and `failed` are final: the bytes go and the row stays as the record.

export type ScanState = 'pending' | 'clean' | 'quarantined' | 'blocked' | 'failed';

export const scanStates = ['pending', 'clean', 'quarantined', 'blocked', 'failed'] as const satisfies readonly ScanState[];

const moves: Record<ScanState, readonly ScanState[]> = {
  /** A scan finds nothing (clean), a match (quarantined) or no verdict (failed). */
  pending: ['clean', 'quarantined', 'failed'],
  /** An admin confirms or the undecided window ends (blocked); an admin releases a false positive (clean). */
  quarantined: ['blocked', 'clean'],
  /** A hash added to the blocked-image list catches a clean copy. */
  clean: ['quarantined'],
  blocked: [],
  failed: [],
};

export const canMove = (from: ScanState, to: ScanState): boolean => moves[from].includes(to);

/** Throws `Refused(action, reason)` unless `from` may become `to`; `reason` says which precondition failed. */
export function assertMove(action: string, from: ScanState, to: ScanState, reason: RefusalReason): void {
  if (!canMove(from, to)) throw new Refused(action, reason);
}
