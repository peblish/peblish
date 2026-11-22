import { Avatar } from '@peblish/ui/components/avatar';
import { avatarInitial } from '@peblish/ui/components/avatar-initial.ts';
import { Badge } from '@peblish/ui/components/badge';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { FactList, type Fact } from '@peblish/ui/components/fact-list';
import { BidiText, Handle } from '@peblish/ui/components/handle';
import { SquarePenIcon } from '@peblish/ui/components/icons';
import { Image } from '@peblish/ui/components/image';
import { JoinButton, type JoinState } from '@peblish/ui/components/join-button';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { LinkedDisclosure } from '@peblish/ui/components/linked-disclosure';
import { Notice } from '@peblish/ui/components/notice';
import { Prose } from '@peblish/ui/components/prose';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, createPostPath, editCommunityPath, modlogPath, reportQueuePath, userPath } from '../../../shell/paths.ts';
import { Rail } from '../../../shell/rail.tsx';
import type { CommunityActionProps } from '../../-actions/props.ts';
import { FeedCards, FeedToolbar } from '../../index/-feed/feed-page.tsx';
import { feedHref, resolveFeedSearch, type FeedSearch } from '../../index/-feed/search.ts';
import { errorKey } from '../-errors.ts';
import type { CommunityPageData } from '../-load.ts';
import { CommunityBlock } from './actions/block.tsx';
import { CommunityModerate } from './actions/moderate.tsx';
import { CommunityReport } from './actions/report.tsx';
import { HideNsfwForm } from './gate.tsx';

// The community page (Commons, the mock's Community.tsx): who the community is and whether you are
// in it (the header, with Join), a way to post, and its posts, one list at every width, sorted and
// with its Top period as the address says. The charter (about, rules, moderators) is the rail; where
// the page is too narrow for the rail, Posts and About are link tabs (?tab=about), so the charter is
// never dropped and both work without script. Counts are local: what this server holds. Join, Leave
// and Cancel are plain form posts to this page (c/-intents.ts); hydrated, they post by fetch and
// reload the loader. Mod tools are a LinkedDisclosure (?tools=1 renders it open without script).
// Names from other servers are isolated and stripped of directional controls.

// The LinkedDisclosure's id: the fragment its scripts-off link ends with.
const toolsAnchor = 'cm-tools';

/** The first character, whole, for an icon without a picture. */
const initial = (text: string) => avatarInitial(text, '?');

export type CommunityTab = 'posts' | 'about';

export function CommunityPage({
  data,
  search,
  tab = 'posts',
  error,
  tools = false,
}: {
  data: CommunityPageData;
  search: FeedSearch;
  /** Below the rail's width, which tab shows: the posts or the charter. */
  tab?: CommunityTab;
  error?: string | undefined;
  /** Render Mod tools open (?tools=1), for a browser without script. */
  tools?: boolean;
}) {
  const { t } = useTranslate();
  useRouteHydrated();
  const path = communityPath({ handle: data.handle });
  const here = feedHref(path, resolveFeedSearch(search));
  const toolsHref = `${here}${here.includes('?') ? '&' : '?'}tools=1#${toolsAnchor}`;
  const actions: CommunityActionProps | null = data.viewer ? { community: data.actor, viewer: data.viewer, back: path } : null;
  const composeHref = `${createPostPath}?community=${encodeURIComponent(data.handle)}`;
  const empty = (
    <EmptyState
      title={t('communities', 'page.empty.title')}
      action={data.canPost ? <Link href={composeHref}>{t('communities', 'page.empty.first')}</Link> : undefined}
    >
      {t('communities', data.strip ? 'page.empty.remote' : 'page.empty.body')}
    </EmptyState>
  );

  return (
    <>
      <main className="pb-page cm-page" data-state={data.strip ? 'remote' : 'local'} data-tab={tab}>
        {data.banner && <Image className="cm-banner" src={data.banner} alt="" radius="md" />}
        <header className="cm-hero">
          <Avatar.Root size="lg" className="cm-icon" aria-hidden="true">
            {data.icon && <Avatar.Image src={data.icon} alt="" />}
            <Avatar.Fallback>{initial(data.title)}</Avatar.Fallback>
          </Avatar.Root>
          <div className="cm-id">
            <Text as="h1" variant="title" size="sm" className="cm-name">
              <BidiText text={data.title} />
            </Text>
            {/* A div: it can hold the Hide NSFW form, which a <p> cannot contain. */}
            <Text as="div" size="sm" className="cm-address">
              <Handle prefix="!" handle={data.address} />
              {data.nsfl ? (
                <Badge kind="nsfl">{t('communities', 'page.nsfl')}</Badge>
              ) : (
                data.nsfw && <Badge kind="nsfw">{t('communities', 'page.nsfw')}</Badge>
              )}
              {data.restricted && <Badge kind="restricted">{t('communities', 'page.restricted')}</Badge>}
              {(data.nsfw || data.nsfl) && data.viewer && <HideNsfwForm handle={data.handle} back={path} />}
            </Text>
          </div>
          <div className="cm-actions">
            <JoinControl data={data} path={path} />
            {actions && (
              <>
                <CommunityReport {...actions} />
                <CommunityBlock {...actions} />
              </>
            )}
          </div>
          <FactList
            layout="inline"
            className="cm-stats"
            items={[
              { key: 'subscribers', label: data.stats.subscribers.label, value: data.stats.subscribers.value },
              { key: 'posts', label: data.stats.posts.label, value: data.stats.posts.value },
              { key: 'created', label: data.stats.created.label, value: data.stats.created.value },
            ]}
          />
          {data.canModerate && actions && (
            // The moderation slot adds the Modlog link.
            <LinkedDisclosure
              id={toolsAnchor}
              className="cm-tools"
              title={t('communities', 'mod.tools')}
              openHref={toolsHref}
              defaultExpanded={tools}
            >
              {/* One row: Reports, Edit community, then the slot's Modlog; a remote copy says why Edit is missing last. */}
              <div className="cm-tool-row">
                <ul className="cm-tool-links">
                  <li>
                    <Link href={reportQueuePath(data.handle)}>{t('communities', 'mod.reports')}</Link>
                  </li>
                  {data.actor.local && (
                    <li>
                      <Link href={editCommunityPath(data.handle)}>{t('communities', 'mod.edit')}</Link>
                    </li>
                  )}
                </ul>
                <CommunityModerate {...actions} />
                {!data.actor.local && (
                  <Text size="sm" color="muted">
                    {t('communities', 'mod.remote')}
                  </Text>
                )}
              </div>
            </LinkedDisclosure>
          )}
        </header>
        {error && (
          <Notice tone="danger" role="alert" className="cm-notice">
            {t('communities', errorKey(error))}
          </Notice>
        )}
        {data.strip && (
          <Notice className="cm-strip cm-notice" title={t('communities', 'strip.title')}>
            {t('communities', 'strip.home', { host: data.strip.home })} · {data.strip.refreshed}
            {data.strip.open && (
              <>
                {' · '}
                <Link href={data.strip.open} rel="noopener noreferrer nofollow">
                  {t('communities', 'strip.open', { host: data.strip.home })}
                </Link>
              </>
            )}
          </Notice>
        )}
        <StartPost data={data} href={composeHref} />
        <LinkTabs
          aria-label={t('communities', 'page.tabs')}
          className="cm-tabs"
          size="sm"
          items={[
            { to: here, label: t('communities', 'page.posts'), active: tab === 'posts' },
            { to: `${path}?tab=about`, label: t('communities', 'page.about'), active: tab === 'about' },
          ]}
        />
        <section className="cm-posts" aria-labelledby="cm-posts-title">
          <FeedToolbar path={path} search={search}>
            <Text as="h2" id="cm-posts-title" variant="label" size="md" className="cm-posts-title">
              {t('communities', 'page.posts')}
            </Text>
          </FeedToolbar>
          <FeedCards path={path} data={data.feed} search={search} empty={empty} />
        </section>
      </main>
      {/* The charter, once: the rail beside a wide page, and where the rail gives way, on the About tab, the
          rail in the page's flow in place of the posts (community.css), so an id inside it names one element. */}
      <Rail label={t('communities', 'page.rail', { title: data.title })} className="cm-rail">
        <Charter data={data} />
      </Rail>
    </>
  );
}

/**
 * The community's charter (the mock's Charter): About with the facts this server holds and the
 * community's own text, its rules (always shown in full: they are content), its moderators, and the
 * modlog. In the rail, which on a narrower page is the About tab's content.
 */
function Charter({ data }: { data: CommunityPageData }) {
  const { t } = useTranslate();
  const facts: Fact[] = [
    {
      key: 'home',
      label: t('communities', 'page.fact.home'),
      value: data.strip ? data.strip.home : t('communities', 'page.fact.homeHere'),
    },
    ...(data.languages.length > 0
      ? [{ key: 'languages', label: t('communities', 'page.languages'), value: data.languages.join(', ') }]
      : []),
    {
      key: 'posting',
      label: t('communities', 'page.fact.posting'),
      value: t('communities', data.restricted ? 'page.fact.postingStaff' : 'page.fact.postingAnyone'),
    },
  ];
  return (
    <>
      <RailPanel title={t('communities', 'page.about')}>
        <FactList size="xs" items={facts} />
        {data.about ? (
          <Prose className="cm-about" html={data.about} />
        ) : (
          <Text as="p" size="sm" color="muted">
            {t('communities', 'page.noAbout')}
          </Text>
        )}
        {data.follow === 'pending' && data.strip && (
          <Text as="p" size="sm" color="muted">
            {t('communities', 'page.pendingNote', { host: data.strip.home })}
          </Text>
        )}
      </RailPanel>
      <RailPanel title={t('communities', 'page.rules')}>
        {data.rules.length === 0 ? (
          <Text as="p" size="sm" color="muted">
            {t('communities', 'page.noRules')}
          </Text>
        ) : (
          <ol className="cm-rules">
            {data.rules.map((rule, index) => (
              <li key={index}>
                {rule.html ? (
                  <>
                    <Text as="p" variant="label" size="sm">
                      {rule.title}
                    </Text>
                    <Prose className="cm-rule-body" html={rule.html} />
                  </>
                ) : (
                  <Text as="p" size="sm">
                    {rule.title}
                  </Text>
                )}
              </li>
            ))}
          </ol>
        )}
      </RailPanel>
      <RailPanel title={t('communities', 'page.moderators')}>
        {data.moderators.length === 0 ? (
          <Text as="p" size="sm" color="muted">
            {t('communities', 'page.noModerators')}
          </Text>
        ) : (
          <ul className="cm-mods">
            {data.moderators.map((moderator) => (
              <li key={moderator.handle}>
                <Avatar.Root size="sm" aria-hidden="true">
                  <Avatar.Fallback>{initial(moderator.handle)}</Avatar.Fallback>
                </Avatar.Root>
                <span className="cm-mod">
                  <Text size="sm">
                    <Link href={userPath({ handle: moderator.handle })} className="pb-link-quiet">
                      <Handle prefix="@" handle={moderator.handle} />
                    </Link>
                  </Text>
                  <Text size="xs" color="muted">
                    {moderator.role}, {moderator.note}
                  </Text>
                </span>
              </li>
            ))}
          </ul>
        )}
      </RailPanel>
      <Text as="p" size="sm" className="cm-modlog">
        <Link href={modlogPath(data.handle)}>{t('communities', 'page.modlog')}</Link>
      </Text>
    </>
  );
}

const joinState = (follow: CommunityPageData['follow']): JoinState =>
  follow === 'accepted' ? 'joined' : follow === 'pending' ? 'pending' : 'none';

/** Join, Joined (leave) or Pending (cancel), or what a banned viewer is told. */
function JoinControl({ data, path }: { data: CommunityPageData; path: string }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (data.banned)
    return (
      <Text size="sm" color="muted">
        {t('communities', 'error.community.banned')}
      </Text>
    );
  const state = joinState(data.follow);
  const intent = state === 'none' ? 'follow' : 'unfollow';

  // Hydrated and signed in, the form posts by fetch and reloads the page's data instead of navigating.
  async function submit(event: FormEvent<HTMLFormElement>) {
    if (!data.viewer) return;
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: 'POST',
        body: new URLSearchParams({ intent }),
        headers: { accept: 'application/json' },
      });
      const answer = (await response.json()) as { ok?: boolean; error?: string };
      setFailure(answer.ok ? null : (answer.error ?? 'generic'));
      await router.invalidate();
    } catch {
      setFailure('generic');
    } finally {
      setBusy(false);
    }
  }

  // No redirect field: a post to /c/<handle> comes back to this same page by default (c/-intents.ts).
  return (
    <form method="post" action={path} onSubmit={(event) => void submit(event)} className="cm-join">
      <input type="hidden" name="intent" value={intent} />
      <JoinButton
        state={state}
        busy={busy}
        labels={{
          join: t('communities', 'page.join'),
          joined: t('communities', 'page.joined'),
          leave: t('communities', 'page.leave'),
          pending: t('communities', 'page.pending'),
          cancel: t('communities', 'page.cancelPending'),
        }}
        error={failure ? t('communities', errorKey(failure)) : undefined}
      />
    </form>
  );
}

/**
 * The way to post here (the mock's StartPost): a link to the composer with this community chosen, or,
 * where only its moderators post, a line that says so. Nothing for a viewer banned from it.
 */
function StartPost({ data, href }: { data: CommunityPageData; href: string }) {
  const { t } = useTranslate();
  if (data.banned) return null;
  if (!data.canPost)
    return (
      <Text as="p" size="sm" color="muted" className="cm-start cm-start--off">
        {t('communities', 'page.newPostRestricted')}
      </Text>
    );
  return (
    <div className="cm-start">
      <ButtonLink href={href} variant="neutral" className="cm-start__link">
        <SquarePenIcon />
        {t('communities', 'page.startPost', { title: data.title })}
      </ButtonLink>
    </div>
  );
}
