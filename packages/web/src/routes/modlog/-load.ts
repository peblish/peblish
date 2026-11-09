import { findActorByHandle, moderatedCommunities } from '@peblish/core/bans/read';
import { describeTargets, labelActors, type ActorLabel, type ModlogLine, type ModlogTarget } from '@peblish/core/modlog/describe';
import type { ModlogViewer } from '@peblish/core/modlog/filters';
import { actionGroups, isActionGroup, type ActionGroup } from '@peblish/core/modlog/groups';
import { modlogFacets, readModlogPage, type ModlogFacets } from '@peblish/core/modlog/page';
import type { ModlogFilter } from '@peblish/schema/modlog';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { pageSession } from '../../server/auth.ts';
import { requestNsfw } from '../c/-gate.ts';

// The modlog page's data (a server function: it runs on the server for a document request and
// over fetch for a client-side navigation). Who may see what is core's: public rows for
// everyone, private ones for admins and, in their own communities, for moderators.

export const pageSize = 50;

/** A filter value no row has. */
const nothing = '00000000-0000-0000-0000-000000000000';

export const ModlogSearch = type({
  /** One entry by id (a notice's "Statement of reasons"). */
  'entry?': 'string',
  'community?': 'string',
  'action?': 'string',
  'remote?': 'boolean',
  'cursor?': 'string',
});
export type ModlogSearch = typeof ModlogSearch.infer;

/** What the page draws of a row: the entry's plain fields and the few details it uses (the rest, such as settings changes, are not sent). */
export type LineView = Omit<ModlogLine, 'entry'> & {
  entry: Pick<ModlogLine['entry'], 'id' | 'action' | 'createdAt' | 'public' | 'reason' | 'reasonWithheld' | 'actorApId'> & {
    details: { expiresAt?: string | null; removeContent?: boolean; removedPosts?: number; removedComments?: number };
  };
};
export type { ModlogTarget };

const lineView = ({ entry, ...rest }: ModlogLine): LineView => ({
  ...rest,
  entry: {
    id: entry.id,
    action: entry.action,
    createdAt: entry.createdAt,
    public: entry.public,
    reason: entry.reason,
    reasonWithheld: entry.reasonWithheld,
    actorApId: entry.actorApId,
    details: {
      ...(entry.details.expiresAt !== undefined && { expiresAt: entry.details.expiresAt }),
      ...(entry.details.removeContent !== undefined && { removeContent: entry.details.removeContent }),
      ...(entry.details.removedPosts !== undefined && { removedPosts: entry.details.removedPosts }),
      ...(entry.details.removedComments !== undefined && { removedComments: entry.details.removedComments }),
    },
  },
});

export type ModlogData = {
  lines: LineView[];
  facets: Omit<ModlogFacets, 'communities'> & { communities: (ModlogFacets['communities'][number] & { label: ActorLabel | null })[] };
  total: number;
  from: number;
  next: string | null;
  /** What the address chose, as the page understood it. */
  chosen: {
    community: ActorLabel | null;
    communityHandle: string | null;
    group: ActionGroup | null;
    remote: boolean;
    cursor: boolean;
    entry: boolean;
  };
  /** An admin, or someone who moderates a community: the Moderator view line and the [mods only] legend. */
  staff: boolean;
  signedIn: boolean;
};

export const loadModlog = createServerFn({ method: 'GET' })
  .validator(ModlogSearch)
  .handler(async ({ data }): Promise<ModlogData> => {
    const session = await pageSession();
    const admin = session?.view.siteRole === 'admin';
    const moderates = session ? (await moderatedCommunities(session.view.actorId)).map((community) => community.id) : [];
    const viewer: ModlogViewer | null = session ? { admin, moderates, actorId: session.view.actorId } : null;
    const community = data.community ? await findActorByHandle(data.community, 'Group') : null;
    const group = data.action && isActionGroup(data.action) ? data.action : null;
    const filter: ModlogFilter = {
      limit: pageSize,
      // An id that is not one matches nothing, as an unknown community does.
      ...(data.entry ? { id: /^[0-9a-f-]{36}$/.test(data.entry) ? data.entry : nothing } : {}),
      // A community nobody holds matches nothing, rather than everything.
      ...(data.community ? { communityId: community?.id ?? nothing } : {}),
      ...(group ? { actions: [...actionGroups[group]] } : {}),
      ...(data.remote ? { remote: true } : {}),
      ...(data.cursor ? { cursor: data.cursor } : {}),
    };
    const [page, facets] = await Promise.all([readModlogPage(filter, { viewer }), modlogFacets(filter, { viewer })]);
    const [lines, labels] = await Promise.all([
      describeTargets(page.entries, { viewer, nsfw: requestNsfw() }),
      labelActors(facets.communities.map((row) => row.id)),
    ]);
    return {
      lines: lines.map(lineView),
      facets: { ...facets, communities: facets.communities.map((row) => ({ ...row, label: labels.get(row.id) ?? null })) },
      total: page.total,
      from: page.from,
      next: page.next,
      chosen: {
        community: community && { id: community.id, handle: community.handle, local: community.local, host: new URL(community.apId).host },
        communityHandle: data.community ?? null,
        group,
        remote: data.remote === true,
        cursor: Boolean(data.cursor),
        entry: Boolean(data.entry),
      },
      staff: admin || moderates.length > 0,
      signedIn: session !== null,
    };
  });
