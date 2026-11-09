import type { PostView } from '@peblish/schema/views';
import { useState } from 'react';
import { Badge, type BadgeLabels } from './badge.tsx';
import { Handle } from './handle.tsx';
import { ImageIcon, LinkIcon, TextIcon } from './icons.tsx';
import { Time } from './time.tsx';
import { VoteControl, type Vote, type VoteControlLabels } from './vote-control.tsx';

export type Density = 'card' | 'classic' | 'compact';

export interface PostCardLabels {
  vote: VoteControlLabels;
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
 * One post in a feed, in one of three densities (Card, Classic, Compact) with the same markup:
 * the CSS lays it out by `data-density`. Plain links and buttons only. A sensitive (NSFW or
 * NSFL) post starts hidden: its picture is blurred and its excerpt withheld until "show".
 * The server decides what a signed-out viewer receives; this only renders it.
 */
export function PostCard({ post, density, hrefs, labels, locale, onVote, voteDisabled, onShare, headingLevel = 2, now }: PostCardProps) {
  const [revealed, setRevealed] = useState(false);
  const kind = kindOf(post);
  const sensitive = post.sensitive || post.nsfl;
  const hidden = sensitive && !revealed;
  const gone = post.removed || post.deleted;
  const domain = post.url ? domainOf(post.url) : null;
  const Heading = `h${headingLevel}` as const;
  const Mark = markIcons[kind];

  return (
    <article
      className="pb-post"
      data-density={density}
      data-kind={kind}
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
        locale={locale}
      />
      <a className="pb-post__thumb" href={hrefs.post} tabIndex={-1} aria-hidden="true">
        {post.thumbnailUrl && !gone ? (
          <img src={post.thumbnailUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="pb-post__mark">
            <Mark />
            <span>{labels[kind]}</span>
          </span>
        )}
      </a>
      <div className="pb-post__body">
        <Heading className="pb-post__title">
          {post.featured && <span className="pb-tag pb-tag--pin">{labels.pinned}</span>}
          {post.locked && <span className="pb-tag pb-tag--lock">{labels.locked}</span>}
          {post.sensitive && <span className="pb-tag pb-tag--nsfw">{labels.nsfw}</span>}
          {post.nsfl && <span className="pb-tag pb-tag--nsfw">{labels.nsfl}</span>}
          <a href={hrefs.post}>{post.removed ? labels.removed : post.deleted ? labels.deleted : post.title}</a>
          {domain && !gone && <span className="pb-post__domain">({domain})</span>}
        </Heading>
        <div className="pb-post__meta">
          <a className="pb-post__community" href={hrefs.community}>
            <Handle prefix="!" handle={post.community.handle} />
          </a>{' '}
          <span className="pb-post__by">
            {labels.by}{' '}
            <a href={hrefs.author}>
              <Handle prefix="@" handle={post.author.handle} />
            </a>
            {post.authorBadge && <Badge kind={post.authorBadge} labels={labels.badges} />}
          </span>{' '}
          · <Time iso={post.publishedAt} locale={locale} now={now} />
        </div>
        {post.excerpt && !gone && !hidden && <p className="pb-post__excerpt">{post.excerpt}</p>}
        <div className="pb-post__actions">
          <a className="pb-post__comments" href={hrefs.post}>
            {labels.comments(post.counts.comments)}
          </a>
          {sensitive && (
            <button type="button" className="pb-linkbutton" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
              {revealed ? labels.hide : labels.show}
            </button>
          )}
          {onShare && (
            <button type="button" className="pb-linkbutton" onClick={onShare}>
              {labels.share}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
