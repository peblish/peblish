import { Prose } from '@peblish/ui/components/prose';
import { Button } from '@peblish/ui/components/button';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import type { MessageKey } from '../../../i18n/translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, createPostPath, editCommunityPath, modlogPath, reportQueuePath, userPath } from '../../../shell/paths.ts';
import type { CommunityActionProps } from '../../-actions/props.ts';
import { FeedCards, FeedToolbar } from '../../index/-feed/feed-page.tsx';
import type { FeedSearch } from '../../index/-feed/search.ts';
import type { CommunityPageData } from '../-load.ts';
import { CommunityBlock } from './actions/block.tsx';
import { CommunityModerate } from './actions/moderate.tsx';
import { CommunityReport } from './actions/report.tsx';
import { HideNsfwForm } from './gate.tsx';

// The community page after the R2 mock community-twocol: banner, header and the feed on the left;
// About, Rules, Moderators, Languages and the Modlog link on the right, below the feed on a
// phone (with a jump link). Counts are local: what this server holds. Join, Leave and Cancel are
// plain form posts to this page (c/-intents.ts); hydrated, they post by fetch and reload the
// loader. Mod tools are a <details> (no menu component on the first-tap path).

// The refusals a Join or Leave can come back with; the catalogue has all of them.
const joinErrors = new Set(['auth.required', 'community.banned', 'community.removed', 'community.deleted', 'target.not_found']);
const errorKey = (reason: string): MessageKey<'communities'> =>
  joinErrors.has(reason) ? (`error.${reason}` as MessageKey<'communities'>) : 'error.generic';

export function CommunityPage({ data, search, error }: { data: CommunityPageData; search: FeedSearch; error?: string | undefined }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const path = communityPath({ handle: data.handle });
  const actions: CommunityActionProps | null = data.viewer ? { community: data.actor, viewer: data.viewer, back: path } : null;
  const empty = (
    <section className="feed-empty">
      <h2>{t('communities', 'page.empty.title')}</h2>
      <p>{t('communities', data.strip ? 'page.empty.remote' : 'page.empty.body')}</p>
      {data.canPost && (
        <p>
          <a href={`${createPostPath}?community=${encodeURIComponent(data.handle)}`}>{t('communities', 'page.empty.first')}</a>
        </p>
      )}
    </section>
  );

  return (
    <main className="cm-page" data-state={data.strip ? 'remote' : 'local'}>
      {data.banner && <img className="cm-banner" src={data.banner} alt="" />}
      <header className="cm-head">
        {data.icon && <img className="cm-icon" src={data.icon} alt="" width={64} height={64} />}
        <div className="cm-title">
          <h1>{data.title}</h1>
          <p className="cm-address">
            {data.address}
            {data.nsfl ? (
              <span className="cm-tag">{t('communities', 'page.nsfl')}</span>
            ) : (
              data.nsfw && <span className="cm-tag">{t('communities', 'page.nsfw')}</span>
            )}
            {data.restricted && <span className="cm-tag">{t('communities', 'page.restricted')}</span>}
            {(data.nsfw || data.nsfl) && data.viewer && <HideNsfwForm handle={data.handle} back={path} />}
          </p>
          <p className="cm-stats">
            {data.stats.subscribers} · {data.stats.posts} · {data.stats.created}
          </p>
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
          {data.canModerate && actions && (
            <details className="cm-tools">
              <summary>{t('communities', 'mod.tools')}</summary>
              <ul>
                <li>
                  <a href={reportQueuePath(data.handle)}>{t('communities', 'mod.reports')}</a>
                </li>
                <li>
                  <a href={modlogPath(data.handle)}>{t('communities', 'mod.modlog')}</a>
                </li>
                {data.actor.local ? (
                  <li>
                    <a href={editCommunityPath(data.handle)}>{t('communities', 'mod.edit')}</a>
                  </li>
                ) : (
                  <li className="cm-muted">{t('communities', 'mod.remote')}</li>
                )}
              </ul>
              <CommunityModerate {...actions} />
            </details>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="cm-error">
          {t('communities', errorKey(error))}
        </p>
      )}
      {data.strip && (
        <p className="cm-strip">
          <strong>{t('communities', 'strip.title')}</strong> · {t('communities', 'strip.home', { host: data.strip.home })} ·{' '}
          {data.strip.refreshed}
          {data.strip.open && (
            <>
              {' · '}
              <a href={data.strip.open} rel="noopener noreferrer nofollow">
                {t('communities', 'strip.open', { host: data.strip.home })}
              </a>
            </>
          )}
        </p>
      )}
      <p className="cm-jump">
        <a href="#about">{t('communities', 'page.jump')}</a>
      </p>
      <div className="cm-layout">
        <section className="pb-page feed cm-feed" aria-label={data.title}>
          <FeedToolbar path={path} search={search} />
          <FeedCards path={path} data={data.feed} search={search} empty={empty} />
        </section>
        <aside id="about" className="cm-side" aria-label={t('communities', 'page.about')}>
          <section>
            <h2>{t('communities', 'page.about')}</h2>
            {data.about ? <Prose className="cm-about" html={data.about} /> : <p className="cm-muted">{t('communities', 'page.noAbout')}</p>}
          </section>
          <section>
            <h2>{t('communities', 'page.rules')}</h2>
            {data.rules.length === 0 ? (
              <p className="cm-muted">{t('communities', 'page.noRules')}</p>
            ) : (
              <ol className="cm-rules">
                {data.rules.map((rule, index) => (
                  <li key={index}>
                    {rule.html ? (
                      <details>
                        <summary>{rule.title}</summary>
                        <Prose html={rule.html} />
                      </details>
                    ) : (
                      rule.title
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <h2>{t('communities', 'page.moderators')}</h2>
            {data.moderators.length === 0 ? (
              <p className="cm-muted">{t('communities', 'page.noModerators')}</p>
            ) : (
              <ul className="cm-mods">
                {data.moderators.map((moderator) => (
                  <li key={moderator.handle}>
                    <a href={userPath({ handle: moderator.handle })}>@{moderator.handle}</a>
                    <span className="cm-muted">
                      {' '}
                      {moderator.role}, {moderator.note}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.languages.length > 0 && (
            <section>
              <h2>{t('communities', 'page.languages')}</h2>
              <p>{data.languages.join(', ')}</p>
            </section>
          )}
          <p>
            <a href={modlogPath(data.handle)}>{t('communities', 'page.modlog')}</a>
          </p>
        </aside>
      </div>
    </main>
  );
}

/** Join, Joined (leave) or Pending (cancel), or what a banned viewer is told. */
function JoinControl({ data, path }: { data: CommunityPageData; path: string }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  if (data.banned) return <p className="cm-muted">{t('communities', 'error.community.banned')}</p>;
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

  return (
    <form method="post" action={path} onSubmit={(event) => void submit(event)} className="cm-join">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="redirect" value={path} />
      <Button type="submit" variant={joined ? 'neutral' : 'primary'} title={title} aria-pressed={joined ? true : undefined}>
        {label}
      </Button>
      {failure && (
        <span role="alert" className="cm-error">
          {t('communities', errorKey(failure))}
        </span>
      )}
    </form>
  );
}

/** New post: a link to the composer with this community, or disabled with the reason when posting is restricted. */
function NewPost({ data }: { data: CommunityPageData }) {
  const { t } = useTranslate();
  if (data.banned) return null;
  if (!data.canPost)
    return (
      <span className="cm-disabled" aria-disabled="true" title={t('communities', 'page.newPostRestricted')}>
        {t('communities', 'page.newPost')}
      </span>
    );
  return (
    <a className="cm-newpost" href={`${createPostPath}?community=${encodeURIComponent(data.handle)}`}>
      {t('communities', 'page.newPost')}
    </a>
  );
}
