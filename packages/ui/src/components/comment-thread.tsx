import type { CommentView } from '@peblish/schema/views';
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, type BadgeLabels } from './badge.tsx';
import { Button } from './button.tsx';
import { buildCommentTree, type CommentNode } from './comment-tree.ts';
import { Handle } from './handle.tsx';
import { IconButton } from './icon-button.tsx';
import { ChevronDown, ChevronRight } from './icons.tsx';
import { Link } from './link.tsx';
import { Prose } from './prose.tsx';
import { Text } from './text.tsx';
import { Time } from './time.tsx';
import { VoteControl, type Vote, type VoteControlLabels } from './vote-control.tsx';

export interface CommentThreadLabels {
  vote: VoteControlLabels;
  badges: BadgeLabels;
  /** The thread's name for assistive technology: "Comments". */
  section: string;
  /** The fold button's name: "Collapse comment" or "Collapse comment and 14 replies". */
  collapse: (replies: number) => string;
  expand: (replies: number) => string;
  /** "14 replies hidden." on a folded comment (not called with 0). */
  hiddenReplies: (replies: number) => string;
  /** "Collapsed, score -9 is below -5." on a comment folded for its low score. */
  lowScore: (score: number, threshold: number) => string;
  show: string;
  continueThread: string;
  /** "5 more replies" beside the continue link. */
  moreReplies: (replies: number) => string;
  removed: string;
  deleted: string;
  /** The note in place of a comment by someone the viewer blocks: "Hidden: you blocked this person." */
  blocked: string;
  edited: string;
  reply: string;
  share: string;
}

export interface CommentThreadProps {
  /** A flat list in display order (core's read model); `parentId` and `depth` place each comment. */
  comments: readonly CommentView[];
  /** The post's author, to mark their comments OP. */
  postAuthorId: string;
  /** Where "Continue this thread" leads for a comment: its permalink page. Null for a comment that has none to offer (the one a permalink page starts from, whose replies the page pages itself). */
  continueHref: (comment: CommentView) => string | null;
  authorHref: (comment: CommentView) => string;
  labels: CommentThreadLabels;
  locale: string;
  onVote?: (comment: CommentView, value: Vote) => void | Promise<void>;
  /** The viewer cannot vote (signed out). */
  voteDisabled?: boolean;
  /** Shows a reply action when given. */
  onReply?: (comment: CommentView) => void;
  onShare?: (comment: CommentView) => void;
  /** More actions after the built-in ones, per comment: the page's report, block and moderate slots. */
  renderActions?: (comment: CommentView) => ReactNode;
  /** Levels drawn before the thread continues on its own page. */
  maxDepth?: number;
  /** A comment scoring below this starts folded. */
  lowScoreThreshold?: number;
  now?: Date;
}

const scoreOf = (comment: CommentView) => comment.counts.upvotes - comment.counts.downvotes;

/** Replies the list does not hold under a comment, at any depth. */
const missingBelow = ({ comment, descendants }: CommentNode) => Math.max(0, comment.counts.comments - descendants);

/**
 * Replies the list does not hold that hang from this comment itself rather than from a reply
 * the list does hold (which says so for its own): the ones the server cut from its children,
 * so a branch the list only partly holds still shows where to continue.
 */
export const unloadedReplies = (node: CommentNode) =>
  Math.max(0, missingBelow(node) - node.children.reduce((sum, child) => sum + missingBelow(child), 0));

/** What every row of one thread shares. One object, rebuilt only when one of these changes, so a row's memo holds. */
interface RowContext {
  postAuthorId: string;
  continueHref: CommentThreadProps['continueHref'];
  authorHref: CommentThreadProps['authorHref'];
  labels: CommentThreadLabels;
  locale: string;
  voteDisabled: boolean | undefined;
  renderActions: CommentThreadProps['renderActions'];
  maxDepth: number;
  lowScoreThreshold: number;
  now: Date | undefined;
  /** Which event callbacks the page gave; the rows call the latest ones through `events`. */
  canVote: boolean;
  canReply: boolean;
  canShare: boolean;
  events: { readonly current: Pick<CommentThreadProps, 'onVote' | 'onReply' | 'onShare'> };
  /** What the viewer toggled, by comment id, over the default (folded when the score is low). It outlives a row that a folded ancestor unmounts. */
  folds: Map<string, boolean>;
}

/**
 * One comment and its replies. Memoised, with its fold state its own: folding a comment
 * re-renders that row alone (its replies unmount), and a re-render of the page above, such as
 * choosing which comment to answer, re-renders no row.
 */
const CommentRow = memo(function CommentRow({ node, level, ctx }: { node: CommentNode; level: number; ctx: RowContext }) {
  const { comment } = node;
  const { labels } = ctx;
  const [toggled, setToggled] = useState(() => ctx.folds.get(comment.id));
  const lowScore = scoreOf(comment) < ctx.lowScoreThreshold;
  const isFolded = toggled ?? lowScore;
  const toggle = () => {
    ctx.folds.set(comment.id, !isFolded);
    setToggled(!isFolded);
  };
  const gone = comment.removed || comment.deleted;
  // A comment by someone the viewer blocks keeps its place and its author line, without its text or the vote and reply.
  const blocked = !gone && comment.blocked === true;
  const quiet = gone || blocked;
  // Both flags show one label, removed.
  const tombstone = comment.removed ? labels.removed : comment.deleted ? labels.deleted : labels.blocked;
  const replies = node.descendants;
  // Past our own cap the replies the list holds are not drawn; above it, only the ones it leaves out count.
  const capped = level >= ctx.maxDepth - 1;
  const more = capped ? replies + missingBelow(node) : unloadedReplies(node);
  const href = more > 0 ? ctx.continueHref(comment) : null;
  // Replies drawn under this comment: the thread line beside them is the fold button's target too.
  const lined = !isFolded && !capped && node.children.length > 0;

  return (
    <li className="pb-comment" id={`comment-${comment.id}`} data-folded={isFolded || undefined} data-lined={lined || undefined}>
      <div className="pb-comment__head">
        <IconButton
          size="sm"
          className="pb-comment__fold"
          aria-expanded={!isFolded}
          aria-label={isFolded ? labels.expand(replies) : labels.collapse(replies)}
          onActivate={toggle}
        >
          {isFolded ? <ChevronRight /> : <ChevronDown />}
        </IconButton>
        {comment.deleted ? (
          // A deleted comment's author stays out of the page, removed as well or not.
          <Text size="sm" color="muted">
            {tombstone}
          </Text>
        ) : (
          <>
            <Link className="pb-comment__author pb-link-quiet" href={ctx.authorHref(comment)}>
              <Handle prefix="@" handle={comment.author.handle} />
            </Link>
            {comment.author.id === ctx.postAuthorId && <Badge kind="op" labels={labels.badges} />}
            {comment.authorBadge && <Badge kind={comment.authorBadge} labels={labels.badges} />}
          </>
        )}
        <Text size="sm" color="muted">
          · <Time iso={comment.publishedAt} locale={ctx.locale} now={ctx.now} />
          {comment.editedAt && ` · ${labels.edited}`}
        </Text>
      </div>
      {isFolded ? (
        <div className="pb-comment__stub">
          <Text size="sm" color="muted">
            {lowScore && `${labels.lowScore(scoreOf(comment), ctx.lowScoreThreshold)} `}
            {replies > 0 && labels.hiddenReplies(replies)}
          </Text>
          <Button variant="ghost" size="sm" onActivate={toggle}>
            {labels.show}
          </Button>
        </div>
      ) : (
        <div className="pb-comment__main">
          {quiet || comment.contentHtml === null ? (
            <Text as="p" color="muted" className="pb-comment__note">
              {tombstone}
            </Text>
          ) : (
            <Prose html={comment.contentHtml} className="pb-comment__text" />
          )}
          <div className="pb-comment__actions">
            {!quiet && (
              <VoteControl
                orientation="horizontal"
                score={scoreOf(comment)}
                myVote={comment.myVote}
                onVote={ctx.canVote ? (value) => ctx.events.current.onVote?.(comment, value) : undefined}
                disabled={ctx.voteDisabled}
                labels={labels.vote}
                locale={ctx.locale}
              />
            )}
            {ctx.canReply && !quiet && (
              <Button variant="ghost" size="sm" onActivate={() => ctx.events.current.onReply?.(comment)}>
                {labels.reply}
              </Button>
            )}
            {ctx.canShare && (
              <Button variant="ghost" size="sm" onActivate={() => ctx.events.current.onShare?.(comment)}>
                {labels.share}
              </Button>
            )}
            {ctx.renderActions?.(comment)}
          </div>
          {lined && (
            <div className="pb-comment__kids">
              <ul className="pb-comment__list">
                {node.children.map((child) => (
                  <CommentRow key={child.comment.id} node={child} level={level + 1} ctx={ctx} />
                ))}
              </ul>
            </div>
          )}
          {href && (
            <div className="pb-comment__kids pb-comment__more">
              <Link className="pb-comment__continue" href={href}>
                {labels.continueThread}
                <ChevronRight />
              </Link>{' '}
              <Text size="sm" color="muted">
                {labels.moreReplies(more)}
              </Text>
            </div>
          )}
        </div>
      )}
    </li>
  );
});

/**
 * The comment tree (thread-nested), from Mux UI parts: indented levels with a thread line drawn
 * in Mux border tokens, a fold IconButton per comment (whose target runs down that line, so a
 * click on the line folds: comment-thread.css), low-score comments folded, removed and deleted comments as a note (one
 * label for a comment that is both: removed), a comment by someone the viewer blocks as a note
 * under its author line (its replies stay), and a "Continue this thread" link wherever the
 * list leaves replies out, because the depth cap cuts the branch or the server cut a branch it
 * only partly sent. It fetches nothing: the page passes the list and the callbacks.
 *
 * Pass `now` (the server's clock, sent with the data) so the server and the browser print the
 * same ages. Each comment is a memoised row. The event callbacks (onVote, onReply, onShare) may change
 * identity freely; the functions called while rendering (continueHref, authorHref,
 * renderActions, the labels) re-render every row when their identity changes, so a page keeps them stable.
 */
export const CommentThread = memo(function CommentThread({
  comments,
  postAuthorId,
  continueHref,
  authorHref,
  labels,
  locale,
  onVote,
  voteDisabled,
  onReply,
  onShare,
  renderActions,
  maxDepth = 6,
  lowScoreThreshold = -5,
  now,
}: CommentThreadProps) {
  const roots = useMemo(() => buildCommentTree(comments), [comments]);
  const [folds] = useState(() => new Map<string, boolean>());
  const events = useRef({ onVote, onReply, onShare });
  useLayoutEffect(() => {
    events.current = { onVote, onReply, onShare };
  });
  const [canVote, canReply, canShare] = [Boolean(onVote), Boolean(onReply), Boolean(onShare)];
  const ctx = useMemo<RowContext>(
    () => ({
      postAuthorId,
      continueHref,
      authorHref,
      labels,
      locale,
      voteDisabled,
      renderActions,
      maxDepth,
      lowScoreThreshold,
      now,
      canVote,
      canReply,
      canShare,
      events,
      folds,
    }),
    [
      postAuthorId,
      continueHref,
      authorHref,
      labels,
      locale,
      voteDisabled,
      renderActions,
      maxDepth,
      lowScoreThreshold,
      now,
      canVote,
      canReply,
      canShare,
      folds,
    ],
  );

  return (
    <div className="pb-thread">
      <ul className="pb-comment__list" aria-label={labels.section}>
        {roots.map((root) => (
          <CommentRow key={root.comment.id} node={root} level={0} ctx={ctx} />
        ))}
      </ul>
    </div>
  );
});
