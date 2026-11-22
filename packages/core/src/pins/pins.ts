import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import type { MovePin, PinCommunity } from '@peblish/schema/inputs';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db, type Queryable } from '../db/read.ts';
import { refusedAsResult, type Result } from '../identity/result.ts';
import { addPin, movePin, removePin } from './mutations.ts';
import { shownPins } from './shown.ts';
import { communityPins } from './tables.ts';

// The sidebar pins feature (branch 5). The shell's reader (feeds/shell.ts) asks pinsAmong for
// the communities it lists, and the directory's loader for its rows; web calls the three entry
// points (routes/communities/pins.ts). Positions the entry points take and answer are shown
// places, among the pins the owner still sees (mutations.ts says how they map to stored ones).

/**
 * The viewer's pins among `communityIds` (the communities a page shows the viewer), as each
 * one's place in the viewer's order counting from 0: ShellCommunity.pinned and pinPosition. Only
 * shown pins count (shown.ts, the order the moves use too), renumbered over the ids given, so a
 * pin the page does not show leaves no gap; a page that lists every shown pin (the shell, through
 * pinnedFirst) gets the places the moves take and answer. A community missing from the map is
 * not pinned. Owner-only; none when signed out.
 */
export async function pinsAmong(
  viewerId: Uuid | null,
  communityIds: readonly Uuid[],
  q: Queryable = db(),
): Promise<ReadonlyMap<Uuid, number>> {
  if (!viewerId || communityIds.length === 0) return new Map();
  const given = new Set(communityIds);
  const shown = (await shownPins(q, viewerId)).filter((pin) => pin.shown && given.has(pin.communityId));
  return new Map(shown.map(({ communityId }, place) => [communityId, place]));
}

/** An ORDER BY term that puts the viewer's pinned communities (`communityId`, a column) first, so a bounded list keeps every pin. */
export const pinnedFirst = (viewerId: Uuid, communityId: SQLWrapper): SQL =>
  sql`exists (select 1 from ${communityPins} where ${communityPins.ownerId} = ${viewerId} and ${communityPins.communityId} = ${communityId}) desc`;

/** Pins a community at the end of the principal's order; pinning a pinned one changes nothing. */
export async function pinCommunityAs(principal: Principal, { communityId }: PinCommunity): Promise<Result<{ position: number }>> {
  const decision = await authorize('pin.add', principal, { communityId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => addPin(decision.grant));
}

/** Unpins a community; the pins after it move up one. Unpinning an unpinned one changes nothing. */
export async function unpinCommunityAs(principal: Principal, { communityId }: PinCommunity): Promise<Result<{ pinned: boolean }>> {
  const decision = await authorize('pin.remove', principal, { communityId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => removePin(decision.grant));
}

/** Moves a pinned community to `toPosition` (from 0) in one transaction, shifting the pins between by one. */
export async function movePinAs(principal: Principal, { communityId, toPosition }: MovePin): Promise<Result<{ position: number }>> {
  const decision = await authorize('pin.move', principal, { communityId });
  if (!decision.ok) return decision;
  return refusedAsResult(() => movePin(decision.grant, { toPosition }));
}
