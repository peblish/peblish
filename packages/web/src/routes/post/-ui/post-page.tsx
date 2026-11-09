import type { ReactNode } from 'react';
import { Button } from '@peblish/ui/components/button';
import { Prose } from '@peblish/ui/components/prose';
import { VoteControl } from '@peblish/ui/components/vote-control';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { useVoteLabels } from '../../../shell/labels.ts';
import { castVoteFn } from '../-vote.ts';
import type { PostPageData } from '../-load.ts';
import { ThreadSection } from '../$id/comments/-ui/thread-section.tsx';
import { ActionForm } from './action-form.tsx';
import { asPostError, errorKey } from './errors.ts';

// The post page after thread-nested.html's post part: vote column, title and link, community
// and author, body, the actions the MVP has. Left out on purpose: lock and pin authoring, save,
// crosspost, share and report. Sensitive and tombstone states withhold their content in core
// (readPost); this only lays out what it was given.

export function PostPage({ data, error }: { data: PostPageData; error?: string | undefined }) {
  const { t, locale } = useTranslate();
  useRouteHydrated();
  const { post, gate, moderator, viewerId } = data;
  const back = `/post/${post.id}`;
  const signInHref = `/auth/sign-in?redirect=${encodeURIComponent(back)}`;
  const isAuthor = viewerId === post.author.id;
  const withheld = post.deleted ? 'deleted' : gate === 'sign-in' || gate === 'age' ? 'gate' : post.removed && !moderator ? 'removed' : null;
  const count = post.counts.comments;
  const shownError = asPostError(error);
  const voteLabels = useVoteLabels();

  let body: ReactNode;
  if (post.deleted) {
    body = (
      <section className="post-notice" data-state="deleted">
        <h1>{t('posts', 'deleted.title')}</h1>
        <p>{t('posts', 'deleted.body')}</p>
      </section>
    );
  } else if (gate === 'sign-in' || gate === 'age') {
    body = (
      <section className="post-notice" data-state="gate">
        <h1>{t('posts', 'gate.title')}</h1>
        {gate === 'sign-in' ? (
          <p>
            {t('posts', 'gate.signIn')} <a href={signInHref}>{t('posts', 'gate.signInLink')}</a>
          </p>
        ) : (
          <p>
            {t('posts', 'gate.age')} <a href="/settings/account">{t('posts', 'gate.ageLink')}</a>
          </p>
        )}
      </section>
    );
  } else if (post.removed && !moderator) {
    body = (
      <section className="post-notice" data-state="removed">
        <h1>{t('posts', 'removed.title')}</h1>
        <p>{t('posts', 'removed.body')}</p>
      </section>
    );
  } else {
    const blurred = gate === 'blur';
    const content = (
      <div className="post-sensitive__content">
        <h1 id="post-title">{post.title}</h1>
        {(post.locked || post.featured || post.sensitive || post.nsfl) && (
          <p className="post-flags">
            {post.locked && <span data-flag="locked">{t('posts', 'flag.locked')}</span>}
            {post.featured && <span data-flag="pinned">{t('posts', 'flag.pinned')}</span>}
            {post.nsfl ? (
              <span data-flag="nsfl">{t('posts', 'flag.nsfl')}</span>
            ) : (
              post.sensitive && <span data-flag="sensitive">{t('posts', 'flag.sensitive')}</span>
            )}
          </p>
        )}
        {data.image ? (
          <a className="post-image" href={post.url ?? undefined} rel="noopener noreferrer nofollow ugc">
            <img src={data.image} alt={post.title} loading="lazy" />
          </a>
        ) : (
          post.url && (
            <a className="post-link" href={post.url} rel="noopener noreferrer nofollow ugc">
              {data.thumbnail && <img src={data.thumbnail} alt="" loading="lazy" />}
              <span>{data.domain ?? t('posts', 'link.open')}</span>
            </a>
          )
        )}
        {/* The HTML comes from the Markdown renderer or the sanitiser (-load.ts), never from anywhere else. */}
        {post.contentHtml && <Prose className="post-text" html={post.contentHtml} />}
      </div>
    );
    body = blurred ? (
      <div className="post-sensitive" data-gate="blur">
        <input id="post-reveal" type="checkbox" className="post-reveal" />
        <label htmlFor="post-reveal">{t('posts', 'gate.show')}</label>
        <p className="post-hint">{t('posts', 'gate.blur')}</p>
        {content}
      </div>
    ) : (
      content
    );
  }

  return (
    // Keyed by the post: the router reuses this component when a link goes from one post to another, and
    // the vote control's optimistic vote and queue, the thread's and the forms' state belong to one post.
    <main key={post.id} className="post-page" data-state={withheld ?? 'visible'}>
      <article className="post" aria-labelledby={withheld ? undefined : 'post-title'}>
        <VoteControl
          score={post.counts.upvotes - post.counts.downvotes}
          myVote={post.myVote}
          // A refusal throws, which puts the arrows and the score back.
          onVote={async (value) => {
            const result = await castVoteFn({ data: { target: { kind: 'post', id: post.id }, value } });
            if (!result.ok) throw new Error(result.reason);
          }}
          disabled={viewerId === null || post.deleted || withheld !== null}
          labels={{ ...voteLabels, group: t('posts', 'vote.group') }}
          locale={locale}
        />
        <div className="post-main">
          <p className="post-meta">
            <a href={`/c/${post.community.handle}`}>!{post.community.handle}</a> {t('posts', 'meta.by')}{' '}
            <a href={`/u/${post.author.handle}`}>@{post.author.handle}</a>
            {post.authorBadge && (
              <span className="post-badge">{t('posts', post.authorBadge === 'admin' ? 'badge.admin' : 'badge.moderator')}</span>
            )}{' '}
            · <time dateTime={post.publishedAt}>{data.published}</time>
            {data.edited && <> · {t('posts', 'meta.edited', { date: data.edited })}</>}
          </p>
          {body}
          {shownError && (
            <p className="post-error" role="alert">
              {t('posts', errorKey(shownError))}
            </p>
          )}
          <div className="post-actions">
            <a href="#comments">{count === 1 ? t('posts', 'comments.one') : t('posts', 'comments.other', { count })}</a>
            {isAuthor && !post.removed && (
              <div className="post-own" role="group" aria-label={t('posts', 'action.you')}>
                {!post.deleted && <a href={`/submit?edit=${post.id}`}>{t('posts', 'action.edit')}</a>}
                {post.deleted ? (
                  <ActionForm action={back} intent="restore">
                    <Button type="submit">{t('posts', 'action.restore')}</Button>
                  </ActionForm>
                ) : (
                  <ActionForm action={back} intent="delete">
                    <Button type="submit">{t('posts', 'action.delete')}</Button>
                  </ActionForm>
                )}
              </div>
            )}
            {moderator && !post.deleted && (
              <div className="post-mod" role="group" aria-label={t('posts', 'action.mod')}>
                {post.removed ? (
                  <ActionForm action={back} intent="unremove">
                    <p className="post-hint">{t('posts', 'removed.banner')}</p>
                    <Button type="submit">{t('posts', 'action.unremove')}</Button>
                  </ActionForm>
                ) : (
                  <details>
                    <summary>{t('posts', 'action.remove')}</summary>
                    <ActionForm action={back} intent="remove">
                      <label htmlFor="remove-reason">{t('posts', 'action.removeReason')}</label>
                      <textarea id="remove-reason" name="reason" rows={3} maxLength={10000} />
                      <Button type="submit">{t('posts', 'action.removeSubmit')}</Button>
                    </ActionForm>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </article>
      {/* Lane D's thread: sent and mounted only while data.threadVisible (the gate shows the post and no moderator removed it). The div keeps the #comments anchor. */}
      {data.threadVisible && data.thread ? (
        <ThreadSection data={data.thread} />
      ) : (
        <div id="comments" className="post-thread" data-slot="thread" />
      )}
    </main>
  );
}
