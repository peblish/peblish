import { defaultPageSize } from '@peblish/core/feeds/input';
import type { Viewer } from '@peblish/core/posts/read';
import { profileSorts, profileTabs } from '@peblish/core/profiles/input';
import { publicActorRef, readActivity, readProfile, type Profile } from '@peblish/core/profiles/read';
import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, CommentView } from '@peblish/schema/views';
import { absoluteTime, compactAge } from '@peblish/ui/components/time';
import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader, setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { negotiateLocale } from '../../../i18n/negotiate.ts';
import { pageSession } from '../../../server/auth.ts';
import { createMarkdownRenderer } from '../../../server/markdown.ts';
import { userPath } from '../../../shell/paths.ts';
import { feedItem, type FeedItem } from '../../index/-feed/items.ts';

/** One line of the activity list. A comment carries its rendered text and where it was said. */
export type ProfileEntry =
  { kind: 'post'; item: FeedItem } | { kind: 'comment'; view: CommentView; post: { id: Uuid; title: string }; community: ActorRef };

export type ProfileData = {
  person: ActorRef;
  /** The avatar the page may load (own-origin path or the signed proxy), else null. */
  avatarSrc: string | null;
  /** The bio, rendered and sanitised; null when there is none. */
  bioHtml: string | null;
  joinedAt: string;
  counts: Profile['counts'];
  badges: Profile['badges'];
  /** A remote person's home host and how long ago this copy was refreshed, as text in the request's locale. */
  home: { host: string; age: string | null } | null;
  state: Profile['state'];
  blocked: Profile['blocked'];
  moderatedCommunities: ActorRef[];
  indexable: boolean;
  /** The signed-in person, or null. */
  viewer: { actorId: Uuid; admin: boolean } | null;
  tab: (typeof profileTabs)[number];
  sort: (typeof profileSorts)[number];
  after: string | null;
  entries: ProfileEntry[];
  next: string | null;
  /** The clock the post cards print their ages against, so server and browser agree. */
  now: string;
  /** Each comment's time as text in the request's locale. */
  times: Record<string, { age: string; title: string }>;
};

/**
 * A profile page for the route loader (a server function: private, as the blocked state and the
 * tools depend on who asks). Null for a handle that is no person here. A deleted account and a
 * person the viewer blocks get no activity query.
 */
async function buildProfile(
  data: { handle: string; tab: ProfileData['tab']; sort: ProfileData['sort']; after?: string | undefined },
  withActivity: boolean,
): Promise<{ data: ProfileData; profile: Profile } | null> {
  const session = await pageSession();
  const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
  const profile = await readProfile(data.handle, viewer);
  if (!profile) return null;
  const renderer = await createMarkdownRenderer();
  const locale = negotiateLocale(getRequestHeader('accept-language'));
  const now = new Date();

  const shown = withActivity && profile.state === 'live' && profile.blocked === null;
  const page = shown
    ? await readActivity({ personId: profile.actor.id, tab: data.tab, sort: data.sort, cursor: data.after, limit: defaultPageSize }, viewer)
    : { items: [], next: null };
  const times: ProfileData['times'] = {};
  const entries = page.items.map((item): ProfileEntry => {
    if (item.kind === 'post') return { kind: 'post', item: feedItem(item.post, renderer.image) };
    const { view, body, post, community } = item.comment;
    const contentHtml =
      body?.kind === 'markdown'
        ? renderer.render(body.source, { idPrefix: view.id }).html
        : body
          ? renderer.sanitize(body.html, { baseUrl: body.baseUrl }).html
          : null;
    times[view.id] = { age: compactAge(view.publishedAt, now, locale), title: absoluteTime(view.publishedAt, locale) };
    return { kind: 'comment', view: { ...view, contentHtml }, post, community: publicActorRef(community) };
  });

  const bioHtml =
    profile.bio?.kind === 'markdown'
      ? renderer.render(profile.bio.source, { idPrefix: 'bio' }).html
      : profile.bio
        ? renderer.sanitize(profile.bio.html, { baseUrl: profile.bio.baseUrl }).html
        : null;
  return {
    profile,
    data: {
      // Only the allowlisted fields are dehydrated into the page.
      person: publicActorRef(profile.actor),
      avatarSrc: renderer.image(profile.iconUrl),
      bioHtml: bioHtml || null,
      joinedAt: profile.joinedAt,
      counts: profile.counts,
      badges: profile.badges,
      home: profile.home && {
        host: profile.home.host,
        age: profile.home.refreshedAt ? compactAge(profile.home.refreshedAt, now, locale) : null,
      },
      state: profile.state,
      blocked: profile.blocked,
      moderatedCommunities: profile.moderatedCommunities.map(publicActorRef),
      indexable: profile.indexable,
      viewer: viewer && { actorId: viewer.actorId, admin: viewer.siteRole === 'admin' },
      tab: data.tab,
      sort: data.sort,
      after: data.after ?? null,
      entries,
      next: page.next,
      now: now.toISOString(),
      times,
    },
  };
}

const Request = type({
  handle: 'string <= 300',
  tab: type.enumerated(...profileTabs),
  sort: type.enumerated(...profileSorts),
  'after?': 'string <= 400',
});

export const loadProfile = createServerFn({ method: 'GET' })
  .validator(Request)
  .handler(async ({ data }): Promise<ProfileData | null> => {
    const built = await buildProfile(data, true);
    // A path that negotiates by Accept falls through federation to the page with a status the page does not set itself.
    if (!built) setResponseStatus(404);
    return built?.data ?? null;
  });

/** What the edit page needs: the card's data (no activity) and the current values of the form. Null when the handle is no person here. */
export type EditData = { profile: ProfileData; form: { displayName: string; bio: string } };

export const loadEdit = createServerFn({ method: 'GET' })
  .validator(type({ handle: 'string <= 300' }))
  .handler(async ({ data }): Promise<EditData | null> => {
    const built = await buildProfile({ handle: data.handle, tab: 'overview', sort: 'new' }, false);
    if (!built) return null;
    const { profile } = built;
    // Own profile only: signed out signs in, anyone else is sent to the page they can see.
    if (!built.data.viewer) throw redirect({ to: '/auth/sign-in', search: { redirect: `${userPath(built.data.person)}/edit` } });
    if (!profile.badges.you) throw redirect({ href: userPath(built.data.person) });
    return {
      profile: built.data,
      form: { displayName: profile.actor.displayName ?? '', bio: profile.bio?.kind === 'markdown' ? profile.bio.source : '' },
    };
  });
