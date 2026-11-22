import { listLocalCommunities, moderatedAmong } from '@peblish/core/communities/read';
import { followedCommunities } from '@peblish/core/follows/read';
import type { SessionView } from '@peblish/schema/session';
import type { PickerCommunity } from './-types.ts';

// The composer's community picker (server only): which communities the person may pick, at most
// pickerMax, and which of them take their post. Its own module, imported by -load.ts's server
// functions alone, so none of these reads reach the browser's copy of the loader.

/**
 * The age gate (C10, the feeds' rule): a sensitive or NSFL community is for someone who declared
 * 16+; to anyone else it does not exist, in the picker and in its panel alike.
 */
export const ageAllows = (viewer: SessionView, community: { sensitive: boolean; nsfl: boolean }) =>
  viewer.ageDeclaredAt !== null || !(community.sensitive || community.nsfl);

/** Most communities the picker lists. */
export const pickerMax = 200;

/** A community the picker may list, before whether it takes this person's post is known. */
export type Candidate = Omit<PickerCommunity, 'canPost'> & { followed: boolean };

/**
 * Every community the picker could list, in its order: local ones by name (the first
 * pickerMax + 1, so a cut shows, and any the person follows past them), then the remote ones the
 * person follows (accepted follows only). A community age-gated as sensitive or NSFL is listed
 * only for someone who declared 16+, a removed one never.
 */
async function candidates(viewer: SessionView): Promise<Candidate[]> {
  const includeSensitive = viewer.ageDeclaredAt !== null;
  const [first, followed] = await Promise.all([
    listLocalCommunities({ includeSensitive, limit: pickerMax + 1 }),
    followedCommunities(viewer.actorId),
  ]);
  const follows = followed.filter((community) => community.state === 'accepted' && ageAllows(viewer, community));
  const followedIds = new Set(follows.map(({ id }) => id));
  const listed = new Set(first.map(({ actor }) => actor.id));
  // Only on a server with more local communities than the picker lists: names past the first page, so they sort after it.
  const missing = follows.filter((community) => community.local && !listed.has(community.id)).map(({ id }) => id);
  const more = missing.length > 0 ? await listLocalCommunities({ includeSensitive, ids: missing, limit: 500 }) : [];
  const local = [...first, ...more].map(({ actor, postingRestrictedToMods, subscribers }): Candidate => ({
    id: actor.id,
    handle: actor.handle,
    local: true,
    subscribers,
    restricted: postingRestrictedToMods,
    followed: followedIds.has(actor.id),
  }));
  const remote = follows
    .filter((community) => !community.local)
    .map(({ id, name, host, postingRestrictedToMods }): Candidate => ({
      id,
      handle: `${name}@${host}`,
      local: false,
      subscribers: null,
      restricted: postingRestrictedToMods,
      followed: true,
    }));
  return [...local, ...remote];
}

/**
 * At most `max` of the candidates, in their order. All of them when they fit; past the cap,
 * the community the form starts in (`keep`) and the person's own follows come first, then the
 * other local communities by name, so the cap never drops a community the person follows to make
 * room for one they do not. `truncated` says some were left out.
 */
function capPicker(rows: readonly Candidate[], keep: string | null, max = pickerMax): { rows: Candidate[]; truncated: boolean } {
  if (rows.length <= max) return { rows: [...rows], truncated: false };
  const rank = (community: Candidate) => (community.id === keep ? 0 : community.followed ? 1 : 2);
  // A stable sort: within a rank the candidates keep their order.
  const kept = new Set(
    rows
      .toSorted((a, b) => rank(a) - rank(b))
      .slice(0, max)
      .map(({ id }) => id),
  );
  return { rows: rows.filter(({ id }) => kept.has(id)), truncated: true };
}

/**
 * The communities the person may pick, at most pickerMax (capPicker), and `selected`, the one
 * `choose` names from the candidates for the form to start in (kept through the cut). A mods-only
 * community is disabled for anyone who is not staff there: one query for all of them.
 */
export async function pickerFor(
  viewer: SessionView,
  choose: (rows: readonly Candidate[]) => string | null,
): Promise<{ communities: PickerCommunity[]; truncated: boolean; selected: string | null }> {
  const all = await candidates(viewer);
  const selected = choose(all);
  const { rows, truncated } = capPicker(all, selected);
  const admin = viewer.siteRole === 'admin';
  const staff = await moderatedAmong(viewer.actorId, admin ? [] : rows.filter(({ restricted }) => restricted).map(({ id }) => id));
  const communities = rows.map(({ followed: _followed, ...community }): PickerCommunity => ({
    ...community,
    canPost: !community.restricted || admin || staff.has(community.id),
  }));
  return { communities, truncated, selected };
}

/** The community `key` (an id, or a handle with or without `!`) names among `rows`, if any. */
export function pickFrom(rows: readonly Candidate[], key: string | null | undefined): string | undefined {
  const wanted = key?.trim().toLowerCase();
  if (!wanted) return undefined;
  return rows.find(({ id, handle }) => id === wanted || handle.toLowerCase() === wanted.replace(/^!/, ''))?.id;
}
