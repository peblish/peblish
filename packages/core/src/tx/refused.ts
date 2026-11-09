import type { RefusalReason } from '@peblish/schema/refusal';

/** Thrown when a mutation's in-transaction recheck denies its action; nothing was written. */
export class Refused extends Error {
  override readonly name = 'Refused';
  readonly action: string;
  readonly reason: RefusalReason;

  constructor(action: string, reason: RefusalReason) {
    super(`${action} refused: ${reason}`);
    this.action = action;
    this.reason = reason;
  }
}
