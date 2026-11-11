import type { PostView } from '@peblish/schema/views';
import { useId, useState } from 'react';
import { Badge, type BadgeLabels } from './badge.tsx';
import { Button } from './button.tsx';
import { Card } from './card.tsx';
import { BidiText, Handle, neutraliseBidi } from './handle.tsx';
import { ImageIcon, LinkIcon, TextIcon } from './icons.tsx';
import { Image } from './image.tsx';
import { Link } from './link.tsx';
import { Text } from './text.tsx';
import { Time } from './time.tsx';
import { VoteControl, type Vote, type VoteControlLabels } from './vote-control.tsx';

export type Density = 'card' | 'classic' | 'compact';

export interface PostCardLabels {
  vote: VoteControlLabels;
  /**
   * The vote group's name for one post, from its title as the card shows it: "Vote on <title>".
   * Without it the group is named "<vote.group>: <title>".
   */
  voteOn?: (title: string) => string;
  badges: BadgeLabels;
  /** Tags before the title. */
  pinned: string;
  locked: string;
  nsfw: string;
  nsfl: string;
  removed: string;
  deleted: string;
  /** "148 comments", "1 comment". */
  comments: (count: number) => string;
  share: string;
  /** The button on a sensitive post that is still hidden, and the one that hides it again. */
  show: string;
  hide: string;
  /** The word between the community and the author: "by". */
  by: string;
  /** Names for the three kinds of post, for the thumbnail's fallback mark. */
  text: string;
  link: string;
  image: string;
}

export interface PostCardHrefs {
  post: string;
  community: string;
  author: string;
}

export interface PostCardProps {
  post: PostView;
  density: Density;
  hrefs: PostCardHrefs;
  labels: PostCardLabels;
  locale: string;
  /**
   * Where the thumbnail loads from, resolved by the page with the renderer's `image()` helper
   * (web/src/server/markdown.ts): this instance's own URL, the signed proxy path for a remote
   * image, or null (none, or it must not load). The card never reads `post.thumbnailUrl`, since
   * a raw remote URL would hand the viewer's address to that host.
   */
  thumbnailSrc: string | null;
  /** Called with the viewer's new vote; see VoteControl. Without it the arrows still respond but save nothing. */
  onVote?: (value: Vote) => void | Promise<void>;
  /** The viewer cannot vote on this post. */
  voteDisabled?: boolean;
  /** Shows the share action when given. */
  onShare?: () => void;
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

const markIcons = { text: TextIcon, link: LinkIcon, image: ImageIcon } as const;

/**
 * One post in a feed, in one of three densities (Card, Classic, Compact) with the same parts: an
 * outlined Mux Card in Card density, a dense row in Classic and Compact; the CSS lays them out by
 * `data-density`. The vote control sits outside the Card, in the article's grid, so changing the
 * density never remounts it (an optimistic vote stays). A sensitive (NSFW or NSFL) post starts
 * hidden: its picture is blurred and its excerpt withheld until "show". The server decides what
 * a signed-out viewer receives; this only renders it.
 */
export function PostCard({
  post,
  density,
  hrefs,
  labels,
  locale,
  thumbnailSrc,
  onVote,
  voteDisabled,
  onShare,
  headingLevel = 2,
  now,
}: PostCardProps) {
  const [revealed, setRevealed] = useState(false);
  const kind = kindOf(post);
  const sensitive = post.sensitive || post.nsfl;
  const hidden = sensitive && !revealed;
  const gone = post.removed || post.deleted;
  const domain = post.url ? domainOf(post.url) : null;
  const Mark = markIcons[kind];
  const card = density === 'card';
  const picture = gone ? null : thumbnailSrc;
  const title = post.removed ? labels.removed : post.deleted ? labels.deleted : post.title;
  const titleId = useId();
  // Dense rows take Mux's label role for the title, so a row stays one scan line (the RM mock's rows).
  const titleType = card
    ? ({ variant: 'title', size: 'md' } as const)
    : ({ variant: 'label', size: density === 'classic' ? 'lg' : 'md' } as const);

  const parts = (
    <>
      {/* A second way to the post for pointer users: hidden from the tab order and from assistive
          technology, which reach the post by its title. */}
      <Link className="pb-post__thumb" href={hrefs.post} tabIndex={-1} aria-hidden="true">
        {picture ? (
          <Image src={picture} alt="" loading="lazy" decoding="async" fit="cover" className="pb-post__picture" />
        ) : (
          <span className="pb-post__mark">
            <Mark />
            <Text variant="label" size="xs">
              {labels[kind]}
            </Text>
          </span>
        )}
      </Link>
      <div className="pb-post__body">
        <Text as={`h${headingLevel}`} id={titleId} {...titleType} className="pb-post__title">
          {post.featured && <Badge kind="pinned">{labels.pinned}</Badge>}
          {post.locked && <Badge kind="locked">{labels.locked}</Badge>}
          {post.sensitive && <Badge kind="nsfw">{labels.nsfw}</Badge>}
          {post.nsfl && <Badge kind="nsfl">{labels.nsfl}</Badge>}
          <Link className="pb-link-quiet" href={hrefs.post}>
            {/* A title from another server is isolated, its directional controls removed. */}
            <BidiText text={title} />
          </Link>
          {domain && !gone && (
            <Text size="xs" color="muted" className="pb-post__domain">
              {/* The domain comes from the post's link: isolated and left to right, like a handle's host. */}
              <bdi dir="ltr">({neutraliseBidi(domain)})</bdi>
            </Text>
          )}
        </Text>
        <Text as="div" size="xs" color="muted" className="pb-post__meta">
          <Link className="pb-post__community" href={hrefs.community}>
            <Handle prefix="!" handle={post.community.handle} />
          </Link>{' '}
          <span className="pb-post__by">
            {labels.by}{' '}
            <Link className="pb-link-muted" href={hrefs.author}>
              <Handle prefix="@" handle={post.author.handle} />
            </Link>
            {post.authorBadge && <Badge kind={post.authorBadge} labels={labels.badges} />}
          </span>{' '}
          · <Time iso={post.publishedAt} locale={locale} now={now} />
        </Text>
        {post.excerpt && !gone && !hidden && (
          <Text as="p" size={card ? 'md' : 'sm'} className="pb-post__excerpt">
            {post.excerpt}
          </Text>
        )}
        <Text as="div" size="sm" className="pb-post__actions">
          <Link className="pb-post__comments pb-link-quiet" href={hrefs.post}>
            {labels.comments(post.counts.comments)}
          </Link>
          {sensitive && (
            <Button variant="ghost" size="sm" aria-pressed={revealed} onActivate={() => setRevealed(!revealed)}>
              {revealed ? labels.hide : labels.show}
            </Button>
          )}
          {onShare && (
            <Button variant="ghost" size="sm" onActivate={onShare}>
              {labels.share}
            </Button>
          )}
        </Text>
      </div>
    </>
  );

  return (
    <article
      aria-labelledby={titleId}
      className="pb-post"
      data-density={density}
      data-kind={kind}
      data-picture={picture ? true : undefined}
      data-pinned={post.featured || undefined}
      data-sensitive={sensitive || undefined}
      data-hidden={hidden || undefined}
    >
      <VoteControl
        className="pb-post__vote"
        score={post.counts.upvotes - post.counts.downvotes}
        myVote={post.myVote}
        onVote={onVote}
        disabled={voteDisabled}
        labels={labels.vote}
        // Named as the title is shown: its directional controls as the replacement mark, as the inbox's names are.
        label={labels.voteOn ? labels.voteOn(neutraliseBidi(title)) : `${labels.vote.group}: ${neutraliseBidi(title)}`}
        locale={locale}
      />
      {card ? (
        <Card.Root variant="outlined" padding="sm" className="pb-post__frame">
          {parts}
        </Card.Root>
      ) : (
        <div className="pb-post__frame">{parts}</div>
      )}
    </article>
  );
}
