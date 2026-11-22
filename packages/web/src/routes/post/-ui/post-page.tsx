import type { ReactNode } from 'react';
import { Badge } from '@peblish/ui/components/badge';
import { Card } from '@peblish/ui/components/card';
import { Group } from '@peblish/ui/components/group';
import { BidiText, Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import { ExternalLinkIcon } from '@peblish/ui/components/icons';
import { Image } from '@peblish/ui/components/image';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Prose } from '@peblish/ui/components/prose';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, postPath, userPath } from '../../../shell/paths.ts';
import { GateNotice, HideNsfwForm } from '../../c/-ui/gate.tsx';
import { castVoteFn } from '../-vote.ts';
import type { PostPageData } from '../-load.ts';
import type { ContentActionProps } from '../../-actions/props.ts';
import { ThreadSection } from '../$id/comments/-ui/thread-section.tsx';
import { PostBlock } from './actions/block.tsx';
import { PostModerate } from './actions/moderate.tsx';
import { PostReport } from './actions/report.tsx';
import { PostSave } from './actions/save.tsx';
import { ActionForm } from './action-form.tsx';
import { asPostError, errorKey } from './errors.ts';
import { FollowBell, FollowSwitch } from './follow-thread.tsx';
import { PostHeader } from './post-header.tsx';
import { GateRail, PostRail } from './post-rail.tsx';
import { PostPills } from './post-pills.tsx';
import { isWithheld } from '../-withheld.ts';

// The post page (Commons' Thread.tsx, PostDetail): its view header, the post (meta line with the exact
// time, title, flags, picture or link, body, the pill row of vote, comments, Share and Copy link, then
// the author's own actions and the action slots: report for REP, block for E1, moderate for MODF, for a
// signed-in viewer), the thread, and the rail. Left out on purpose: lock and pin authoring, save, hide,
// crosspost and post series. Follow thread is the view header's bell and the rail's switch
// (follow-thread.tsx). The NSFW gate replaces the post (GateNotice, from the
// loader's `kind: 'gate'`), and tombstone states withhold their content in core (readPost); this only
// lays out what it was given.

export function PostPage({ data, error }: { data: PostPageData; error?: string | undefined }) {
  useRouteHydrated();
  return data.kind === 'gate' ? (
    <>
      <PostHeader handle={data.handle} />
      <GateNotice data={data} error={error} />
      <GateRail handle={data.handle} />
    </>
  ) : (
    <PostContent data={data} error={error} />
  );
}

/** Where a link post goes: its picture or a box with the domain and the address, which opens it. */
function PostMedia({ data }: { data: Extract<PostPageData, { kind: 'post' }> }) {
  const { t } = useTranslate();
  const { post } = data;
  if (data.image) {
    const picture = (
      <Image src={data.image} alt={neutraliseBidi(post.title)} loading="lazy" radius="md" fit="contain" className="post-image__img" />
    );
    return post.url ? (
      <Link className="post-image" href={post.url} rel="noopener noreferrer nofollow ugc">
        {picture}
      </Link>
    ) : (
      <div className="post-image">{picture}</div>
    );
  }
  if (!post.url) return null;
  return (
    <Link className="post-link" href={post.url} rel="noopener noreferrer nofollow ugc">
      {data.thumbnail && (
        <Image src={data.thumbnail} alt="" loading="lazy" width={64} height={64} radius="sm" className="post-link__thumb" />
      )}
      <span className="post-link__text">
        {/* Someone else's address: isolated and left to right, like a handle's host. */}
        <Text size="sm" variant="label" className="post-link__domain">
          <bdi dir="ltr">{data.domain ? neutraliseBidi(data.domain) : t('posts', 'link.open')}</bdi>
        </Text>
        <Text size="xs" color="muted" className="post-link__url">
          <bdi dir="ltr">{neutraliseBidi(post.url.replace(/^https?:\/\//, ''))}</bdi>
        </Text>
      </span>
      <ExternalLinkIcon className="post-link__icon" />
    </Link>
  );
}

function PostContent({ data, error }: { data: Extract<PostPageData, { kind: 'post' }>; error?: string | undefined }) {
  const { t, locale } = useTranslate();
  const { post, moderator, viewerId, viewerAdmin } = data;
  const back = postPath(post.id);
  const isAuthor = viewerId === post.author.id;
  const withheld = post.deleted ? 'deleted' : post.removed && !moderator ? 'removed' : null;
  const count = post.counts.comments;
  const countLabel = count === 1 ? t('posts', 'comments.one') : t('posts', 'comments.other', { count });
  const shownError = asPostError(error);
  // Follow thread for a signed-in reader of a live post; Unfollow stays wherever the thread is followed.
  const followable = viewerId !== null && (post.watching === true || (!post.removed && !post.deleted));
  const badgeLabels = { admin: t('posts', 'badge.admin'), moderator: t('posts', 'badge.moderator'), op: '' };
  // A tombstone's author comes only to staff and the author (-page-data.ts postForViewer).
  const withheldAuthor = isWithheld(post.author);
  // The slots get the post for a signed-in viewer; a removed or deleted post still has them for staff (a
  // moderator restores it). Where its author is withheld, as in the thread, there is no slot at all.
  const actions: ContentActionProps | null =
    viewerId && !withheldAuthor
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
  if (withheld) {
    body = (
      <Card.Root variant="filled" padding="md" className="post-notice" data-state={withheld}>
        <Text as="h1" variant="title" size="md" className="post-notice__title">
          {t('posts', `${withheld}.title`)}
        </Text>
        <Text as="p" color="muted" className="post-notice__body">
          {t('posts', `${withheld}.body`)}
        </Text>
      </Card.Root>
    );
  } else {
    body = (
      <div className="post-content">
        <Text as="h1" variant="heading" size="sm" id="post-title" className="post-title">
          <BidiText text={post.title} />
        </Text>
        {(post.locked || post.featured || post.sensitive || post.nsfl || data.spoiler) && (
          <div className="post-flags">
            {post.featured && <Badge kind="pinned">{t('posts', 'flag.pinned')}</Badge>}
            {post.locked && <Badge kind="locked">{t('posts', 'flag.locked')}</Badge>}
            {post.nsfl ? (
              <Badge kind="nsfl">{t('posts', 'flag.nsfl')}</Badge>
            ) : (
              post.sensitive && <Badge kind="nsfw">{t('posts', 'flag.sensitive')}</Badge>
            )}
            {data.spoiler && <Badge tone="warning">{t('posts', 'flag.spoiler')}</Badge>}
            {(post.sensitive || post.nsfl) && viewerId && <HideNsfwForm handle={post.community.handle} back={back} />}
          </div>
        )}
        <PostMedia data={data} />
        {/* The HTML comes from the Markdown renderer or the sanitiser (-load.ts), never from anywhere else. */}
        {post.contentHtml && <Prose className="post-text" html={post.contentHtml} />}
      </div>
    );
  }

  return (
    <>
      <PostHeader
        handle={post.community.handle}
        trailing={followable && <FollowBell postId={post.id} watching={post.watching === true} />}
      />
      {/* Keyed by the post: the router reuses this component when a link goes from one post to another, and
          the vote control's optimistic vote and queue, the thread's and the forms' state belong to one post. */}
      <main key={post.id} className="pb-page post-page" data-state={withheld ?? 'visible'}>
        <article className="post" aria-labelledby={withheld ? undefined : 'post-title'}>
          <Text as="div" size="sm" color="muted" className="post-meta">
            <Link className="pb-link-quiet post-meta__community" href={communityPath(post.community)}>
              <Handle prefix="!" handle={post.community.handle} />
            </Link>
            <Text aria-hidden="true">·</Text>
            {!withheldAuthor && (
              <>
                <span className="post-meta__by">
                  <Link className="pb-link-muted" href={userPath(post.author)}>
                    <Handle prefix="@" handle={post.author.handle} />
                  </Link>
                  {post.authorBadge && <Badge kind={post.authorBadge} labels={badgeLabels} />}
                </span>
                <Text aria-hidden="true">·</Text>
              </>
            )}
            {/* The exact time, in full: a reader of a thread needs it, and a title is out of reach of touch and keys. */}
            <Time iso={post.publishedAt} locale={locale} format="date-time" />
            {data.edited && (
              <>
                <Text aria-hidden="true">·</Text>
                <Text size="sm" color="muted">
                  {t('posts', 'meta.edited', { date: data.edited })}
                </Text>
              </>
            )}
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
          <PostPills
            post={post}
            // A refusal throws, which puts the arrows and the score back.
            onVote={async (value) => {
              const result = await castVoteFn({ data: { target: { kind: 'post', id: post.id }, value } });
              if (!result.ok) throw new Error(result.reason);
            }}
            voteDisabled={viewerId === null || withheld !== null}
            share={!withheld}
          />
          {((isAuthor && !post.removed) || actions) && (
            <div className="post-manage">
              {isAuthor && !post.removed && (
                <Group className="post-own" aria-label={t('posts', 'action.you')}>
                  {!post.deleted && <Link href={`/submit?edit=${post.id}`}>{t('posts', 'action.edit')}</Link>}
                  {post.deleted ? (
                    <ActionForm action={back} intent="restore" label={t('posts', 'action.restore')} />
                  ) : (
                    <ActionForm action={back} intent="delete" label={t('posts', 'action.delete')} />
                  )}
                </Group>
              )}
              {actions && (
                <>
                  <PostSave post={post} withheld={withheld !== null} back={back} />
                  <PostReport {...actions} />
                  <PostBlock {...actions} />
                  <PostModerate {...actions} />
                </>
              )}
            </div>
          )}
        </article>
        {/* Lane D's thread: sent and mounted only while data.threadVisible (the gate shows the post and no moderator removed it). The div keeps the #comments anchor. */}
        {data.threadVisible && data.thread ? (
          <ThreadSection data={data.thread} heading={countLabel} />
        ) : (
          <div id="comments" className="post-thread" data-slot="thread" />
        )}
      </main>
      <PostRail
        post={post}
        withheld={withheld !== null}
        facts={data.facts}
        follow={followable && <FollowSwitch postId={post.id} watching={post.watching === true} />}
      />
    </>
  );
}
