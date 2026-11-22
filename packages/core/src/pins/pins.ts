import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { MovePin, PinCommunity } from '@peblish/schema/inputs';
import { db, type Queryable } from '../db/read.ts';
import type { Result } from '../identity/result.ts';

// The sidebar pins feature's seam (branch 5). The shell's reader (feeds/shell.ts) asks pinsAmong
// for the communities it lists, and a page that shows pin controls (the directory) can ask it for
// its own rows; web calls the three entry points. Until the feature lands it holds no pins:
// pinsAmong answers none without a query, and the entry points refuse as if the community were
// not there. The pins lane fills in this file and adds its mutations, policy and tests beside it.

/**
 * The viewer's pins among `communityIds` (the communities a page shows the viewer), as each
 * one's place in the viewer's order counting from 0: ShellCommunity.pinned and pinPosition. A
 * community missing from the map is not pinned. Owner-only; none when signed out.
 */
export async function pinsAmong(
  _viewerId: Uuid | null,
  _communityIds: readonly Uuid[],
  _q: Queryable = db(),
): Promise<ReadonlyMap<Uuid, number>> {
  return new Map();
}

/** Pins a community at the end of the principal's order; pinning a pinned one changes nothing. */
export async function pinCommunityAs(_principal: Principal, _input: PinCommunity): Promise<Result<{ position: number }>> {
  return { ok: false, reason: 'target.not_found' };
}

/** Unpins a community; the pins after it move up one. Unpinning an unpinned one changes nothing. */
export async function unpinCommunityAs(_principal: Principal, _input: PinCommunity): Promise<Result<{ pinned: boolean }>> {
  return { ok: false, reason: 'target.not_found' };
}

/** Moves a pinned community to `toPosition` (from 0) in one transaction, shifting the pins between by one. */
export async function movePinAs(_principal: Principal, _input: MovePin): Promise<Result<{ position: number }>> {
  return { ok: false, reason: 'target.not_found' };
}
