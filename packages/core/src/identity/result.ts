import type { RefusalReason } from '@peblish/schema/refusal';
import { Refused } from '../tx/refused.ts';

export type Result<T> = ({ ok: true } & T) | { ok: false; reason: RefusalReason };

/** Runs a mutation call, turning a Refused (its recheck denied) into a result web can show. */
export async function refusedAsResult<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
