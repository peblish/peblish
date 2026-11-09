import type { ActorRef, CommentView } from '@peblish/schema/views';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { CommentThread, unloadedReplies, type CommentThreadLabels } from './comment-thread.tsx';
import { buildCommentTree } from './comment-tree.ts';

const person: ActorRef = {
  id: '00000000-0000-7000-9000-000000000001',
  apId: 'https://feddit.test/u/jun',
  kind: 'Person',
  name: 'jun',
  displayName: null,
  local: true,
  handle: 'jun',
};

/** A comment whose `replies` counts every comment under it, as the server's child_count does. */
const comment = (id: string, parentId: string | null, replies: number, flags: Partial<CommentView> = {}): CommentView => ({
  id,
  apId: `https://feddit.test/comment/${id}`,
  postId: 'post',
  parentId,
  depth: 0,
  contentHtml: `<p>text of ${id}</p>`,
  author: person,
  authorBadge: null,
  publishedAt: '2026-11-09T09:00:00Z',
  editedAt: null,
  deleted: false,
  removed: false,
  counts: { upvotes: 1, downvotes: 0, comments: replies },
  myVote: 0,
  ...flags,
});

const labels = {
  vote: { group: 'Vote', up: 'Upvote', down: 'Downvote', score: (n: number) => `${n}` },
  badges: { admin: 'admin', moderator: 'mod', op: 'OP' },
  section: 'Comments',
  collapse: () => 'Collapse',
  expand: () => 'Expand',
  hiddenReplies: (n: number) => `${n} hidden`,
  lowScore: () => 'low',
  show: 'show',
  continueThread: 'Continue this thread',
  moreReplies: (n: number) => `${n} more replies`,
  removed: '[removed]',
  deleted: '[deleted]',
  edited: 'edited',
  reply: 'reply',
  share: 'share',
} as unknown as CommentThreadLabels;

const draw = (comments: CommentView[], continueHref: (c: CommentView) => string | null = (c) => `/c/${c.id}`) =>
  renderToStaticMarkup(
    <CommentThread
      comments={comments}
      postAuthorId="nobody"
      continueHref={continueHref}
      authorHref={() => '/u/jun'}
      labels={labels}
      locale="en-US"
    />,
  );

describe('replies the list leaves out', () => {
  // a has 5 replies below it (b, c and three more, one of them under b); b has 2 (c and one more); the list holds a, b and c.
  const list = [comment('a', null, 5), comment('b', 'a', 2), comment('c', 'b', 0)];

  test('count against the comment they hang from, not the ones above it', () => {
    const [a] = buildCommentTree(list);
    // b's missing reply is b's to show; the other two missing ones hang from a itself.
    expect(unloadedReplies(a!)).toBe(2);
    expect(unloadedReplies(a!.children[0]!)).toBe(1);
  });

  test('a branch the list holds only partly continues where it was cut, beside the replies it does show', () => {
    const html = draw(list);
    expect(html).toContain('text of c');
    expect(html.match(/Continue this thread/g)).toHaveLength(2);
    expect(html).toContain('2 more replies');
    expect(html).toContain('1 more replies');
    expect(html).toContain('href="/c/a"');
    expect(html).toContain('href="/c/b"');
  });

  test('a whole list offers none, and a comment with no link to offer shows none', () => {
    expect(draw([comment('a', null, 1), comment('b', 'a', 0)])).not.toContain('Continue this thread');
    expect(draw(list, (c) => (c.id === 'a' ? null : `/c/${c.id}`)).match(/Continue this thread/g)).toHaveLength(1);
  });
});

describe('a comment that is both deleted and removed', () => {
  test('shows one label, removed, and hides the author as a deleted one does', () => {
    const html = draw([comment('a', null, 0, { deleted: true, removed: true, contentHtml: null })]);
    expect(html).toContain('[removed]');
    expect(html).not.toContain('[deleted]');
    expect(html).not.toContain('@jun');
  });

  test('removed alone still shows the author', () => {
    const html = draw([comment('a', null, 0, { removed: true, contentHtml: null })]);
    expect(html).toContain('[removed]');
    expect(html).toContain('@jun');
  });

  test('deleted alone still hides the author', () => {
    const html = draw([comment('a', null, 0, { deleted: true, contentHtml: null })]);
    expect(html).toContain('[deleted]');
    expect(html).not.toContain('@jun');
  });
});

test('times from the server are printed as given', () => {
  const html = renderToStaticMarkup(
    <CommentThread
      comments={[comment('a', null, 0)]}
      postAuthorId="nobody"
      continueHref={() => null}
      authorHref={() => '/u/jun'}
      labels={labels}
      locale="en-US"
      times={new Map([['a', { age: '3h', title: 'Nov 9, 2026, 9:00 AM UTC' }]])}
    />,
  );
  expect(html).toContain('<time dateTime="2026-11-09T09:00:00Z" title="Nov 9, 2026, 9:00 AM UTC">3h</time>');
});
