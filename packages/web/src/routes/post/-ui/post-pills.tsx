import type { PostView } from '@peblish/schema/views';
import { CommentsIcon } from '@peblish/ui/components/icons';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { VoteControl, type Vote } from '@peblish/ui/components/vote-control';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useVoteLabels } from '../../../shell/labels.ts';
import { postPath } from '../../../shell/paths.ts';
import { PostShare } from './share.tsx';

/**
 * The post's pill row (Commons' PostActions): the vote on its pill, the comments count (a link to the
 * thread, named by its count), and Share and Copy link while the post is shown.
 */
export function PostPills({
  post,
  onVote,
  voteDisabled,
  share,
}: {
  post: PostView;
  onVote?: (value: Vote) => void | Promise<void>;
  voteDisabled: boolean;
  /** Share and Copy link: not for a withheld post. */
  share: boolean;
}) {
  const { t, locale } = useTranslate();
  const voteLabels = useVoteLabels();
  const count = post.counts.comments;
  return (
    <div className="post-actions">
      <VoteControl
        variant="pill"
        orientation="horizontal"
        score={post.counts.upvotes - post.counts.downvotes}
        myVote={post.myVote}
        onVote={onVote}
        disabled={voteDisabled}
        labels={{ ...voteLabels, group: t('posts', 'vote.group') }}
        locale={locale}
      />
      <Link
        className="post-pill post-pill--count pb-link-quiet"
        href="#comments"
        aria-label={count === 1 ? t('posts', 'comments.one') : t('posts', 'comments.other', { count })}
      >
        <CommentsIcon />
        <Text className="post-pill__count">{new Intl.NumberFormat(locale).format(count)}</Text>
      </Link>
      {share && <PostShare path={postPath(post.id)} title={post.title} />}
    </div>
  );
}
