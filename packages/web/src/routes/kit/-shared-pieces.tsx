import { CountBadge } from '@peblish/ui/components/count-badge';
import { FactList } from '@peblish/ui/components/fact-list';
import { Link } from '@peblish/ui/components/link';
import { LinkPreview } from '@peblish/ui/components/link-preview';
import { NsfwCover } from '@peblish/ui/components/nsfw-cover';
import { PostRow, type Density } from '@peblish/ui/components/post-row';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { Text } from '@peblish/ui/components/text';
import { VoteControl, type Vote } from '@peblish/ui/components/vote-control';
import { FeedSkeleton, InboxSkeleton, RailSkeleton, ThreadSkeleton } from '@peblish/ui/skeleton/skeletons';
import type { PostView } from '@peblish/schema/views';
import { useState } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { usePostCardLabels, useVoteLabels } from '../../shell/labels.ts';
import { communityPath, postPath, userPath } from '../../shell/paths.ts';
import { now, posts, thumbnailSrc } from './-samples.ts';
import type { Composition } from './-states.tsx';

// The Commons shared pieces' state pages (/kit/<key>), registered in -states.tsx. Sample content is
// invented; the pieces' own words come from the ui catalogue.

function Row({ post, density, voteDisabled }: { post: PostView; density: Density; voteDisabled?: boolean }) {
  const { locale } = useTranslate();
  return (
    <PostRow
      post={post}
      density={density}
      hrefs={{ post: postPath(post.id), community: communityPath(post.community), author: userPath(post.author) }}
      labels={usePostCardLabels()}
      locale={locale}
      thumbnailSrc={thumbnailSrc(post)}
      voteDisabled={voteDisabled}
      onShare={() => undefined}
      headingLevel={3}
      now={now}
    />
  );
}

const rowStates = (density: Density): Composition['states'] => ({
  rest: () => <Row post={posts.link} density={density} />,
  selected: () => <Row post={{ ...posts.link, myVote: 1 }} density={density} />,
  disabled: () => <Row post={posts.link} density={density} voteDisabled />,
});

function Pill({ myVote = 0, disabled }: { myVote?: Vote; disabled?: boolean }) {
  const { locale } = useTranslate();
  return (
    <VoteControl
      score={95}
      myVote={myVote}
      variant="pill"
      orientation="horizontal"
      disabled={disabled}
      labels={useVoteLabels()}
      locale={locale}
    />
  );
}

function Cover({ eligible = true, pending, revealed: start = false }: { eligible?: boolean; pending?: boolean; revealed?: boolean }) {
  const { t } = useTranslate();
  const [revealed, setRevealed] = useState(start);
  return (
    <div className="kit-cover">
      <NsfwCover
        revealed={revealed}
        onReveal={() => setRevealed(true)}
        eligible={eligible}
        pending={pending}
        labels={{ hidden: t('ui', 'cover.hidden'), show: t('ui', 'cover.show') }}
      >
        <Link href="/post/kit-concealed" data-kit-concealed="">
          Concealed link
        </Link>
      </NsfwCover>
    </div>
  );
}

function Panel() {
  return (
    <div className="kit-rail">
      <RailPanel title="About !art" action={<Link href="/c/art">See all</Link>}>
        <Text as="p" size="sm">
          Charcoal, ink and the odd watercolour. Weekly prompts on Mondays.
        </Text>
        <FactList
          size="xs"
          items={[
            { label: 'Created', value: 'Nov 3, 2026' },
            { label: 'Moderator', value: <Link href="/u/mira">@mira</Link> },
          ]}
        />
      </RailPanel>
    </div>
  );
}

function Inbox({ current }: { current?: boolean }) {
  const { locale } = useTranslate();
  return (
    <Link href="/inbox" aria-current={current ? 'page' : undefined} className="kit-inbox">
      Inbox <CountBadge count={3} locale={locale} />
      <Text className="pb-sr">, 3 unread</Text>
    </Link>
  );
}

/** The shared pieces' compositions, spread into `compositions`. */
export const sharedPieces: Readonly<Record<string, Composition>> = {
  'post-row-card': { name: 'PostRow, Card', states: rowStates('card') },
  'post-row-classic': { name: 'PostRow, Classic', states: rowStates('classic') },
  'post-row-compact': { name: 'PostRow, Compact', states: rowStates('compact') },
  'vote-pill': {
    name: 'Vote control, pill',
    states: { rest: () => <Pill />, selected: () => <Pill myVote={-1} />, disabled: () => <Pill disabled /> },
  },
  'link-preview': {
    name: 'LinkPreview',
    states: {
      rest: () => <LinkPreview href="https://www.join-lemmy.org/news/lock-and-flag" domain="join-lemmy.org" />,
      disabled: () => <LinkPreview href={null} domain="join-lemmy.org" />,
    },
  },
  'nsfw-cover': {
    name: 'NsfwCover',
    states: {
      rest: () => <Cover />,
      selected: () => <Cover revealed />,
      disabled: () => <Cover eligible={false} />,
      pending: () => <Cover pending />,
    },
  },
  'rail-panel': { name: 'RailPanel with FactList', states: { rest: Panel } },
  'count-badge': { name: 'CountBadge on Inbox', states: { rest: () => <Inbox />, selected: () => <Inbox current /> } },
  skeletons: {
    name: 'Skeleton hosts',
    states: {
      pending: () => (
        <div className="kit-skeletons">
          <FeedSkeleton density="card" label="Loading posts" />
          <FeedSkeleton density="classic" />
          <FeedSkeleton density="compact" />
          <RailSkeleton />
          <ThreadSkeleton />
          <InboxSkeleton />
        </div>
      ),
    },
  },
};
