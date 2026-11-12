import { communityGate, readCommunityPage } from '@peblish/core/communities/page';
import { findCommunityId } from '@peblish/core/communities/read';
import { defaultPageSize, Period, Sort } from '@peblish/core/feeds/input';
import { readFeed } from '@peblish/core/feeds/read';
import type { Viewer } from '@peblish/core/posts/read';
import type { ActorRef } from '@peblish/schema/views';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { negotiateLocale } from '../../i18n/negotiate.ts';
import { translate, type MessageKey } from '../../i18n/translate.ts';
import { pageSession } from '../../server/auth.ts';
import { createMarkdownRenderer, siteMarkdown } from '../../server/markdown.ts';
import { communityPath } from '../../shell/paths.ts';
import type { SlotViewer } from '../-actions/props.ts';
import { feedItem } from '../index/-feed/items.ts';
import { agoText, dateText, languageName } from './-format.ts';
import { gateData, requestNsfw } from './-gate.ts';
import { input } from '../../server/input.ts';

/** No such community (unknown, deleted or removed): the route throws notFound with the handle for its own not-found page. */
const missing = (handle: string) => ({ kind: 'missing' as const, handle });

/**
 * The community page's data, for the route loader (a server function). The NSFW gate is
 * decided first, from the community's flags alone: a gated viewer gets `kind: 'gate'` with the
 * handle and nothing else is read. Otherwise the page: the community with its counts held here,
 * the sidebar rendered once, moderators with how far to trust each, and the first page of its
 * posts (the feed machinery, scoped to the community). Numbers, dates and ages are text made
 * here, in the request's locale, so hydration formats nothing. `kind: 'missing'`: no such community (404).
 */
export const loadCommunityPage = createServerFn({ method: 'GET' })
  .validator(input(type({ handle: 'string', sort: Sort, period: Period, 'cursor?': 'string <= 400' })))
  .handler(async ({ data }) => {
    const session = await pageSession();
    const viewer: Viewer = session ? { actorId: session.view.actorId, siteRole: session.view.siteRole } : null;
    const id = await findCommunityId(data.handle);
    const gate = id && (await communityGate(id, viewer, requestNsfw()));
    if (!id || !gate) return missing(data.handle);
    if (gate !== 'none') return gateData({ subject: 'community', gate, handle: data.handle, back: communityPath({ handle: data.handle }) });

    const renderer = await createMarkdownRenderer(await siteMarkdown());
    // A remote summary's images stay inline here and are signed once, for this community, when
    // the sidebar is sanitised below (signing them here too would sign the proxy paths again).
    const page = await readCommunityPage({ id }, viewer, undefined, { rewriteImageUrl: (url) => url });
    if (!page) return missing(data.handle);
    const community = { kind: 'actor', id, apId: page.actor.apId } as const;
    const locale = negotiateLocale(getRequestHeader('accept-language'));
    const now = new Date();
    const count = new Intl.NumberFormat(locale);
    const text = (key: MessageKey<'communities'>, params?: Record<string, string | number>) =>
      translate(locale, 'communities', key, params);
    const { actor } = page;
    const remote = !actor.local;
    const feed = await readFeed(
      { feed: 'all', sort: data.sort, period: data.period, cursor: data.cursor, limit: defaultPageSize, scope: { communityId: id } },
      viewer,
    );
    const sidebar = page.summaryMd
      ? renderer.render(page.summaryMd, { content: community }).html
      : page.summaryHtml
        ? renderer.sanitize(page.summaryHtml, { baseUrl: actor.apId, content: community }).html
        : null;
    const slotViewer: SlotViewer | null = session
      ? { actorId: session.view.actorId, moderator: page.canModerate, admin: session.view.siteRole === 'admin' }
      : null;

    return {
      kind: 'page' as const,
      /** As the address names it: the forms post here. */
      handle: data.handle,
      actor: actor satisfies ActorRef,
      title: actor.displayName ?? actor.name,
      /** The full handle, name@home, without the `!`. */
      address: `${actor.name}@${page.home}`,
      nsfw: page.sensitive,
      nsfl: page.nsfl,
      restricted: page.postingRestrictedToMods,
      indexable: page.indexable,
      banner: renderer.image(page.bannerUrl, community),
      icon: renderer.image(page.iconUrl, community),
      stats: {
        subscribers: { label: text(remote ? 'page.stat.subscribersHere' : 'page.stat.subscribers'), value: count.format(page.subscribers) },
        posts: { label: text(remote ? 'page.stat.postsHeld' : 'page.stat.posts'), value: count.format(page.postCount) },
        created: { label: text('page.stat.created'), value: dateText(locale, page.createdAt) },
      },
      strip: remote
        ? {
            home: page.home,
            refreshed: page.fetchedAt
              ? text('strip.refreshed', { ago: agoText(locale, page.fetchedAt, now) })
              : text('strip.neverRefreshed'),
            open: /^https?:\/\//.test(actor.apId) ? actor.apId : null,
          }
        : null,
      follow: page.followState,
      banned: page.banned,
      canPost: page.canPost,
      canModerate: page.canModerate,
      viewer: slotViewer,
      about: sidebar,
      rules: page.rules.map((rule) => ({
        title: rule.title,
        html: rule.bodyMd ? renderer.render(rule.bodyMd, { idPrefix: `rule-${rule.position}`, content: community }).html : null,
      })),
      moderators: page.moderators.map(({ actor: person, role, state, verifiedAt, since }) => ({
        handle: person.handle,
        role: text(role === 'owner' ? 'strip.role.owner' : 'strip.role.moderator'),
        note: text(`strip.state.${state}`, { ago: agoText(locale, verifiedAt ?? since, now) }),
      })),
      languages: page.languages.map((code) => (code === 'und' ? text('page.language.und') : languageName(locale, code))),
      feed: {
        items: feed.items.map((post) => feedItem(post, renderer.image)),
        next: feed.next,
        now: now.toISOString(),
        signedIn: viewer !== null,
      },
    };
  });

export type CommunityPageData = Extract<Awaited<ReturnType<typeof loadCommunityPage>>, { kind: 'page' }>;
