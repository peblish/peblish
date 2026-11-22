import type { InboxItem } from '@peblish/core/notifications/view';
import { Button } from '@peblish/ui/components/button';
import { InboxReply, InboxRow } from '@peblish/ui/components/inbox-row';
import { Link } from '@peblish/ui/components/link';
import { Quote } from '@peblish/ui/components/quote';
import { Text } from '@peblish/ui/components/text';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import { NoticeGroups } from '../notifications/-ui/groups.tsx';
import { NoticeRow } from '../notifications/-ui/inbox.tsx';
import { MarkedStatus } from '../notifications/-ui/marked.tsx';
import { FollowBellButton, FollowSwitchControl } from '../post/-ui/follow-thread.tsx';
import { communities, now, people } from './-samples.ts';
import type { Composition } from './-states.tsx';

// The inbox's state pages (/kit/<key>), registered in -states.tsx: every kind of notice as the inbox
// draws it (NoticeRow, its real row, whose forms post to the real endpoints: a spec answers for them),
// and InboxRow's inline reply in each of its states; then the date groups, Mark all read's status row
// with its Undo, and the post's Follow thread bell and rail switch (lane f-notify). Sample content is
// invented; the words come from the notifications and watches catalogues.

const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const person = (ref: (typeof people)[keyof typeof people]) => ({ ...ref, displayName: null });

const base: Omit<InboxItem, 'id' | 'kind'> = {
  read: false,
  createdAt: ago(2),
  actor: person(people.jun),
  community: person(communities.art),
  postId: id(100),
  commentId: id(200),
  postTitle: 'Weekly prompt: a window at night',
  about: 'comment',
  replyTo: 'post',
  withheld: null,
  excerpt: 'The reflections in the glass are lovely. Did you work from a photo or from life?',
  statement: null,
};

const statement = { modlogId: id(300), reason: 'Rule 2: no self-promotion', reasonWithheld: false, public: true };

/** One of each kind the inbox knows, some read. */
export const notices: readonly InboxItem[] = [
  { ...base, id: id(1), kind: 'reply' },
  { ...base, id: id(2), kind: 'reply', replyTo: 'comment', actor: person(people.mira), read: true, createdAt: ago(5) },
  { ...base, id: id(3), kind: 'mention', actor: person(people.kofi), excerpt: 'Ask @andrew, he did the charcoal one last week.' },
  {
    ...base,
    id: id(4),
    kind: 'mod_remove',
    actor: person(people.mira),
    excerpt: null,
    statement,
    createdAt: ago(26),
  },
  { ...base, id: id(5), kind: 'mod_restore', actor: person(people.mira), statement: { ...statement, reason: null }, read: true },
  {
    ...base,
    id: id(6),
    kind: 'ban',
    actor: null,
    postId: null,
    commentId: null,
    postTitle: null,
    about: null,
    replyTo: null,
    excerpt: null,
    statement: { ...statement, reason: 'Repeated spam', public: false },
    createdAt: ago(80),
  },
  {
    ...base,
    id: id(7),
    kind: 'unban',
    actor: person(people.mira),
    community: null,
    postId: null,
    commentId: null,
    postTitle: null,
    about: null,
    replyTo: null,
    excerpt: null,
    statement: { ...statement, reason: null, reasonWithheld: true },
    read: true,
    createdAt: ago(200),
  },
  { ...base, id: id(8), kind: 'reply', actor: person(people.kofi), withheld: 'sensitive', excerpt: null, postTitle: null },
  {
    ...base,
    id: id(9),
    kind: 'thread_reply',
    actor: person(people.mira),
    replyTo: null,
    excerpt: 'I tried this with a torch held low. The shadows go long.',
  },
  // A followed thread's sensitive comment, withheld in the inbox from every reader: nobody is named and no comment
  // is linked. (One removed or deleted since is not listed at all: notifications/visible.ts.)
  {
    ...base,
    id: id(10),
    kind: 'thread_reply',
    actor: null,
    commentId: null,
    replyTo: null,
    withheld: 'sensitive',
    excerpt: null,
    read: true,
    createdAt: ago(30),
  },
  {
    ...base,
    id: id(11),
    kind: 'follow_accept',
    actor: null,
    postId: null,
    commentId: null,
    postTitle: null,
    about: null,
    replyTo: null,
    excerpt: null,
  },
];

/** The published review address of the samples: a removal's "Ask for a review" mails it. */
const contact = 'review@example.test';

const stay = (event: FormEvent<HTMLFormElement>) => event.preventDefault();

/** Rows of the inbox's own NoticeRow, a few at a time, so each page's sample fits a phone's screen. */
function Notices({ items }: { items: readonly InboxItem[] }) {
  const { t } = useTranslate();
  return (
    <ul className="pb-notices" aria-label={t('notifications', 'list')}>
      {items.map((item) => (
        <NoticeRow key={item.id} item={item} now={now.toISOString()} submit={stay} page={{}} contact={contact} />
      ))}
    </ul>
  );
}

/**
 * InboxRow with its reply in one state: closed (rest), open (selected), sending (pending) or refused with
 * the text kept (invalid). The row is the reply notice's, its words from the catalogue.
 */
function Replying({ state }: { state: 'rest' | 'selected' | 'pending' | 'invalid' }) {
  const { t } = useTranslate();
  const [text, setText] = useState(state === 'rest' || state === 'selected' ? '' : 'From life, at the kitchen table.');
  const open = state !== 'rest';
  const actor = '@jun@lemmy.world';
  return (
    <ul className="pb-notices" aria-label={`${t('notifications', 'list')}, ${state}`}>
      <InboxRow
        unread
        mark="reply"
        initial="J"
        kind="reply"
        headline={
          <>
            <Text as="span" className="pb-sr">
              {t('notifications', 'unread.hidden')}{' '}
            </Text>
            <Text variant="label" className="pb-notice__actor">
              {actor}
            </Text>{' '}
            {t('notifications', 'verb.reply.post')}
          </>
        }
        age="2h"
        context={
          <>
            <Link href="/post/kit-inbox">{base.postTitle}</Link> {t('notifications', 'in')} !art
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={open ? `kit-reply-${state}` : undefined}>
              {t('notifications', 'reply')}
            </Button>
            <Button variant="ghost" size="sm">
              {t('notifications', 'markRead')}
            </Button>
          </>
        }
        reply={
          open && (
            <InboxReply
              id={`kit-reply-${state}`}
              labels={{
                field: t('notifications', 'reply.field', { actor }),
                send: t('notifications', 'reply'),
                cancel: t('notifications', 'reply.cancel'),
              }}
              value={text}
              onChange={setText}
              onSubmit={() => undefined}
              onCancel={() => undefined}
              action="/post/kit-inbox/comments?intent=reply"
              pending={state === 'pending'}
              error={state === 'invalid' ? t('comments', 'error.post.locked') : undefined}
            />
          )
        }
      >
        <Quote size="sm" className="pb-notice__quote">
          {base.excerpt}
        </Quote>
      </InboxRow>
    </ul>
  );
}

/**
 * A page of notices under their date groups: one today, yesterday, this week and earlier. A row's Mark read stands for
 * the reload that follows it in the inbox, which brings the loader's clock: here a day later, so each row but the
 * oldest crosses into the next group, as one does when a reload comes after a boundary has passed.
 */
function Grouped() {
  const [clock, setClock] = useState(now.getTime());
  const at = [2, 30, 80, 200];
  const items = [notices[0]!, notices[3]!, notices[5]!, notices[6]!].map((item, n) => ({ ...item, createdAt: ago(at[n]!) }));
  const iso = new Date(clock).toISOString();
  const reload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setClock((time) => time + 24 * 3_600_000);
  };
  return (
    <NoticeGroups items={items} now={iso} row={(item) => <NoticeRow key={item.id} item={item} now={iso} submit={reload} page={{}} />} />
  );
}

/** Mark all read's status row: Undo at rest or on its way; and, after it, how many came back, or that none was left to. */
function Undo({ pending = false }: { pending?: boolean }) {
  return (
    <>
      <MarkedStatus search={{ marked: 3, batch: 1795000000000001 }} page={{}} pending={pending} onUndo={stay} />
      {!pending && <MarkedStatus search={{ restored: 3 }} page={{}} />}
      {!pending && <MarkedStatus search={{}} page={{}} none />}
    </>
  );
}

/** The post's Follow thread, off, on, or with a change on its way: the view header's bell, or the rail's switch. */
function Follow({ on, pending = false, rail = false }: { on: boolean; pending?: boolean; rail?: boolean }) {
  const postId = id(100);
  return rail ? (
    <FollowSwitchControl postId={postId} on={on} pending={pending} />
  ) : (
    <FollowBellButton postId={postId} on={on} pending={pending} onSubmit={stay} />
  );
}

/** The inbox's compositions, spread into `compositions`. */
export const inboxPieces: Readonly<Record<string, Composition>> = {
  'inbox-replies': { name: 'Inbox, replies', states: { rest: () => <Notices items={notices.slice(0, 2)} /> } },
  'inbox-mentions': {
    name: 'Inbox, a mention and a sensitive reply',
    states: { rest: () => <Notices items={[notices[2]!, notices[7]!]} /> },
  },
  'inbox-moderation': { name: 'Inbox, removed and restored', states: { rest: () => <Notices items={notices.slice(3, 5)} /> } },
  'inbox-account': { name: 'Inbox, a ban and its end', states: { rest: () => <Notices items={notices.slice(5, 7)} /> } },
  'inbox-follows': {
    name: 'Inbox, a followed thread and an accepted follow',
    states: { rest: () => <Notices items={notices.slice(8, 11)} /> },
  },
  'inbox-groups': { name: 'Inbox, date groups', states: { rest: () => <Grouped /> } },
  'inbox-undo': { name: 'Inbox, Mark all read and its Undo', states: { rest: () => <Undo />, pending: () => <Undo pending /> } },
  'thread-follow': {
    name: 'Post, Follow thread bell',
    states: {
      rest: () => <Follow on={false} />,
      selected: () => <Follow on />,
      pending: () => <Follow on pending />,
    },
  },
  'thread-follow-rail': {
    name: 'Post, Follow thread switch in the rail',
    states: {
      rest: () => <Follow rail on={false} />,
      selected: () => <Follow rail on />,
      pending: () => <Follow rail on pending />,
    },
  },
  'inbox-reply': {
    name: 'InboxRow, inline reply',
    states: {
      rest: () => <Replying state="rest" />,
      selected: () => <Replying state="selected" />,
      pending: () => <Replying state="pending" />,
      invalid: () => <Replying state="invalid" />,
    },
  },
};
