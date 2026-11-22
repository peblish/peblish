import { authorize } from '@peblish/core/authz/authorize';
import { findCommunityId, listLocalCommunities, moderatedAmong, readCommunity } from '@peblish/core/communities/read';
import { followedCommunities } from '@peblish/core/follows/read';
import { Uuid } from '@peblish/schema/ids';
import type { RefusalReason } from '@peblish/schema/refusal';
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
  // The follows are read as the local communities are: the first by name, one past the cap.
  const [first, follows] = await Promise.all([
    listLocalCommunities({ includeSensitive, limit: pickerMax + 1 }),
    followedCommunities(viewer.actorId, { accepted: true, includeSensitive, limit: pickerMax + 1 }),
  ]);
  const followedIds = new Set(follows.map(({ id }) => id));
  const listed = new Set(first.map(({ actor }) => actor.id));
  // Only on a server with more local communities than the picker lists: names past the first page, so they sort after it.
  // The follows come by name, and the cap keeps no more of them than it lists.
  const missing = follows.filter((community) => community.local && !listed.has(community.id)).map(({ id }) => id);
  const more =
    missing.length > 0 ? await listLocalCommunities({ includeSensitive, ids: missing.slice(0, pickerMax), limit: pickerMax }) : [];
  const local = [...first, ...more].map((row) => localCandidate(row, followedIds.has(row.actor.id)));
  const remote = follows
    .filter((community) => !community.local)
    .map(({ id, name, displayName, host, postingRestrictedToMods }): Candidate => ({
      id,
      handle: `${name}@${host}`,
      displayName,
      local: false,
      subscribers: null,
      restricted: postingRestrictedToMods,
      followed: true,
    }));
  return [...local, ...remote];
}

type LocalRow = Awaited<ReturnType<typeof listLocalCommunities>>[number];

const localCandidate = ({ actor, postingRestrictedToMods, subscribers }: LocalRow, followed: boolean): Candidate => ({
  id: actor.id,
  handle: actor.handle,
  displayName: actor.displayName,
  local: true,
  subscribers,
  restricted: postingRestrictedToMods,
  followed,
});

/**
 * Refusals of post.create that are about the person, not the community: they would refuse a post
 * anywhere, so they do not stop the form from starting in the community asked for.
 */
const anywhere: ReadonlySet<RefusalReason> = new Set(['auth.required', 'auth.email_unverified', 'auth.site_banned', 'site.disabled']);

/** Whether the person may post in the community, as post.create's precheck decides it (bans, mods-only, the age gate, a closed community). */
async function mayPost(viewer: SessionView, communityId: string): Promise<boolean> {
  const principal = { kind: 'local', actorId: viewer.actorId, siteRole: viewer.siteRole } as const;
  const decision = await authorize('post.create', principal, { communityId });
  return decision.ok || anywhere.has(decision.reason);
}

/**
 * The community a `wanted` key (an id, or a handle with or without `!`: `name` here, `name@host`
 * elsewhere) names, looked up on its own, for one the candidates do not hold: a local community
 * past the first page, or a remote one the person does not follow.
 */
async function lookUp(key: string): Promise<Candidate | null> {
  const trimmed = key.trim().replace(/^!/, '');
  if (!trimmed) return null;
  const id = Uuid.allows(trimmed) ? trimmed : await findCommunityId(trimmed);
  const community = id ? await readCommunity({ id }) : null;
  if (!community) return null;
  const { actor } = community;
  return {
    id: actor.id,
    handle: actor.handle,
    displayName: actor.displayName,
    local: actor.local,
    subscribers: actor.local ? community.subscribers : null,
    restricted: community.postingRestrictedToMods,
    followed: false,
  };
}

/**
 * The community the form starts in: the first of `wanted` that names one the person may post in
 * (mayPost), from the candidates or looked up on its own, however it ranks.
 */
async function startIn(
  viewer: SessionView,
  listed: readonly Candidate[],
  wanted: readonly (string | null | undefined)[],
): Promise<{ id: string; extra: Candidate | null } | null> {
  for (const key of wanted) {
    if (!key) continue;
    const held = pickFrom(listed, key);
    const extra = held ? null : await lookUp(key);
    const id = held ?? extra?.id;
    if (id && (await mayPost(viewer, id))) return { id, extra: extra && !listed.some((row) => row.id === extra.id) ? extra : null };
  }
  return null;
}

/** `extra` among the candidates in its place: local ones by name, before the remote ones. */
function withCandidate(rows: readonly Candidate[], extra: Candidate): Candidate[] {
  const name = extra.handle.toLowerCase();
  const at = rows.findIndex((row) => !row.local || row.handle.toLowerCase() > name);
  return at < 0 ? [...rows, extra] : [...rows.slice(0, at), extra, ...rows.slice(at)];
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
 * The communities the person may pick, at most pickerMax (capPicker), and `selected`, the one the
 * form starts in, kept through the cut: an edit's own community, else the first of `wanted` the
 * person may post in (startIn), added in its place when the candidates did not hold it. A mods-only
 * community is disabled for anyone who is not staff there: one query for all of them.
 */
export async function pickerFor(
  viewer: SessionView,
  start: { edit: string | null; wanted: readonly (string | null | undefined)[] },
): Promise<{ communities: PickerCommunity[]; truncated: boolean; selected: string | null }> {
  const listed = await candidates(viewer);
  const chosen = start.edit === null ? await startIn(viewer, listed, start.wanted) : { id: start.edit, extra: null };
  const all = chosen?.extra ? withCandidate(listed, chosen.extra) : listed;
  const selected = chosen?.id ?? null;
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
