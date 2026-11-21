import type { ActorRef, CommentView } from '@peblish/schema/views';
import { CommentThread } from '@peblish/ui/components/comment-thread';
import { LockIcon } from '@peblish/ui/components/icons';
import { ReplyBar, ReplyNotice } from '@peblish/ui/components/reply-bar';
import type { ReactNode } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useReplyBarLabels } from '../../shell/labels.ts';
import { commentPath, userPath } from '../../shell/paths.ts';
import commentsCss from '../post/$id/comments/-ui/comments.css?url';
import { useTreeLabels } from '../post/$id/comments/-ui/thread-section.tsx';
import { PostPills } from '../post/-ui/post-pills.tsx';
import postCss from '../post/-ui/post.css?url';
import { now, people, posts } from './-samples.ts';
import type { Composition } from './-states.tsx';
import threadCss from './-thread.css?url';

// The thread's state pages (/kit/<key>), registered in -states.tsx: the comment tree (folds, the
// permalink's focus, signed out), its tombstones, a deep branch, the docked reply and the post's pill
// row. Sample content is invented; the pieces' words come from the area's catalogues.

/** A sample that takes the gallery row's width, with the styles its pieces need beyond the app's own. */
function Sample({ className, styles = [], children }: { className: string; styles?: string[]; children: ReactNode }) {
  return (
    <div className={className}>
      {[threadCss, ...styles].map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {children}
    </div>
  );
}

const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

/** One sample's comments, with ids of its own: the same tree drawn for several states keeps every id unique. */
function comments(
  prefix: string,
  rows: [id: string, parent: string | null, html: string | null, extra?: Partial<CommentView>][],
): CommentView[] {
  const id = (key: string) => `${prefix}-${key}`;
  const replies = (key: string): number =>
    rows.filter(([, parent]) => parent === key).reduce((sum, [child]) => sum + 1 + replies(child), 0);
  return rows.map(([key, parent, html, extra = {}]) => ({
    id: id(key),
    apId: `https://feddit.test/comment/${id(key)}`,
    postId: posts.link.id,
    parentId: parent && id(parent),
    depth: 0,
    contentHtml: html,
    author: people.kofi,
    authorBadge: null,
    publishedAt: ago(2),
    editedAt: null,
    deleted: false,
    removed: false,
    counts: { upvotes: 12, downvotes: 0, comments: replies(key) },
    myVote: 0,
    ...extra,
  }));
}

const op: Partial<CommentView> = { author: people.jun };

const tree = (prefix: string) =>
  comments(prefix, [
    [
      'a',
      null,
      '<p>OP here. Short version: <strong>Lock</strong> moves to its own activity.</p>',
      { ...op, counts: { upvotes: 214, downvotes: 0, comments: 2 } },
    ],
    ['b', 'a', '<p>Pinned the test checklist in the sidebar.</p>', { author: people.mira, authorBadge: 'moderator', myVote: 1 }],
    ['c', 'b', '<p>Mbin already accepts both forms.</p>'],
    ['d', null, '<p>Buy followers cheap.</p>', { counts: { upvotes: 0, downvotes: 9, comments: 1 } }],
    ['e', 'd', '<p>Reported.</p>', { author: people.mira }],
    ['f', null, '<p>Edited once, to fix a link.</p>', { author: people.andrew, editedAt: ago(1) }],
  ]);

const tombstones = (prefix: string) =>
  comments(prefix, [
    ['r', null, null, { removed: true }],
    ['r1', 'r', '<p>A reply under a removed comment stays.</p>', op],
    ['x', null, null, { deleted: true }],
    ['x1', 'x', '<p>A reply under a deleted comment stays.</p>'],
    ['k', null, null, { blocked: true }],
    ['k1', 'k', '<p>A reply under a blocked person’s comment stays.</p>', op],
  ]);

/** Eight levels, the last with replies of its own on its own page. */
const deep = (prefix: string) =>
  comments(
    prefix,
    Array.from({ length: 8 }, (_, level) => [
      `l${level}`,
      level === 0 ? null : `l${level - 1}`,
      `<p>Level ${level + 1}: a reply long enough to wrap twice at a phone’s width, so the measure shows.</p>`,
      { author: level % 2 ? people.jun : people.kofi, counts: { upvotes: 3, downvotes: 0, comments: 9 - level } },
    ]),
  );

function Tree({ list, signedOut, focusId, maxDepth }: { list: CommentView[]; signedOut?: boolean; focusId?: string; maxDepth?: number }) {
  const { locale } = useTranslate();
  return (
    <Sample className="kit-tree">
      <CommentThread
        comments={list}
        postAuthorId={people.jun.id}
        continueHref={(comment) => commentPath(posts.link.id, comment.id)}
        authorHref={(comment) => userPath(comment.author)}
        labels={useTreeLabels()}
        locale={locale}
        now={now}
        voteDisabled={signedOut}
        onVote={() => undefined}
        linkOf={(comment) => new URL(commentPath(posts.link.id, comment.id), window.location.origin).href}
        {...(!signedOut && { onReply: () => undefined })}
        {...(focusId && { focusId })}
        {...(maxDepth && { maxDepth })}
      />
    </Sample>
  );
}

function Dock({ target, pending, error }: { target?: boolean; pending?: boolean; error?: boolean }) {
  const { t } = useTranslate();
  const kofi: ActorRef = people.kofi;
  return (
    <Sample className="kit-dock th-thread" styles={[commentsCss]}>
      <ReplyBar
        target={target ? { handle: `@${kofi.handle}`, excerpt: 'Mbin already accepts both forms.' } : null}
        labels={useReplyBarLabels()}
        onSubmit={() => undefined}
        onPostInstead={() => undefined}
        onCancel={() => undefined}
        pending={pending}
        {...(error && { error: t('comments', 'error.invalid') })}
      />
    </Sample>
  );
}

function Locked() {
  const { t } = useTranslate();
  return (
    <Sample className="kit-dock th-thread" styles={[commentsCss]}>
      <ReplyNotice className="th-notice" icon={<LockIcon />}>
        {t('comments', 'reply.locked')}
      </ReplyNotice>
    </Sample>
  );
}

function Pills({ voted, signedOut }: { voted?: boolean; signedOut?: boolean }) {
  return (
    <Sample className="kit-pills" styles={[postCss]}>
      <PostPills post={{ ...posts.link, myVote: voted ? 1 : 0 }} onVote={() => undefined} voteDisabled={signedOut ?? false} share />
    </Sample>
  );
}

/** The thread's compositions, spread into `compositions`. */
export const threadPieces: Readonly<Record<string, Composition>> = {
  'comment-tree': {
    name: 'Comment tree',
    states: {
      rest: () => <Tree list={tree('rest')} />,
      // A permalink page's comment, the one it starts from: current.
      selected: () => <Tree list={tree('selected')} focusId="selected-a" />,
      disabled: () => <Tree list={tree('disabled')} signedOut />,
    },
  },
  'comment-tombstones': {
    name: 'Comment tree, tombstones',
    states: { rest: () => <Tree list={tombstones('rest')} /> },
  },
  'comment-deep': {
    name: 'Comment tree, eight levels',
    states: { rest: () => <Tree list={deep('rest')} maxDepth={8} /> },
  },
  'reply-dock': {
    name: 'Docked reply',
    states: {
      rest: () => <Dock />,
      // Answering a comment.
      selected: () => <Dock target />,
      // Where the dock would be on a locked post.
      disabled: Locked,
      pending: () => <Dock target pending />,
      invalid: () => <Dock error />,
    },
  },
  'post-pills': {
    name: 'Post pills',
    states: {
      rest: () => <Pills />,
      selected: () => <Pills voted />,
      disabled: () => <Pills signedOut />,
    },
  },
};
