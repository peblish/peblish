import { Avatar } from '@peblish/ui/components/avatar';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Disclosure } from '@peblish/ui/components/disclosure';
import { DisclosureGroup } from '@peblish/ui/components/disclosure-group';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Image } from '@peblish/ui/components/image';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, createPostPath, editCommunityPath, modlogPath, reportQueuePath, userPath } from '../../../shell/paths.ts';
import type { CommunityActionProps } from '../../-actions/props.ts';
import { FeedCards, FeedToolbar } from '../../index/-feed/feed-page.tsx';
import type { FeedSearch } from '../../index/-feed/search.ts';
import { errorKey } from '../-errors.ts';
import type { CommunityPageData } from '../-load.ts';
import { CommunityBlock } from './actions/block.tsx';
import { CommunityModerate } from './actions/moderate.tsx';
import { CommunityReport } from './actions/report.tsx';
import { HideNsfwForm } from './gate.tsx';

// The community page after the R2 mock community-twocol, in Mux UI (mock RM, direction A):
// banner, avatar, header and the feed on the left; About, Rules, Moderators and Languages as
// cards on the right, below the feed on a phone (with a jump link). Counts are local: what this
// server holds. Join, Leave and Cancel are plain form posts to this page (c/-intents.ts);
// hydrated, they post by fetch and reload the loader. Mod tools are a Mux Disclosure, so they
// open once the page has hydrated.

/** One or two letters for an avatar without a picture. */
const initial = (text: string) => (text.trim()[0] ?? '?').toUpperCase();

export function CommunityPage({ data, search, error }: { data: CommunityPageData; search: FeedSearch; error?: string | undefined }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const path = communityPath({ handle: data.handle });
  const actions: CommunityActionProps | null = data.viewer ? { community: data.actor, viewer: data.viewer, back: path } : null;
  const empty = (
    <EmptyState
      title={t('communities', 'page.empty.title')}
      action={
        data.canPost ? (
          <Link href={`${createPostPath}?community=${encodeURIComponent(data.handle)}`}>{t('communities', 'page.empty.first')}</Link>
        ) : undefined
      }
    >
      {t('communities', data.strip ? 'page.empty.remote' : 'page.empty.body')}
    </EmptyState>
  );

  return (
    <main className="cm-page" data-state={data.strip ? 'remote' : 'local'}>
      {data.banner && <Image className="cm-banner" src={data.banner} alt="" radius="md" />}
      <header className="cm-head">
        <Avatar.Root size="lg" className="cm-icon" aria-hidden="true">
          {data.icon && <Avatar.Image src={data.icon} alt="" />}
          <Avatar.Fallback>{initial(data.title)}</Avatar.Fallback>
        </Avatar.Root>
        <div className="cm-title">
          <Text as="h1" variant="heading" size="md">
            {data.title}
          </Text>
          {/* A div: it can hold the Hide NSFW form, which a <p> cannot contain. */}
          <Text as="div" size="sm" color="muted" className="cm-address">
            {data.address}
            {data.nsfl ? (
              <Badge kind="nsfl">{t('communities', 'page.nsfl')}</Badge>
            ) : (
              data.nsfw && <Badge kind="nsfw">{t('communities', 'page.nsfw')}</Badge>
            )}
            {data.restricted && <Badge kind="restricted">{t('communities', 'page.restricted')}</Badge>}
            {(data.nsfw || data.nsfl) && data.viewer && <HideNsfwForm handle={data.handle} back={path} />}
          </Text>
          <Text as="p" size="sm" color="muted" className="cm-stats">
            {data.stats.subscribers} · {data.stats.posts} · {data.stats.created}
          </Text>
        </div>
        <div className="cm-actions">
          <JoinControl data={data} path={path} />
          <NewPost data={data} />
          {actions && (
            <>
              <CommunityReport {...actions} />
              <CommunityBlock {...actions} />
            </>
          )}
        </div>
        {data.canModerate && actions && (
          // In a group, Mux draws the Disclosure with its chevron.
          <DisclosureGroup className="cm-tools">
            <Disclosure title={t('communities', 'mod.tools')}>
              <ul className="cm-tool-links">
                <li>
                  <Link href={reportQueuePath(data.handle)}>{t('communities', 'mod.reports')}</Link>
                </li>
                <li>
                  <Link href={modlogPath(data.handle)}>{t('communities', 'mod.modlog')}</Link>
                </li>
                <li>
                  {data.actor.local ? (
                    <Link href={editCommunityPath(data.handle)}>{t('communities', 'mod.edit')}</Link>
                  ) : (
                    <Text size="sm" color="muted">
                      {t('communities', 'mod.remote')}
                    </Text>
                  )}
                </li>
              </ul>
              <CommunityModerate {...actions} />
            </Disclosure>
          </DisclosureGroup>
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
      <Text as="p" size="sm" className="cm-jump">
        <Link href="#about">{t('communities', 'page.jump')}</Link>
      </Text>
      <div className="cm-layout">
        <section className="pb-page cm-feed" aria-label={data.title}>
          <FeedToolbar path={path} search={search} />
          <FeedCards path={path} data={data.feed} search={search} empty={empty} />
        </section>
        <aside id="about" className="cm-side" aria-label={t('communities', 'page.about')}>
          <SideCard title={t('communities', 'page.about')}>
            {data.about ? (
              <Prose className="cm-about" html={data.about} />
            ) : (
              <Text as="p" size="sm" color="muted">
                {t('communities', 'page.noAbout')}
              </Text>
            )}
          </SideCard>
          <SideCard title={t('communities', 'page.rules')}>
            {data.rules.length === 0 ? (
              <Text as="p" size="sm" color="muted">
                {t('communities', 'page.noRules')}
              </Text>
            ) : (
              <DisclosureGroup>
                <ol className="cm-rules">
                  {data.rules.map((rule, index) => (
                    <li key={index}>
                      {rule.html ? (
                        <Disclosure title={rule.title}>
                          <Prose html={rule.html} />
                        </Disclosure>
                      ) : (
                        <Text>{rule.title}</Text>
                      )}
                    </li>
                  ))}
                </ol>
              </DisclosureGroup>
            )}
          </SideCard>
          <SideCard title={t('communities', 'page.moderators')}>
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
                    <Text size="sm">
                      <Link href={userPath({ handle: moderator.handle })}>@{moderator.handle}</Link>{' '}
                      <Text size="sm" color="muted">
                        {moderator.role}, {moderator.note}
                      </Text>
                    </Text>
                  </li>
                ))}
              </ul>
            )}
          </SideCard>
          {data.languages.length > 0 && (
            <SideCard title={t('communities', 'page.languages')}>
              <Text as="p" size="sm">
                {data.languages.join(', ')}
              </Text>
            </SideCard>
          )}
          <Text as="p" size="sm">
            <Link href={modlogPath(data.handle)}>{t('communities', 'page.modlog')}</Link>
          </Text>
        </aside>
      </div>
    </main>
  );
}

/** One block of the about column: an outlined Mux Card with its heading. */
function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card.Root variant="outlined" padding="sm" className="cm-card">
      <Card.Header>
        <Text as="h2" variant="title" size="sm">
          {title}
        </Text>
      </Card.Header>
      <Card.Body className="cm-card-body">{children}</Card.Body>
    </Card.Root>
  );
}

/** Join, Joined (leave) or Pending (cancel), or what a banned viewer is told. */
function JoinControl({ data, path }: { data: CommunityPageData; path: string }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  if (data.banned)
    return (
      <Text size="sm" color="muted">
        {t('communities', 'error.community.banned')}
      </Text>
    );
  const joined = data.follow !== 'none';
  const intent = joined ? 'unfollow' : 'follow';
  const label =
    data.follow === 'accepted'
      ? t('communities', 'page.joined')
      : data.follow === 'pending'
        ? t('communities', 'page.pending')
        : t('communities', 'page.join');
  const title =
    data.follow === 'accepted'
      ? t('communities', 'page.leave')
      : data.follow === 'pending'
        ? t('communities', 'page.cancelPending')
        : undefined;

  // Hydrated and signed in, the form posts by fetch and reloads the page's data instead of navigating.
  async function submit(event: FormEvent<HTMLFormElement>) {
    if (!data.viewer) return;
    event.preventDefault();
    const response = await fetch(path, { method: 'POST', body: new URLSearchParams({ intent }), headers: { accept: 'application/json' } });
    const answer = (await response.json()) as { ok?: boolean; error?: string };
    setFailure(answer.ok ? null : (answer.error ?? 'generic'));
    await router.invalidate();
  }

  // No redirect field: a post to /c/<handle> comes back to this same page by default (c/-intents.ts).
  return (
    <form method="post" action={path} onSubmit={(event) => void submit(event)} className="cm-join">
      <input type="hidden" name="intent" value={intent} />
      <Button type="submit" variant={joined ? 'neutral' : 'primary'} title={title} aria-pressed={joined ? true : undefined}>
        {label}
      </Button>
      {failure && (
        <Text size="sm" role="alert" className="cm-error">
          {t('communities', errorKey(failure))}
        </Text>
      )}
    </form>
  );
}

/** New post: a link to the composer with this community, or a disabled button and the reason when posting is restricted. */
function NewPost({ data }: { data: CommunityPageData }) {
  const { t } = useTranslate();
  if (data.banned) return null;
  // Mux's Button passes no title, so the reason is a line beside it that describes it.
  if (!data.canPost)
    return (
      <span className="cm-newpost-off">
        <Button variant="neutral" disabled aria-describedby="cm-newpost-why">
          {t('communities', 'page.newPost')}
        </Button>
        <Text size="sm" color="muted" id="cm-newpost-why">
          {t('communities', 'page.newPostRestricted')}
        </Text>
      </span>
    );
  return (
    <Link className="cm-cta" href={`${createPostPath}?community=${encodeURIComponent(data.handle)}`}>
      {t('communities', 'page.newPost')}
    </Link>
  );
}
