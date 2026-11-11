import type { ReactNode } from 'react';
import { Badge } from '@peblish/ui/components/badge';
import { Card } from '@peblish/ui/components/card';
import { Group } from '@peblish/ui/components/group';
import { Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import { Image } from '@peblish/ui/components/image';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { VoteControl } from '@peblish/ui/components/vote-control';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { useVoteLabels } from '../../../shell/labels.ts';
import { GateNotice, HideNsfwForm } from '../../c/-ui/gate.tsx';
import { castVoteFn } from '../-vote.ts';
import type { PostPageData } from '../-load.ts';
import type { ContentActionProps } from '../../-actions/props.ts';
import { ThreadSection } from '../$id/comments/-ui/thread-section.tsx';
import { PostBlock } from './actions/block.tsx';
import { PostModerate } from './actions/moderate.tsx';
import { PostReport } from './actions/report.tsx';
import { ActionForm } from './action-form.tsx';
import { asPostError, errorKey } from './errors.ts';

// The post page after thread-nested.html's post part: vote column, title and link, community
// and author, body, the author's own actions, and the action slots (./actions/: report for REP,
// block for E1, moderate for MODF) for a signed-in viewer. Left out on purpose: lock and pin
// authoring, save, crosspost and share. The NSFW gate replaces the whole page (GateNotice, from
// the loader's `kind: 'gate'`), and tombstone states withhold their content in core (readPost);
// this only lays out what it was given.

export function PostPage({ data, error }: { data: PostPageData; error?: string | undefined }) {
  useRouteHydrated();
  return data.kind === 'gate' ? <GateNotice data={data} error={error} /> : <PostContent data={data} error={error} />;
}

function PostContent({ data, error }: { data: Extract<PostPageData, { kind: 'post' }>; error?: string | undefined }) {
  const { t, locale } = useTranslate();
  const { post, moderator, viewerId, viewerAdmin } = data;
  const back = `/post/${post.id}`;
  const isAuthor = viewerId === post.author.id;
  const withheld = post.deleted ? 'deleted' : post.removed && !moderator ? 'removed' : null;
  const count = post.counts.comments;
  const shownError = asPostError(error);
  const voteLabels = useVoteLabels();
  const badgeLabels = { admin: t('posts', 'badge.admin'), moderator: t('posts', 'badge.moderator'), op: '' };
  // The slots get the post for a signed-in viewer; a removed or deleted post still has them (a moderator restores it).
  const actions: ContentActionProps | null = viewerId
    ? {
        target: { kind: 'post', id: post.id },
        author: post.author,
        community: post.community,
        removed: post.removed,
        deleted: post.deleted,
        viewer: { actorId: viewerId, moderator, admin: viewerAdmin },
        back,
      }
    : null;

  let body: ReactNode;
  if (post.deleted || (post.removed && !moderator)) {
    const state = post.deleted ? 'deleted' : 'removed';
    body = (
      <Card.Root variant="filled" padding="md" className="post-notice" data-state={state}>
        <Text as="h1" variant="title" size="md" className="post-notice__title">
          {t('posts', `${state}.title`)}
        </Text>
        <Text as="p" color="muted" className="post-notice__body">
          {t('posts', `${state}.body`)}
        </Text>
      </Card.Root>
    );
  } else {
    body = (
      <div className="post-content">
        <Text as="h1" variant="heading" size="sm" id="post-title" className="post-title">
          {post.title}
        </Text>
        {(post.locked || post.featured || post.sensitive || post.nsfl) && (
          <div className="post-flags">
            {post.locked && <Badge kind="locked">{t('posts', 'flag.locked')}</Badge>}
            {post.featured && <Badge kind="pinned">{t('posts', 'flag.pinned')}</Badge>}
            {post.nsfl ? (
              <Badge kind="nsfl">{t('posts', 'flag.nsfl')}</Badge>
            ) : (
              post.sensitive && <Badge kind="nsfw">{t('posts', 'flag.sensitive')}</Badge>
            )}
            {(post.sensitive || post.nsfl) && viewerId && <HideNsfwForm handle={post.community.handle} back={back} />}
          </div>
        )}
        {data.image ? (
          post.url ? (
            <Link className="post-image" href={post.url} rel="noopener noreferrer nofollow ugc">
              <Image
                src={data.image}
                alt={neutraliseBidi(post.title)}
                loading="lazy"
                radius="md"
                fit="contain"
                className="post-image__img"
              />
            </Link>
          ) : (
            <div className="post-image">
              <Image
                src={data.image}
                alt={neutraliseBidi(post.title)}
                loading="lazy"
                radius="md"
                fit="contain"
                className="post-image__img"
              />
            </div>
          )
        ) : (
          post.url && (
            <Card.Root variant="outlined" padding="sm" className="post-link-card">
              <Link className="post-link" href={post.url} rel="noopener noreferrer nofollow ugc">
                {data.thumbnail && (
                  <Image src={data.thumbnail} alt="" loading="lazy" width={64} height={64} radius="sm" className="post-link__thumb" />
                )}
                <Text as="span">{data.domain ?? t('posts', 'link.open')}</Text>
              </Link>
            </Card.Root>
          )
        )}
        {/* The HTML comes from the Markdown renderer or the sanitiser (-load.ts), never from anywhere else. */}
        {post.contentHtml && <Prose className="post-text" html={post.contentHtml} />}
      </div>
    );
  }

  return (
    // Keyed by the post: the router reuses this component when a link goes from one post to another, and
    // the vote control's optimistic vote and queue, the thread's and the forms' state belong to one post.
    <main key={post.id} className="post-page" data-state={withheld ?? 'visible'}>
      <Card.Root variant="outlined" padding="lg" className="post-card">
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
            <Text as="p" size="sm" color="muted" className="post-meta">
              <Link href={`/c/${post.community.handle}`}>
                <Handle prefix="!" handle={post.community.handle} />
              </Link>{' '}
              {t('posts', 'meta.by')}{' '}
              <Link className="pb-link-muted" href={`/u/${post.author.handle}`}>
                <Handle prefix="@" handle={post.author.handle} />
              </Link>
              {post.authorBadge && (
                <>
                  {' '}
                  <Badge kind={post.authorBadge} labels={badgeLabels} />
                </>
              )}{' '}
              · <Time iso={post.publishedAt} locale={locale} format="date" />
              {data.edited && <> · {t('posts', 'meta.edited', { date: data.edited })}</>}
            </Text>
            {body}
            {shownError && (
              <Notice tone="danger" role="alert" className="post-error">
                {t('posts', errorKey(shownError))}
              </Notice>
            )}
            {moderator && post.removed && !post.deleted && (
              <Notice tone="warning" className="post-hint">
                {t('posts', 'removed.banner')}
              </Notice>
            )}
            <div className="post-actions">
              <Link className="pb-link-quiet" href="#comments">
                {count === 1 ? t('posts', 'comments.one') : t('posts', 'comments.other', { count })}
              </Link>
              {isAuthor && !post.removed && (
                <Group className="post-own" aria-label={t('posts', 'action.you')}>
                  {!post.deleted && (
                    <Link className="pb-link-quiet" href={`/submit?edit=${post.id}`}>
                      {t('posts', 'action.edit')}
                    </Link>
                  )}
                  {post.deleted ? (
                    <ActionForm action={back} intent="restore" label={t('posts', 'action.restore')} />
                  ) : (
                    <ActionForm action={back} intent="delete" label={t('posts', 'action.delete')} />
                  )}
                </Group>
              )}
              {actions && (
                <>
                  <PostReport {...actions} />
                  <PostBlock {...actions} />
                  <PostModerate {...actions} />
                </>
              )}
            </div>
          </div>
        </article>
      </Card.Root>
      {/* Lane D's thread: sent and mounted only while data.threadVisible (the gate shows the post and no moderator removed it). The div keeps the #comments anchor. */}
      {data.threadVisible && data.thread ? (
        <ThreadSection data={data.thread} />
      ) : (
        <div id="comments" className="post-thread" data-slot="thread" />
      )}
    </main>
  );
}
