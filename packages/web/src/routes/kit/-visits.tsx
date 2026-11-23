import type { CommentView } from '@peblish/schema/views';
import { CommentThread } from '@peblish/ui/components/comment-thread';
import { Text } from '@peblish/ui/components/text';
import { useTranslate } from '../../i18n/use-translate.ts';
import { commentPath, userPath } from '../../shell/paths.ts';
import commentsCss from '../post/$id/comments/-ui/comments.css?url';
import { NewSince } from '../post/$id/comments/-ui/new-since.tsx';
import { useTreeLabels } from '../post/$id/comments/-ui/thread-section.tsx';
import { now, people, posts } from './-samples.ts';
import type { Composition } from './-states.tsx';
import threadCss from './-thread.css?url';

// "New since your last visit" (f-visits), registered in -states.tsx: the thread's heading row with the
// jump to the next new comment, and the comments it marks New, one of them a reply under a comment folded
// for its low score (the jump opens it). Disabled is a count whose new comments are all on other pages.
// Signed out (viewerId null), so the sample records no visit. Invented content.

const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

function rows(prefix: string, newOnPage: boolean): CommentView[] {
  const row = (key: string, parent: string | null, html: string, isNew: boolean, replies = 0, downvotes = 0): CommentView => ({
    id: `${prefix}-${key}`,
    apId: `https://feddit.test/comment/${prefix}-${key}`,
    postId: posts.link.id,
    parentId: parent && `${prefix}-${parent}`,
    depth: 0,
    contentHtml: html,
    author: isNew ? people.mira : people.kofi,
    authorBadge: null,
    publishedAt: ago(isNew ? 1 : 30),
    editedAt: null,
    deleted: false,
    removed: false,
    counts: { upvotes: 4, downvotes, comments: replies },
    myVote: 0,
    isNew: newOnPage && isNew,
  });
  return [
    row('a', null, '<p>The trail was closed after the storm, open again since Friday.</p>', false, 1),
    row('b', 'a', '<p>Walked it on Sunday: muddy past the second creek, otherwise fine.</p>', true),
    row('c', null, '<p>Parking fills by nine on weekends.</p>', false),
    row('d', null, '<p>The kiosk at the top takes cards now.</p>', true),
    row('e', null, '<p>Skip it, the view is overrated.</p>', false, 1, 14),
    row('f', 'e', '<p>The view from the ridge is the whole point.</p>', true),
  ];
}

function Sample({ newOnPage }: { newOnPage: boolean }) {
  const { locale } = useTranslate();
  const list = rows(newOnPage ? 'on' : 'off', newOnPage);
  return (
    <div className="kit-tree th-thread">
      <link rel="stylesheet" href={threadCss} />
      <link rel="stylesheet" href={commentsCss} />
      <div className="th-head">
        <Text as="h2" variant="title" size="sm" className="th-heading">
          6 comments
        </Text>
        <NewSince postId={posts.link.id} viewerId={null} newCount={3} comments={list} />
      </div>
      <CommentThread
        comments={list}
        postAuthorId={people.jun.id}
        continueHref={(comment) => commentPath(posts.link.id, comment.id)}
        authorHref={(comment) => userPath(comment.author)}
        labels={useTreeLabels()}
        locale={locale}
        now={now}
        voteDisabled
        onVote={() => undefined}
        linkOf={(comment) => new URL(commentPath(posts.link.id, comment.id), window.location.origin).href}
      />
    </div>
  );
}

/** The visits feature's compositions, spread into `compositions`. */
export const visitPieces: Readonly<Record<string, Composition>> = {
  'new-since': {
    name: 'New since your last visit',
    states: {
      rest: () => <Sample newOnPage />,
      disabled: () => <Sample newOnPage={false} />,
    },
  },
};
