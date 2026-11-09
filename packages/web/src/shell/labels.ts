import type { BadgeLabels } from '@peblish/ui/components/badge';
import type { CommentThreadLabels } from '@peblish/ui/components/comment-thread';
import type { PostCardLabels } from '@peblish/ui/components/post-card';
import type { ReplyBarLabels } from '@peblish/ui/components/reply-bar';
import type { VoteControlLabels } from '@peblish/ui/components/vote-control';
import type { DensityControlLabels } from '@peblish/ui/density/density-control';
import { useTranslate } from '../i18n/use-translate.ts';
import { translatePlural } from '../i18n/translate.ts';

// The strings @peblish/ui components take as props, built from the `ui` catalogue in the
// request's locale. A page passes `labels` straight through:
//   const labels = usePostCardLabels(); <PostCard labels={labels} locale={locale} ... />

export function useVoteLabels(): VoteControlLabels {
  const { t } = useTranslate();
  return { group: t('ui', 'vote.group'), up: t('ui', 'vote.up'), down: t('ui', 'vote.down') };
}

function useBadgeLabels(): BadgeLabels {
  const { t } = useTranslate();
  return { admin: t('ui', 'badge.admin'), moderator: t('ui', 'badge.moderator'), op: t('ui', 'badge.op') };
}

export function usePostCardLabels(): PostCardLabels {
  const { locale, t } = useTranslate();
  return {
    vote: useVoteLabels(),
    badges: useBadgeLabels(),
    pinned: t('ui', 'post.pinned'),
    locked: t('ui', 'post.locked'),
    nsfw: t('ui', 'post.nsfw'),
    nsfl: t('ui', 'post.nsfl'),
    removed: t('ui', 'post.removed'),
    deleted: t('ui', 'post.deleted'),
    comments: (count) => translatePlural(locale, 'ui', 'post.comments', count),
    share: t('ui', 'post.share'),
    show: t('ui', 'post.show'),
    hide: t('ui', 'post.hide'),
    by: t('ui', 'post.by'),
    text: t('ui', 'post.kind.text'),
    link: t('ui', 'post.kind.link'),
    image: t('ui', 'post.kind.image'),
  };
}

export function useCommentThreadLabels(): CommentThreadLabels {
  const { locale, t } = useTranslate();
  return {
    vote: useVoteLabels(),
    badges: useBadgeLabels(),
    section: t('ui', 'thread.section'),
    collapse: (replies) => (replies === 0 ? t('ui', 'thread.collapse') : translatePlural(locale, 'ui', 'thread.collapseReplies', replies)),
    expand: (replies) => (replies === 0 ? t('ui', 'thread.expand') : translatePlural(locale, 'ui', 'thread.expandReplies', replies)),
    hiddenReplies: (replies) => translatePlural(locale, 'ui', 'thread.hidden', replies),
    lowScore: (score, threshold) => t('ui', 'thread.lowScore', { score, threshold }),
    show: t('ui', 'thread.show'),
    continueThread: t('ui', 'thread.continue'),
    moreReplies: (replies) => translatePlural(locale, 'ui', 'thread.more', replies),
    removed: t('ui', 'thread.removed'),
    deleted: t('ui', 'thread.deleted'),
    edited: t('ui', 'thread.edited'),
    reply: t('ui', 'thread.reply'),
    share: t('ui', 'thread.share'),
  };
}

export function useReplyBarLabels(): ReplyBarLabels {
  const { t } = useTranslate();
  return {
    region: t('ui', 'reply.region'),
    field: t('ui', 'reply.field'),
    placeholder: t('ui', 'reply.placeholder'),
    submit: t('ui', 'reply.submit'),
    replyingTo: t('ui', 'reply.replyingTo'),
    postInstead: t('ui', 'reply.postInstead'),
    cancel: t('ui', 'reply.cancel'),
  };
}

export function useDensityLabels(): DensityControlLabels {
  const { t } = useTranslate();
  return {
    group: t('ui', 'density.group'),
    card: t('ui', 'density.card'),
    classic: t('ui', 'density.classic'),
    compact: t('ui', 'density.compact'),
  };
}
