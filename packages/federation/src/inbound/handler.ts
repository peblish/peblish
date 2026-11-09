import type { Tx } from '@peblish/core/tx/tx';

// Owned by lane FED-B after G0. One handler per activity type, one file each under
// inbound/handlers/, registered by glob (each exports `handler`).

export type InboundOutcome = { applied: true } | { applied: false; reason: string };

export interface InboundHandler {
  /** The ActivityStreams type handled, such as 'Create', 'Like' or 'Flag'. */
  readonly type: string;
  /**
   * Applies one activity inside the pipeline's transaction, after its dedupe marker is
   * written and before the transaction commits (dedupe, apply, enqueue in one tx).
   */
  handle(activity: Record<string, unknown>, t: Tx): Promise<InboundOutcome>;
}
