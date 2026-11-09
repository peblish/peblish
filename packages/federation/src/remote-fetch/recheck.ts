import { authorize } from '@peblish/core/authz/authorize';
import { systemPrincipal } from '@peblish/core/authz/system';
import { db } from '@peblish/core/db/read';
import { claimRechecks, rechecks } from '@peblish/core/remote/rechecks';
import type { Fetcher } from '../actors/document.ts';
import { safeFetch } from '../actors/safe-fetch.ts';
import { polite } from './polite.ts';
import { readObject } from './object.ts';
import { remoteTtls } from './ttl.ts';

// A held remote post or comment is asked after at its own server about once a day (core/remote/
// rechecks.ts picks which). A 410 or a Tombstone for it is a deletion, the same one the
// missing-object job and the backfill make when they meet one (readObject soft-deletes our copy
// and writes the ledger row); a document that is still served changes nothing here, and a server
// that is down is asked again tomorrow.

export type RecheckRun = { checked: number; gone: number; unreachable: number };

export async function recheckObjects(
  options: { fetch?: Fetcher; gapMs?: number; now?: Date; limit?: number; signal?: AbortSignal } = {},
): Promise<RecheckRun> {
  const run: RecheckRun = { checked: 0, gone: 0, unreachable: 0 };
  const decision = await authorize('remote.object_recheck', await systemPrincipal(db(), 'scheduled'), {});
  if (!decision.ok) throw new Error(`remote.object_recheck refused: ${decision.reason}`);
  const due = await claimRechecks(decision.grant, { now: options.now ?? new Date(), limit: options.limit ?? rechecks.perRun });
  const fetch = polite(options.fetch ?? safeFetch, options.gapMs ?? remoteTtls.politeGapMs);
  for (const object of due) {
    if (options.signal?.aborted) break;
    const read = await readObject(object.apId, fetch);
    run.checked += 1;
    if (!('json' in read)) {
      if (read.status === 'gone' && read.deleted) run.gone += 1;
      if (read.status === 'unreachable') run.unreachable += 1;
    }
  }
  return run;
}
