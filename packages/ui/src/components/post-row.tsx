import type { PostView } from '@peblish/schema/views';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { Badge, type BadgeLabels } from './badge.tsx';
import { useHydrated } from '../composer/use-hydrated.ts';
import { Button } from './button.tsx';
import { BidiText, Handle, neutraliseBidi } from './handle.tsx';
import { CommentsIcon, ShareIcon } from './icons.tsx';
import { Image } from './image.tsx';
import { Link } from './link.tsx';
import { LinkPreview } from './link-preview.tsx';
import { NsfwCover, type NsfwCoverLabels } from './nsfw-cover.tsx';
import { Text } from './text.tsx';
import { Time } from './time.tsx';
import { VoteControl, type Vote, type VoteControlLabels } from './vote-control.tsx';

export type Density = 'card' | 'classic' | 'compact';

export interface PostRowLabels {
  vote: VoteControlLabels;
  /**
   * The vote group's name for one post, from its title as the row shows it: "Vote on <title>".
   * Without it the group is named "<vote.group>: <title>".
   */
  voteOn?: (title: string) => string;
  badges: BadgeLabels;
  /** Flags in the meta line. */
  pinned: string;
  locked: string;
  nsfw: string;
  nsfl: string;
  /** The title of a removed or deleted post. */
  removed: string;
  deleted: string;
  /** The comments link's name: "148 comments", "1 comment" (it shows the number alone). */
  comments: (count: number) => string;
  share: string;
  /** Covers a sensitive post's media again once it was shown. */
  hide: string;
  cover: NsfwCoverLabels;
}

export interface PostRowHrefs {
  post: string;
  community: string;
  author: string;
}

/** A sensitive post's cover, as the page decides it (the age declaration and the community's gate are the page's). */
export interface PostRowCover {
  /** The viewer may reveal it; otherwise Show is disabled. Default true: today's feeds send only what the viewer may see. */
  eligible?: boolean;
  /** Shown from the start (a remembered "show always"). Without `onRevealedChange` the row keeps its own state from here. */
  revealed?: boolean;
  /** Takes the reveal over: the page sets `revealed` (or asks first). */
  onRevealedChange?: (revealed: boolean) => void;
  /** A reveal is in flight. */
  pending?: boolean;
}

export interface PostRowProps {
  post: PostView;
  density: Density;
  hrefs: PostRowHrefs;
  labels: PostRowLabels;
  locale: string;
  /**
   * Where the thumbnail loads from, resolved by the page with the renderer's `image()` helper
   * (web/src/server/markdown.ts): this instance's own URL, the signed proxy path for a remote
   * image, or null (none, or it must not load). The row never reads `post.thumbnailUrl`, since
   * a raw remote URL would hand the viewer's address to that host.
   */
  thumbnailSrc: string | null;
  /** Called with the viewer's new vote; see VoteControl. Without it the arrows still respond but save nothing. */
  onVote?: (value: Vote) => void | Promise<void>;
  /** The viewer cannot vote on this post. */
  voteDisabled?: boolean;
  /** Shows the share action when given. */
  onShare?: () => void;
  /** More controls at the end of the action row (a row menu, Save). */
  actions?: ReactNode;
  /** Leaves the community out of the meta line, on the community's own page. */
  hideCommunity?: boolean;
  cover?: PostRowCover;
  /** The heading level of the title: 2 under a page's h1 (the default), 3 under an h2. */
  headingLevel?: 2 | 3 | 4;
  /** The clock for ages, so a test or a story can fix it. */
  now?: Date;
}

type Kind = 'text' | 'link' | 'image';

const kindOf = (post: PostView): Kind => (post.url === null ? 'text' : post.urlContentType?.startsWith('image/') ? 'image' : 'link');

/** "example.com" for https://www.example.com/a; null when the link does not parse. */
function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** A press on a row's own space, not on a control or a link, and not the end of a text selection. */
const rowPress = (event: MouseEvent<HTMLElement>) =>
  !event.defaultPrevented &&
  !(event.target as Element).closest('a, button, input, textarea, select, [role="button"], [role="menu"], [role="dialog"]') &&
  !window.getSelection()?.toString();

/**
 * One post in a feed, in one of three densities with the same parts in the same order: the meta
 * line (community, author, age, flags), the title, the media and the action row (vote, comments,
 * share outside Compact, `actions`). Card adds the picture or link line and a text post's excerpt; Classic a
 * thumbnail beside the title; Compact is the meta, the title and a plain action row. The vote
 * keeps its place in the tree in every density, so switching never remounts it (an optimistic
 * vote stays). A press on the row's own space opens the post through its title link, so text stays
 * selectable and the title is the one way in for the keyboard. A sensitive post's media and
 * excerpt sit under an NsfwCover until shown. The server decides what a viewer receives; this
 * only renders it.
 */
export function PostRow({
  post,
  density,
  hrefs,
  labels,
  locale,
  thumbnailSrc,
  onVote,
  voteDisabled,
  onShare,
  actions,
  hideCommunity,
  cover = {},
  headingLevel = 2,
  now,
}: PostRowProps) {
  const [ownRevealed, setOwnRevealed] = useState(cover.revealed ?? false);
  const hydrated = useHydrated();
  const revealed = cover.onRevealedChange ? (cover.revealed ?? false) : ownRevealed;
  const setRevealed = cover.onRevealedChange ?? setOwnRevealed;
  const kind = kindOf(post);
  const sensitive = post.sensitive || post.nsfl;
  const gone = post.removed || post.deleted;
  const domain = post.url && !gone ? domainOf(post.url) : null;
  const picture = gone ? null : thumbnailSrc;
  const title = post.removed ? labels.removed : post.deleted ? labels.deleted : post.title;
  const titleId = useId();
  const card = density === 'card';
  const compact = density === 'compact';
  // Only what the density shows can be concealed: a Compact row and a text post in Classic have no media.
  const media = compact ? null : card ? cardMedia() : picture ? thumbnail(hrefs.post) : null;
  const hidden = sensitive && !revealed && media !== null;

  function thumbnail(href: string, fit: 'cover' | 'contain' = 'cover') {
    // A second way in for pointer users: out of the tab order and hidden from assistive
    // technology, which reach the post (or its link) by the title and the link line.
    return (
      <Link className="pb-post__thumb" href={href} tabIndex={-1} aria-hidden="true">
        <Image src={picture!} alt="" loading="lazy" decoding="async" fit={fit} className="pb-post__picture" />
      </Link>
    );
  }

  function cardMedia() {
    const excerpt = kind === 'text' && post.excerpt && !gone && (
      <Text as="p" size="sm" className="pb-post__excerpt">
        {post.excerpt}
      </Text>
    );
    const wide = kind === 'image' && picture;
    if (!excerpt && !picture && !domain) return null;
    return (
      <>
        {excerpt}
        {picture && (
          <div className={wide ? 'pb-post__media' : 'pb-post__aside'}>
            {thumbnail(kind === 'link' ? post.url! : hrefs.post, wide ? 'contain' : 'cover')}
          </div>
        )}
        {domain && !wide && <LinkPreview className="pb-post__link" href={post.url} domain={domain} />}
      </>
    );
  }

  const flags = (post.featured || post.locked || post.sensitive || post.nsfl) && (
    <span className="pb-post__flags">
      {post.featured && <Badge kind="pinned">{labels.pinned}</Badge>}
      {post.locked && <Badge kind="locked">{labels.locked}</Badge>}
      {post.sensitive && <Badge kind="nsfw">{labels.nsfw}</Badge>}
      {post.nsfl && <Badge kind="nsfl">{labels.nsfl}</Badge>}
    </span>
  );

  const open = (event: MouseEvent<HTMLElement>) => {
    if (!rowPress(event)) return;
    const link = event.currentTarget.querySelector<HTMLAnchorElement>('.pb-post__title a');
    link?.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }),
    );
  };

  return (
    // The row's press is a pointer shortcut to its title link, which the keyboard reaches itself.
    <article
      aria-labelledby={titleId}
      className="pb-post"
      data-density={density}
      data-kind={kind}
      data-picture={picture ? true : undefined}
      data-pinned={post.featured || undefined}
      data-sensitive={sensitive || undefined}
      data-hidden={hidden || undefined}
      onClick={open}
    >
      <Text as="div" size="sm" color="muted" className="pb-post__meta">
        {!hideCommunity && (
          <>
            <Link className="pb-post__community pb-link-quiet" href={hrefs.community}>
              <Handle prefix="!" handle={post.community.handle} />
            </Link>
            <Text aria-hidden="true">·</Text>
          </>
        )}
        <span className="pb-post__by">
          <Link className="pb-link-muted" href={hrefs.author}>
            <Handle prefix="@" handle={post.author.handle} />
          </Link>
          {post.authorBadge && <Badge kind={post.authorBadge} labels={labels.badges} />}
        </span>
        <Text aria-hidden="true">·</Text>
        <Time iso={post.publishedAt} locale={locale} now={now} />
        {flags}
      </Text>

      <div className="pb-post__body">
        <Text as={`h${headingLevel}`} id={titleId} variant="label" size={compact ? 'sm' : 'md'} className="pb-post__title">
          <Link className="pb-link-quiet" href={hrefs.post}>
            {/* A title from another server is isolated, its directional controls removed. */}
            <BidiText text={title} />
          </Link>
          {domain && !card && (
            <Text size="xs" color="muted" className="pb-post__domain">
              {/* The domain comes from the post's link: isolated and left to right, like a handle's host. */}
              <bdi dir="ltr">({neutraliseBidi(domain)})</bdi>
            </Text>
          )}
        </Text>
        {media &&
          (sensitive ? (
            <NsfwCover
              className="pb-post__concealed"
              size={card ? 'slot' : 'thumb'}
              revealed={revealed}
              onReveal={() => setRevealed(true)}
              eligible={cover.eligible ?? true}
              pending={cover.pending}
              labels={labels.cover}
            >
              {media}
            </NsfwCover>
          ) : card ? (
            media
          ) : (
            <div className="pb-post__aside">{media}</div>
          ))}
      </div>

      <div className="pb-post__actions">
        <VoteControl
          className="pb-post__vote"
          orientation="horizontal"
          variant={compact ? 'plain' : 'pill'}
          score={post.counts.upvotes - post.counts.downvotes}
          myVote={post.myVote}
          onVote={onVote}
          disabled={voteDisabled}
          labels={labels.vote}
          // Named as the title is shown: its directional controls as the replacement mark, as the inbox's names are.
          label={labels.voteOn ? labels.voteOn(neutraliseBidi(title)) : `${labels.vote.group}: ${neutraliseBidi(title)}`}
          locale={locale}
        />
        <Link className="pb-post__comments pb-link-quiet" href={hrefs.post} aria-label={labels.comments(post.counts.comments)}>
          <CommentsIcon />
          <span>{new Intl.NumberFormat(locale).format(post.counts.comments)}</span>
        </Link>
        {sensitive && revealed && media && (
          <Button variant="neutral" size="sm" className="pb-post__action" onActivate={() => setRevealed(false)}>
            {labels.hide}
          </Button>
        )}
        {onShare && !compact && (
          // A script's action: disabled until the page has hydrated, and gone without scripts (post-row.css).
          <Button
            variant="neutral"
            size="sm"
            className="pb-post__action pb-post__share"
            aria-label={labels.share}
            onActivate={onShare}
            disabled={!hydrated}
          >
            <ShareIcon />
            <span className="pb-post__action-label">{labels.share}</span>
          </Button>
        )}
        {actions}
      </div>
    </article>
  );
}
