import type { ActorRef, CommentView } from '@peblish/schema/views';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { CommentThread, unloadedReplies, type CommentThreadLabels, type CommentThreadProps } from './comment-thread.tsx';
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
  blocked: '[blocked]',
  edited: 'edited',
  reply: 'reply',
  share: 'share',
} as unknown as CommentThreadLabels;

const draw = (
  comments: CommentView[],
  continueHref: (c: CommentView) => string | null = (c) => `/c/${c.id}`,
  props: Partial<CommentThreadProps> = {},
) =>
  renderToStaticMarkup(
    <CommentThread
      comments={comments}
      postAuthorId="nobody"
      continueHref={continueHref}
      authorHref={() => '/u/jun'}
      labels={labels}
      locale="en-US"
      {...props}
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

describe('a tombstone', () => {
  test('both deleted and removed shows one label, removed, and no author', () => {
    const html = draw([comment('a', null, 0, { deleted: true, removed: true, contentHtml: null })]);
    expect(html).toContain('[removed]');
    expect(html).not.toContain('[deleted]');
    expect(html).not.toContain('@jun');
  });

  test('removed or deleted alone carries no author, badge, text, vote or reply', () => {
    for (const flags of [{ removed: true }, { deleted: true }]) {
      const html = draw([comment('a', null, 0, { ...flags, contentHtml: '<p>text of a</p>', authorBadge: 'moderator' })], () => null, {
        postAuthorId: person.id,
        onReply: () => {},
        onVote: () => {},
      });
      expect(html).not.toContain('@jun');
      expect(html).not.toContain('href="/u/jun"');
      expect(html).not.toContain('text of a');
      expect(html).not.toContain('>OP<');
      expect(html).not.toContain('>mod<');
      expect(html).not.toContain('aria-label="Vote"');
      expect(html).not.toContain('>reply<');
    }
  });

  test("its replies stay, and a deep one does not name the tombstone's author as the one it answers", () => {
    const chain = [
      comment('a', null, 4),
      comment('b', 'a', 3),
      comment('c', 'b', 2, { removed: true, contentHtml: null }),
      comment('d', 'c', 1),
      comment('e', 'd', 0),
    ];
    const html = draw(chain, () => null, { labels: { ...labels, inReplyTo: 'in reply to' } });
    expect(html).toContain('text of d');
    // d (level 3) answers the tombstone: no name; e (level 4) answers d, whose author is shown.
    expect(html.match(/in reply to/g)).toHaveLength(1);
  });
});

describe('folding', () => {
  test('a low score folds the comment, drawn in the page so a browser without scripts still reads it', () => {
    const html = draw([comment('a', null, 1, { counts: { upvotes: 0, downvotes: 9, comments: 1 } }), comment('b', 'a', 0)]);
    expect(html).toContain('data-soft="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('text of a');
    expect(html).toContain('text of b');
    // Why it is folded, and what the fold hides.
    expect(html).toContain('low 1 hidden');
  });

  test('the comment a permalink page starts from opens unfolded, whatever its score', () => {
    const html = draw([comment('a', null, 0, { counts: { upvotes: 0, downvotes: 9, comments: 0 } })], () => null, { focusId: 'a' });
    expect(html).not.toContain('data-folded');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-focus="true"');
  });
});

describe('the comment menu', () => {
  const menuLabels = { ...labels, more: 'More actions', menu: 'Comment actions', copyLink: 'Copy link' };

  test('each comment shown has a More actions button once the page gives its address and the labels', () => {
    const list = [comment('a', null, 0), comment('b', null, 0, { deleted: true, contentHtml: null })];
    expect(draw(list, () => null, { labels: menuLabels })).not.toContain('More actions');
    const html = draw(list, () => null, { labels: menuLabels, linkOf: (c) => `https://feddit.test/c/${c.id}` });
    // The tombstone has none; the menu itself mounts only when it opens.
    expect(html.match(/aria-label="More actions"/g)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('Copy link');
    expect(html).toContain('role="status"');
  });
});

test('ages are counted from the clock the page passes, so the server and the browser print the same', () => {
  const html = renderToStaticMarkup(
    <CommentThread
      comments={[comment('a', null, 0)]}
      postAuthorId="nobody"
      continueHref={() => null}
      authorHref={() => '/u/jun'}
      labels={labels}
      locale="en-US"
      now={new Date('2026-11-09T12:00:00Z')}
    />,
  );
  expect(html).toMatch(/<time dateTime="2026-11-09T09:00:00Z" title="Nov 9, 2026, 09:00 (AM )?UTC"><span>3h<\/span>/);
});

describe('a comment by someone the viewer blocks', () => {
  test('keeps its author line and its replies, without its text, vote or reply', () => {
    const html = renderToStaticMarkup(
      <CommentThread
        comments={[comment('a', null, 1, { blocked: true }), comment('b', 'a', 0)]}
        postAuthorId="nobody"
        continueHref={() => null}
        authorHref={() => '/u/jun'}
        labels={labels}
        locale="en-US"
        onReply={() => {}}
      />,
    );
    expect(html).toContain('[blocked]');
    expect(html).not.toContain('text of a');
    expect(html).toContain('text of b');
    expect(html.match(/href="\/u\/jun"/g)).toHaveLength(2);
    // Only b offers a vote and a reply.
    expect(html.match(/>reply</g)).toHaveLength(1);
    expect(html.match(/aria-label="Vote"/g)).toHaveLength(1);
  });

  test("the page's actions render on every comment, a blocked one included", () => {
    const html = renderToStaticMarkup(
      <CommentThread
        comments={[comment('a', null, 0, { blocked: true }), comment('b', null, 0, { removed: true })]}
        postAuthorId="nobody"
        continueHref={() => null}
        authorHref={() => '/u/jun'}
        labels={labels}
        locale="en-US"
        renderActions={(c) => <span>actions of {c.id}</span>}
      />,
    );
    expect(html).toContain('actions of a');
    expect(html).toContain('actions of b');
  });
});

test('each comment folds with a named Mux IconButton that says whether it is open, and no raw control is left', () => {
  const html = draw([comment('a', null, 1), comment('b', 'a', 0)]);
  expect(html.match(/class="muxui-icon-button[^"]*"/g)).toHaveLength(2);
  expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Collapse"');
  // The thread line is the fold button's target (comment-thread.css), not an element of its own.
  expect(html).toContain('data-lined="true"');
  expect(html).not.toContain('<span class="pb-comment__line"');
});
