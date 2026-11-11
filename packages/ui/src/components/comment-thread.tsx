import type { CommentView } from '@peblish/schema/views';
import { useMemo, useState, type ReactNode } from 'react';
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
  /** Each comment's age and full date as text, formatted by the server so hydration formats nothing; a comment without one prints its age from the clock. */
  times?: ReadonlyMap<string, { age: string; title: string }>;
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

/**
 * The comment tree (thread-nested), from Mux UI parts: indented levels with a clickable
 * thread line drawn in Mux border tokens, a fold IconButton per comment, low-score comments folded, removed and deleted comments as a note (one
 * label for a comment that is both: removed), a comment by someone the viewer blocks as a note
 * under its author line (its replies stay), and a "Continue this thread" link wherever the
 * list leaves replies out, because the depth cap cuts the branch or the server cut a branch it
 * only partly sent. It fetches nothing: the page passes the list and the callbacks.
 */
export function CommentThread({
  comments,
  postAuthorId,
  continueHref,
  authorHref,
  labels,
  locale,
  times,
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
  // What the viewer toggled, over the default (folded when the score is low).
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const folded = (comment: CommentView) => toggled.get(comment.id) ?? scoreOf(comment) < lowScoreThreshold;
  const toggle = (comment: CommentView) => setToggled(new Map(toggled).set(comment.id, !folded(comment)));

  function renderNode(node: CommentNode, level: number): ReactNode {
    const { comment } = node;
    const isFolded = folded(comment);
    const gone = comment.removed || comment.deleted;
    // A comment by someone the viewer blocks keeps its place and its author line, without its text or the vote and reply.
    const blocked = !gone && comment.blocked === true;
    const quiet = gone || blocked;
    // Both flags show one label, removed.
    const tombstone = comment.removed ? labels.removed : comment.deleted ? labels.deleted : labels.blocked;
    const replies = node.descendants;
    const lowScore = scoreOf(comment) < lowScoreThreshold;
    // Past our own cap the replies the list holds are not drawn; above it, only the ones it leaves out count.
    const capped = level >= maxDepth - 1;
    const more = capped ? replies + missingBelow(node) : unloadedReplies(node);
    const href = more > 0 ? continueHref(comment) : null;
    const stamp = times?.get(comment.id);

    return (
      <li key={comment.id} className="pb-comment" id={`comment-${comment.id}`} data-folded={isFolded || undefined}>
        <div className="pb-comment__head">
          <IconButton
            size="sm"
            className="pb-comment__fold"
            aria-expanded={!isFolded}
            aria-label={isFolded ? labels.expand(replies) : labels.collapse(replies)}
            onActivate={() => toggle(comment)}
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
              <Link className="pb-comment__author" href={authorHref(comment)}>
                <Handle prefix="@" handle={comment.author.handle} />
              </Link>
              {comment.author.id === postAuthorId && <Badge kind="op" labels={labels.badges} />}
              {comment.authorBadge && <Badge kind={comment.authorBadge} labels={labels.badges} />}
            </>
          )}
          <Text size="sm" color="muted">
            ·{' '}
            {stamp ? (
              <time dateTime={comment.publishedAt} title={stamp.title}>
                {stamp.age}
              </time>
            ) : (
              <Time iso={comment.publishedAt} locale={locale} now={now} />
            )}
            {comment.editedAt && ` · ${labels.edited}`}
          </Text>
        </div>
        {isFolded ? (
          <div className="pb-comment__stub">
            <Text size="sm" color="muted">
              {lowScore && `${labels.lowScore(scoreOf(comment), lowScoreThreshold)} `}
              {replies > 0 && labels.hiddenReplies(replies)}
            </Text>
            <Button variant="ghost" size="sm" onActivate={() => toggle(comment)}>
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
                  onVote={onVote && ((value) => onVote(comment, value))}
                  disabled={voteDisabled}
                  labels={labels.vote}
                  locale={locale}
                />
              )}
              {onReply && !quiet && (
                <Button variant="ghost" size="sm" onActivate={() => onReply(comment)}>
                  {labels.reply}
                </Button>
              )}
              {onShare && (
                <Button variant="ghost" size="sm" onActivate={() => onShare(comment)}>
                  {labels.share}
                </Button>
              )}
              {renderActions?.(comment)}
            </div>
            {!capped && node.children.length > 0 && (
              <div className="pb-comment__kids">
                {/* A wide target on the thread line for a mouse; the fold button above is the control for everyone else. */}
                <span className="pb-comment__line" aria-hidden="true" onClick={() => toggle(comment)} />
                <ul className="pb-comment__list">{node.children.map((child) => renderNode(child, level + 1))}</ul>
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
  }

  return (
    <div className="pb-thread">
      <ul className="pb-comment__list" aria-label={labels.section}>
        {roots.map((root) => renderNode(root, 0))}
      </ul>
    </div>
  );
}
