import type { ActorRef, CommentView } from '@peblish/schema/views';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Badge, type BadgeLabels } from './badge.tsx';
import { Button } from './button.tsx';
import { useFold, setFold } from './comment-folds.ts';
import { buildCommentTree, type CommentNode } from './comment-tree.ts';
import { Handle } from './handle.tsx';
import { IconButton } from './icon-button.tsx';
import { ChevronDown, ChevronRight, CommentsIcon, CornerDownRightIcon, EllipsisIcon, LinkIcon, ShareIcon } from './icons.tsx';
import { Link } from './link.tsx';
import { Menu } from './menu.tsx';
import { Prose } from './prose.tsx';
import { canShareNatively, copyLink, shareLink } from './share-link.ts';
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
  /** Not drawn by the Commons tree, whose fold button opens a folded comment; kept so existing label sets fit. */
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
  /** The comment menu's Share, where the browser has a share sheet. */
  share: string;
}

/**
 * What the Commons tree adds to the labels. Optional, so a page that only has CommentThreadLabels (the
 * gallery's index) still draws the tree; a part whose label is missing is left out.
 */
export interface CommentTreeLabels extends CommentThreadLabels {
  /** The button that opens a comment's menu: "More actions". */
  more?: string;
  /** The comment menu's name: "Comment actions". */
  menu?: string;
  /** The comment menu's Copy link. */
  copyLink?: string;
  /** Said once a comment's link is on the clipboard: "Link copied." */
  linkCopied?: string;
  /** Said when the browser refused the clipboard, before the link itself: "Copy this link:" */
  copyFailed?: string;
  /** Read before the name a deep reply answers, which the screen shows as an arrow: "in reply to". */
  inReplyTo?: string;
  /** The mark on a comment that arrived since the viewer's last visit (CommentView.isNew): "New". */
  isNew?: string;
}

export interface CommentThreadProps {
  /** A flat list in display order (core's read model); `parentId` and `depth` place each comment. */
  comments: readonly CommentView[];
  /** The post's author, to mark their comments OP; null when the page withholds it (a tombstone's). */
  postAuthorId: string | null;
  /** Where "Continue this thread" leads for a comment: its permalink page. Null for a comment that has none to offer (the one a permalink page starts from, whose replies the page pages itself). */
  continueHref: (comment: CommentView) => string | null;
  authorHref: (comment: CommentView) => string;
  labels: CommentTreeLabels;
  locale: string;
  onVote?: (comment: CommentView, value: Vote) => void | Promise<void>;
  /** The viewer cannot vote (signed out). */
  voteDisabled?: boolean;
  /** Shows a reply action when given. */
  onReply?: (comment: CommentView) => void;
  /** The comment menu's Share, in place of the share sheet `linkOf` opens (shown only where the browser has one). */
  onShare?: (comment: CommentView) => void;
  /**
   * A comment's absolute address on this site (its permalink page). With it, and the `more` and `copyLink`
   * labels, each comment shown has a More actions button for the thread's menu: Copy link, and Share where
   * the browser has a share sheet. What happened shows in the comment's row and is read out politely.
   */
  linkOf?: (comment: CommentView) => string;
  /** More actions after the built-in ones, per comment: the page's report, block and moderate slots. */
  renderActions?: (comment: CommentView) => ReactNode;
  /** The comment a permalink page starts from: it always opens unfolded, whatever its score or an earlier fold. */
  focusId?: string | null;
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

/** A deleted or removed comment: a tombstone, which shows neither its author nor its text. */
const isTombstone = (comment: CommentView) => comment.removed || comment.deleted;

/** The level from which a reply names the comment it answers: on a phone the levels stop stepping in there. */
const namesParentFrom = 3;

type Events = Pick<CommentThreadProps, 'onVote' | 'onReply' | 'onShare' | 'linkOf'>;

/** A short note in one comment's row (what Copy link did), one at a time, which only that row re-renders for. */
interface RowNotes {
  get: (id: string) => string | null;
  /** The link a failed copy shows for copying by hand, with the note. */
  link: (id: string) => string | null;
  subscribe: (listener: () => void) => () => void;
}

function createRowNotes() {
  let current: { id: string; text: string; link: string | null } | null = null;
  const listeners = new Set<() => void>();
  const notes = {
    get: (id: string) => (current?.id === id ? current.text : null),
    link: (id: string) => (current?.id === id ? current.link : null),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: typeof current) => {
      current = next;
      for (const listener of listeners) listener();
    },
  };
  return notes;
}

/** What every row of one thread shares. One object, rebuilt only when one of these changes, so a row's memo holds. */
interface RowContext {
  postAuthorId: string | null;
  continueHref: CommentThreadProps['continueHref'];
  authorHref: CommentThreadProps['authorHref'];
  labels: CommentTreeLabels;
  locale: string;
  voteDisabled: boolean | undefined;
  renderActions: CommentThreadProps['renderActions'];
  focusId: string | null;
  maxDepth: number;
  lowScoreThreshold: number;
  now: Date | undefined;
  /** Which event callbacks the page gave; the rows call the latest ones through `events`. */
  canVote: boolean;
  canReply: boolean;
  /** A comment has a menu (Copy link, Share). */
  hasMenu: boolean;
  events: { readonly current: Events };
  /** Opens the thread's one comment menu for `comment`, beside `opener`, which takes focus back when it closes. */
  openMenu: (comment: CommentView, opener: HTMLElement) => void;
  notes: RowNotes;
}

/** The note a comment's row shows after its Copy link: hidden from assistive technology, which the thread's status tells. */
function RowNote({ id, notes }: { id: string; notes: RowNotes }) {
  const text = useSyncExternalStore(
    notes.subscribe,
    () => notes.get(id),
    () => null,
  );
  const link = useSyncExternalStore(
    notes.subscribe,
    () => notes.link(id),
    () => null,
  );
  if (!text) return null;
  return (
    <Text size="sm" color="muted" className="pb-comment__notice" aria-hidden={link ? undefined : true}>
      {text}
      {link && (
        <>
          {' '}
          <Text size="sm" className="pb-comment__link">
            {link}
          </Text>
        </>
      )}
    </Text>
  );
}

/** The More actions button of one comment, which opens the thread's shared menu beside itself. */
function MoreButton({ comment, ctx }: { comment: CommentView; ctx: RowContext }) {
  const button = useRef<HTMLButtonElement>(null);
  const label = ctx.labels.more;
  if (!label) return null;
  return (
    <IconButton
      ref={button}
      variant="ghost"
      size="sm"
      className="pb-comment__menu"
      aria-label={label}
      aria-haspopup="menu"
      onActivate={() => button.current && ctx.openMenu(comment, button.current)}
    >
      <EllipsisIcon />
    </IconButton>
  );
}

/**
 * One comment and its replies. Memoised, with its fold its own: folding a comment re-renders that row
 * alone (its replies unmount), and a re-render of the page above, such as choosing which comment to
 * answer, re-renders no row. A fold the reader makes is kept for the visit (comment-folds.ts); a low score
 * folds by default.
 */
const CommentRow = memo(function CommentRow({
  node,
  level,
  parentAuthor,
  ctx,
}: {
  node: CommentNode;
  level: number;
  /** Who wrote the comment this one answers, when that comment is shown with its author (not a tombstone). */
  parentAuthor: ActorRef | null;
  ctx: RowContext;
}) {
  const { comment } = node;
  const { labels } = ctx;
  // The comment a permalink starts from keeps its fold to this page, and starts open.
  const focus = comment.id === ctx.focusId;
  const visitFold = useFold(focus ? null : comment.id);
  const [focusFold, setFocusFold] = useState<boolean>();
  const toggled = focus ? focusFold : visitFold;
  const gone = isTombstone(comment);
  // A comment by someone the viewer blocks keeps its place and its author line, without its text or the vote and reply.
  const blocked = !gone && comment.blocked === true;
  const quiet = gone || blocked;
  const lowScore = !quiet && !focus && scoreOf(comment) < ctx.lowScoreThreshold;
  const isFolded = toggled ?? lowScore;
  // Folded for its score and never toggled: drawn all the same and hidden by the stylesheet while scripts
  // run, so a browser without them, whose fold button cannot open it, still reads it.
  const softFolded = isFolded && toggled === undefined;
  const toggle = () => (focus ? setFocusFold(!isFolded) : setFold(comment.id, !isFolded));
  // Both flags show one label, removed.
  const tombstone = comment.removed ? labels.removed : labels.deleted;
  const replies = node.descendants;
  // Past our own cap the replies the list holds are not drawn; above it, only the ones it leaves out count.
  const capped = level >= ctx.maxDepth - 1;
  const more = capped ? replies + missingBelow(node) : unloadedReplies(node);
  const href = more > 0 ? ctx.continueHref(comment) : null;
  const drawn = !isFolded || softFolded;
  const kids = drawn && !capped && node.children.length > 0;
  // Replies drawn under this comment: the thread line beside them is the fold button's target too.
  const lined = kids && !isFolded;
  const answers = level >= namesParentFrom && parentAuthor && labels.inReplyTo ? parentAuthor : null;
  const summary = isFolded
    ? [lowScore && labels.lowScore(scoreOf(comment), ctx.lowScoreThreshold), replies > 0 && labels.hiddenReplies(replies)]
        .filter(Boolean)
        .join(' ')
    : '';

  return (
    <li
      className="pb-comment"
      id={`comment-${comment.id}`}
      data-level={Math.min(level, 9)}
      data-folded={isFolded || undefined}
      data-soft={softFolded || undefined}
      data-lined={lined || undefined}
      data-tombstone={gone || undefined}
      data-focus={focus || undefined}
      data-new={(comment.isNew && !gone) || undefined}
    >
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
        {gone ? (
          // A tombstone keeps its place and its replies, and says what it was: nothing of its author.
          <Text size="sm" color="muted" className="pb-comment__tombstone">
            {tombstone}
          </Text>
        ) : (
          <span className="pb-comment__by">
            <Link className="pb-comment__author pb-link-muted" href={ctx.authorHref(comment)}>
              <Handle prefix="@" handle={comment.author.handle} />
            </Link>
            {comment.author.id === ctx.postAuthorId && <Badge kind="op" labels={labels.badges} />}
            {comment.authorBadge && <Badge kind={comment.authorBadge} labels={labels.badges} />}
          </span>
        )}
        {answers && (
          <Text size="sm" color="muted" className="pb-comment__to">
            <CornerDownRightIcon />
            <Text className="pb-sr">{labels.inReplyTo} </Text>
            <Handle prefix="@" handle={answers.handle} />
          </Text>
        )}
        <Text size="sm" color="muted" className="pb-comment__when">
          <Text aria-hidden="true">· </Text>
          <Time iso={comment.publishedAt} locale={ctx.locale} now={ctx.now} />
          {comment.editedAt && ` · ${labels.edited}`}
        </Text>
        {comment.isNew && !gone && labels.isNew && (
          <Badge tone="success" className="pb-comment__new">
            {labels.isNew}
          </Badge>
        )}
        {summary && (
          <Text size="sm" color="muted" className="pb-comment__summary">
            {summary}
          </Text>
        )}
      </div>
      {drawn && (
        <div className="pb-comment__main">
          {blocked ? (
            <Text as="p" color="muted" className="pb-comment__note">
              {labels.blocked}
            </Text>
          ) : (
            !gone && comment.contentHtml !== null && <Prose html={comment.contentHtml} className="pb-comment__text" />
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
              <Button variant="ghost" size="sm" className="pb-comment__reply" onActivate={() => ctx.events.current.onReply?.(comment)}>
                <CommentsIcon />
                {labels.reply}
              </Button>
            )}
            {ctx.hasMenu && !quiet && <MoreButton comment={comment} ctx={ctx} />}
            {ctx.renderActions?.(comment)}
            {ctx.hasMenu && !quiet && <RowNote id={comment.id} notes={ctx.notes} />}
          </div>
          {kids && (
            <div className="pb-comment__kids">
              <ul className="pb-comment__list">
                {node.children.map((child) => (
                  <CommentRow key={child.comment.id} node={child} level={level + 1} parentAuthor={gone ? null : comment.author} ctx={ctx} />
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
 * The comment tree (Commons), from Mux UI parts: indented levels with a thread line in Mux tokens, a fold
 * IconButton per comment that stays where it is folded or open (its target runs down that line, so a click
 * on the line folds: comment-thread.css), low-score comments folded, removed and deleted comments as a
 * tombstone (their label, never their author or text, one label for a comment that is both: removed), a
 * comment by someone the viewer blocks as a note under its author line (its replies stay), past the third
 * level the name each reply answers, and a "Continue this thread" link wherever the list leaves replies
 * out, because the depth cap cuts the branch or the server cut a branch it only partly sent. Each comment
 * shown has its vote, Reply and a More actions button for the thread's one menu (Copy link, Share). It
 * fetches nothing: the page passes the list and the callbacks.
 *
 * Pass `now` (the server's clock, sent with the data) so the server and the browser print the same ages.
 * Each comment is a memoised row. The event callbacks (onVote, onReply, onShare) and `linkOf` may change
 * identity freely; the functions called while rendering (continueHref, authorHref, renderActions, the
 * labels) re-render every row when their identity changes, so a page keeps them stable.
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
  linkOf,
  renderActions,
  focusId = null,
  maxDepth = 6,
  lowScoreThreshold = -5,
  now,
}: CommentThreadProps) {
  const roots = useMemo(() => buildCommentTree(comments), [comments]);
  const events = useRef<Events>({ onVote, onReply, onShare, linkOf });
  useLayoutEffect(() => {
    events.current = { onVote, onReply, onShare, linkOf };
  });
  const [canVote, canReply] = [Boolean(onVote), Boolean(onReply)];
  const canCopy = Boolean(linkOf && labels.copyLink);
  const canShare = Boolean(onShare || linkOf);
  const hasMenu = Boolean(labels.more) && (canCopy || canShare);
  const [notes] = useState(createRowNotes);
  // What the last Copy link did, read out politely from one place (a row's own note is only seen).
  const [status, setStatus] = useState('');
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clear.current), []);

  // One menu for every comment, opened beside the button pressed; it gives focus back to that button.
  const [menu, setMenu] = useState<{ comment: CommentView; opener: HTMLElement } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const openMenu = useCallback((comment: CommentView, opener: HTMLElement) => {
    anchor.current = opener;
    setMenu({ comment, opener });
  }, []);

  const ctx = useMemo<RowContext>(
    () => ({
      postAuthorId,
      continueHref,
      authorHref,
      labels,
      locale,
      voteDisabled,
      renderActions,
      focusId,
      maxDepth,
      lowScoreThreshold,
      now,
      canVote,
      canReply,
      hasMenu,
      events,
      openMenu,
      notes,
    }),
    [
      postAuthorId,
      continueHref,
      authorHref,
      labels,
      locale,
      voteDisabled,
      renderActions,
      focusId,
      maxDepth,
      lowScoreThreshold,
      now,
      canVote,
      canReply,
      hasMenu,
      openMenu,
      notes,
    ],
  );

  /** Says in the comment's row, and to assistive technology, what Copy link (or a Share that fell back to it) did. */
  const tell = (comment: CommentView, outcome: 'copied' | 'failed', link: string) => {
    const text = outcome === 'copied' ? labels.linkCopied : labels.copyFailed;
    clearTimeout(clear.current);
    if (!text) return;
    notes.set({ id: comment.id, text, link: outcome === 'failed' ? link : null });
    setStatus(outcome === 'copied' ? text : `${text} ${link}`);
    // A copy says so for a moment; a failure keeps the link in view until the next copy.
    if (outcome === 'copied')
      clear.current = setTimeout(() => {
        notes.set(null);
        setStatus('');
      }, 4000);
  };

  const run = async (act: 'copy' | 'share') => {
    if (!menu) return;
    const { comment } = menu;
    const { onShare: share, linkOf: address } = events.current;
    if (act === 'share' && share) return share(comment);
    if (!address) return;
    const link = address(comment);
    const outcome = act === 'copy' ? await copyLink(link) : await shareLink(link);
    if (outcome === 'copied' || outcome === 'failed') tell(comment, outcome, link);
  };

  return (
    <div className="pb-thread">
      <ul className="pb-comment__list" aria-label={labels.section}>
        {roots.map((root) => (
          <CommentRow key={root.comment.id} node={root} level={0} parentAuthor={null} ctx={ctx} />
        ))}
      </ul>
      {/* Mounted only while open, so a thread at rest renders no menu; whether there is a share sheet is the browser's to say. */}
      {hasMenu && menu && (
        <Menu.Root
          open
          onOpenChange={(open) => {
            if (open) return;
            setMenu(null);
            menu.opener.focus({ preventScroll: true });
          }}
        >
          <Menu.Popup anchorRef={anchor} placement="bottom-end">
            <Menu.List aria-label={labels.menu ?? labels.more}>
              {/* The comment's exact date and time at the menu's head: the row shows its age, whose title only a
                  pointer reaches, and the menu is already one stop per comment, by keyboard and by touch. */}
              <Menu.Section title={<Time iso={menu.comment.publishedAt} locale={locale} format="date-time" />}>
                {canCopy && (
                  <Menu.Item id="copy" textValue={labels.copyLink} onAction={() => void run('copy')}>
                    <LinkIcon className="pb-comment__menu-icon" />
                    {labels.copyLink}
                  </Menu.Item>
                )}
                {canShare && canShareNatively() && (
                  <Menu.Item id="share" textValue={labels.share} onAction={() => void run('share')}>
                    <ShareIcon className="pb-comment__menu-icon" />
                    {labels.share}
                  </Menu.Item>
                )}
              </Menu.Section>
            </Menu.List>
          </Menu.Popup>
        </Menu.Root>
      )}
      {hasMenu && (
        <Text role="status" className="pb-sr">
          {status}
        </Text>
      )}
    </div>
  );
});
