import type { InboxFilter, InboxItem } from '@peblish/core/notifications/view';
import { filterKinds, inboxFilters, unreadCap } from '@peblish/core/notifications/view';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { BidiText, Handle, neutraliseBidi } from '@peblish/ui/components/handle';
import { CheckCheckIcon, CommentsIcon } from '@peblish/ui/components/icons';
import { InboxReply, InboxRow, type InboxMark } from '@peblish/ui/components/inbox-row';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { Quote } from '@peblish/ui/components/quote';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { useHydrated } from '@peblish/ui/composer/use-hydrated.ts';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { commentPath, communityPath, inboxPath, modlogEntryPath, postPath } from '../../../shell/paths.ts';
import { useHeadingInView, ViewHeader } from '../../../shell/view-header.tsx';
import { asCommentError, errorKey, type CommentError } from '../../post/$id/comments/-ui/errors.ts';
import type { InboxData, InboxNotice } from '../-load.ts';
import { inboxAction, inboxHref, type InboxSearch } from '../-search.ts';

// The inbox (notifications-list), in Commons' layout: its own view header holding Mark all read, the
// title with the unread count, the filter tabs with their unread badges, and one InboxRow per notice. Everything is a
// plain form or link, so it works without scripts; once hydrated the forms post by fetch and the page
// reloads its data (router.invalidate), so the header's badge follows. A form's fields ride in its
// action's address (inboxAction), so a row's form holds only its Mux submit Button. A reply or mention
// can be answered in place, through the comment form's endpoint (post/$id/comments/-form.ts).

type Signed = Extract<InboxData, { signedIn: true }>;

const badgeText = (count: number) => (count >= unreadCap ? `${unreadCap - 1}+` : String(count));

/** Where the filter links' badges come from: the group's unread count; All and Unread show the total. */
function unreadFor(filter: InboxFilter, inbox: Signed): number {
  if (filter === 'all' || filter === 'unread') return inbox.unread;
  return inbox.unreadByGroup[filter];
}

const errorKeys = ['auth.required', 'auth.site_banned', 'notification.not_yours', 'target.not_found', 'invalid'] as const;

/**
 * The page's title: the h1 and, beside it, the unread count. It heads the page; the view header shows the
 * page's name once the h1 has scrolled under it (InboxHeader).
 */
function Title({ unread }: { unread?: number }) {
  const { t, locale } = useTranslate();
  return (
    <div className="pb-inbox__name">
      <Text as="h1" variant="heading" size="sm" className="pb-inbox__h1">
        {t('notifications', 'title')}
      </Text>
      {unread !== undefined && (
        <Text size="sm" color="muted">
          {unread > 0 ? translatePlural(locale, 'notifications', 'unread', unread) : t('notifications', 'allRead')}
        </Text>
      )}
    </div>
  );
}

/** The inbox's view header: its name, once the page's h1 has scrolled under it, and `trailing`. */
function InboxHeader({ trailing }: { trailing?: ReactNode }) {
  const { t } = useTranslate();
  const quiet = useHeadingInView(inboxPath);
  return (
    <ViewHeader
      root
      quiet={quiet}
      title={
        <Text variant="label" truncate className="pb-frame-vh__title">
          {t('notifications', 'title')}
        </Text>
      }
      trailing={trailing}
    />
  );
}

export function Inbox({ data, search }: { data: InboxData; search: InboxSearch }) {
  const { t } = useTranslate();
  useRouteHydrated();
  if (!data.signedIn)
    return (
      <main className="pb-inbox">
        <InboxHeader />
        <div className="pb-page pb-inbox__body">
          <Title />
          <EmptyState
            title={t('notifications', 'signedOut')}
            action={
              <ButtonLink variant="primary" href="/auth/sign-in?redirect=%2Fnotifications">
                {t('notifications', 'signIn')}
              </ButtonLink>
            }
          />
        </div>
      </main>
    );
  return <SignedInbox data={data} search={search} />;
}

/** Inbox posts answer `{ ok }` or `{ error }` (-form.ts); the comment form adds the new comment's id. */
const Answer = type({ ok: 'true', 'id?': 'string' }).or({ error: 'string' });

/** A POST by fetch to one of the page's form addresses, read as JSON; a network failure or an unreadable answer is `network`. */
async function post(action: string, body = '', keepalive = false): Promise<{ ok: true; id?: string } | { error: string }> {
  try {
    const response = await fetch(action, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      keepalive,
    });
    const answer = Answer(await response.json());
    return answer instanceof type.errors ? { error: 'network' } : answer;
  } catch {
    return { error: 'network' };
  }
}

/** The list's empty state, which takes focus when the last row it was in leaves (keepFocus). */
const emptyId = 'pb-inbox-empty';

/**
 * Keeps focus in the list when the row holding it leaves (the Unread filter drops a notice once it is read). Call it
 * before the change: null when focus is not in `row`. Run what it returns once the reloaded list is drawn: if the row
 * has gone and focus went with it, the nearest notice after it that is still listed takes focus on its Mark read or
 * unread button, else the nearest one before it, else the list's first row, else the empty state. The notices are
 * followed by their rows' elements, which React keeps for as long as their notice (each row's key) is listed, so a
 * notice that came in meanwhile does not take the place. Focus that moved on in the meantime stays there.
 */
function keepFocus(row: Element | null | undefined): (() => void) | null {
  const list = row?.parentElement;
  if (!row || !list || !row.contains(document.activeElement)) return null;
  const rows = [...list.children];
  const at = rows.indexOf(row);
  const nearest = [...rows.slice(at + 1), ...rows.slice(0, at).reverse()];
  return () => {
    if (row.isConnected || (document.activeElement !== null && document.activeElement !== document.body)) return;
    const successor = list.isConnected ? (nearest.find((other) => other.parentElement === list) ?? list.firstElementChild) : null;
    (successor ? successor.querySelector<HTMLElement>('form[data-toggle] button') : document.getElementById(emptyId))?.focus();
  };
}

function SignedInbox({ data, search }: { data: Signed; search: InboxSearch }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [failed, setFailed] = useState<string | null>(null);
  const filter = search.filter ?? 'all';
  const page = { filter, cursor: search.cursor };
  const shownError = failed ?? search.error;
  const errorKey = errorKeys.find((key) => key === shownError);

  // What keepFocus returned for the reload on its way. The reloaded notices are drawn after router.invalidate()
  // resolves (the loader runs again in the background), so it runs once they are.
  const settle = useRef<(() => void) | null>(null);
  const afterReload = (keep: () => void) => {
    settle.current = keep;
  };
  useLayoutEffect(() => {
    const keep = settle.current;
    settle.current = null;
    keep?.();
  }, [data.items]);

  // Hydrated, a form posts by fetch and the page reloads its data; before that the browser posts it and follows the 303.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keep = keepFocus(event.currentTarget.closest('li'));
    const answer = await post(event.currentTarget.action);
    setFailed('ok' in answer ? null : answer.error === 'network' ? 'generic' : answer.error);
    if (keep) afterReload(keep);
    await router.invalidate();
  }

  return (
    <main className="pb-inbox">
      <InboxHeader
        trailing={
          <form method="post" action={inboxAction({ intent: 'read_all' }, page)} onSubmit={submit} className="pb-inbox__all">
            {/* On a phone its name gives way to its icon (inbox.css); the name stays for assistive technology. */}
            <Button type="submit" variant="ghost" size="sm" disabled={data.unread === 0}>
              <CheckCheckIcon aria-hidden="true" />
              <Text className="pb-inbox__all-label">{t('notifications', 'markAllRead')}</Text>
            </Button>
          </form>
        }
      />
      <div className="pb-page pb-inbox__body">
        <Title unread={data.unread} />
        {shownError !== undefined && (
          <Notice tone="danger" role="alert">
            {t('notifications', errorKey ? `error.${errorKey}` : 'error.generic')}
          </Notice>
        )}
        <LinkTabs
          aria-label={t('notifications', 'filters')}
          items={inboxFilters.map((key) => {
            const unread = unreadFor(key, data);
            return {
              to: inboxHref({ filter: key }),
              active: key === filter,
              label: (
                <>
                  {t('notifications', `filter.${key}`)}
                  {unread > 0 && (
                    <>
                      {' '}
                      <Badge tone="brand" role="img" aria-label={t('notifications', 'filter.badge', { count: badgeText(unread) })}>
                        {badgeText(unread)}
                      </Badge>
                    </>
                  )}
                </>
              ),
            };
          })}
        />
        {data.items.length === 0 ? (
          // Focusable by script only: it takes focus when the last notice it was on leaves the list (keepFocus).
          <EmptyState id={emptyId} tabIndex={-1} title={t('notifications', 'empty')} />
        ) : (
          <ul className="pb-rows pb-notices" aria-label={t('notifications', 'list')}>
            {data.items.map((item) => (
              <NoticeRow key={item.id} item={item} now={data.now} submit={submit} page={page} afterReload={afterReload} />
            ))}
          </ul>
        )}
        <Pager
          aria-label={t('notifications', 'pages')}
          next={data.next ? { href: inboxHref({ filter, cursor: data.next }), label: t('notifications', 'older') } : undefined}
        />
      </div>
    </main>
  );
}

const moderatorKinds: readonly string[] = [...filterKinds.content, ...filterKinds.account];

const markOf = (kind: InboxItem['kind']): InboxMark =>
  kind === 'reply' || kind === 'mention' || kind === 'ban' || kind === 'unban' ? kind : 'moderator';

/** Sends a reply to the notice's comment (or post) through the comment form; `id` is the new comment's. */
const sendReply = (item: InboxItem, body: string) =>
  post(`/post/${item.postId}/comments`, new URLSearchParams({ intent: 'reply', parent: item.commentId ?? '', body }).toString());

/** One notice, with its actions and, for a reply or a mention, its reply in place. */
export function NoticeRow({
  item,
  now,
  submit,
  page,
  afterReload,
}: {
  item: InboxNotice;
  now: string;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  page: InboxSearch;
  /** Runs `keep` once the inbox's reloaded notices are drawn; without it (the gallery, whose rows stay) focus is left as it is. */
  afterReload?: (keep: () => void) => void;
}) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const hydrated = useHydrated();
  const moderator = moderatorKinds.includes(item.kind);
  const target = item.postId ? (item.commentId ? commentPath(item.postId, item.commentId) : postPath(item.postId)) : null;
  const where = item.about ?? 'post';
  const community = item.community ? <Handle prefix="!" handle={item.community.handle} /> : null;

  const account = item.kind === 'ban' || item.kind === 'unban';
  // The ban sentences print the community's handle as plain text: drop any directional controls a remote one carries.
  const handle = item.community ? `!${neutraliseBidi(item.community.handle)}` : '';
  // The buttons' names below are plain text too: the handle and the title lose their directional controls, as Handle shows them.
  const actor = item.actor ? `@${neutraliseBidi(item.actor.handle)}` : t('notifications', 'actor.unknown');
  const subject = item.postTitle ? neutraliseBidi(item.postTitle) : handle || t('notifications', `type.${item.kind}`);
  const sentence = (() => {
    switch (item.kind) {
      case 'reply':
        return t('notifications', `verb.reply.${item.replyTo ?? 'post'}`);
      case 'mention':
        return t('notifications', `verb.mention.${where}`);
      case 'mod_remove':
        return t('notifications', `verb.mod_remove.${where}`);
      case 'mod_restore':
        return t('notifications', `verb.mod_restore.${where}`);
      case 'ban':
        return item.community ? t('notifications', 'verb.ban.community', { community: handle }) : t('notifications', 'verb.ban.site');
      case 'unban':
        return item.community ? t('notifications', 'verb.unban.community', { community: handle }) : t('notifications', 'verb.unban.site');
    }
  })();

  const toggle = t('notifications', item.read ? 'markUnread' : 'markRead');
  const readAction = inboxAction({ intent: 'read', id: item.id }, page);
  // Opening an unread notice's post marks it read, as a press on its own button does; the page goes on regardless.
  const markOnOpen = () => {
    if (!item.read && hydrated) void post(readAction, '', true);
  };

  // Where Reply leads: a reply's or mention's comment (or post), unless it was removed or deleted since. Only one whose words are
  // shown is answered in place; a sensitive one is withheld here for every viewer, so Reply leads to its thread, which applies the gate.
  const replyTarget =
    (item.kind === 'reply' || item.kind === 'mention') && item.withheld !== 'removed' && item.withheld !== 'deleted' ? target : null;
  const replyable = replyTarget !== null && item.withheld === null;
  const formId = `reply-${item.id}`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CommentError>();
  const [posted, setPosted] = useState<string | null>(null);
  // Back to Reply once the field has closed, unless focus left the row before the frame came (a Tab, a press elsewhere).
  const backToReply = () =>
    requestAnimationFrame(() => {
      const reply = document.querySelector<HTMLElement>(`[aria-controls="${formId}"]`);
      const now = document.activeElement;
      if (now !== null && now !== document.body && !reply?.closest('li')?.contains(now)) return;
      reply?.focus({ preventScroll: true });
    });

  // One lock from the press until the comment is saved and the notice marked read: Send stays pending and the field read-only throughout.
  // The ref takes it at once, for a second submit that comes before React has drawn `pending`.
  const sending = useRef(false);
  async function sendNow() {
    if (sending.current) return;
    sending.current = true;
    const body = text;
    let keep: (() => void) | null = null;
    setPending(true);
    setError(undefined);
    try {
      const answer = await sendReply(item, body);
      if (!('ok' in answer)) {
        // The text stays in the field, with the refusal under it.
        setError(asCommentError(answer.error) ?? 'generic');
        return;
      }
      if (!item.read) await post(readAction);
      setPosted(answer.id ?? '');
      // Only what was sent clears.
      setText((current) => (current === body ? '' : current));
      // Back to Reply only while focus is still in the row: closing the field drops it, and a reader who moved on keeps their place.
      keep = keepFocus(document.getElementById(formId)?.closest('li'));
      setOpen(false);
      if (keep) backToReply();
    } finally {
      sending.current = false;
      setPending(false);
    }
    if (keep) afterReload?.(keep);
    await router.invalidate();
  }

  const replyName = t('notifications', 'markFor', { action: t('notifications', 'reply'), actor, subject });
  const replyControl =
    replyTarget !== null &&
    (replyable && hydrated ? (
      <Button
        variant="ghost"
        size="sm"
        aria-label={replyName}
        aria-expanded={open}
        aria-controls={formId}
        onActivate={() => {
          setPosted(null);
          // Open and empty, Reply closes the field again; holding text, it stays open and takes focus.
          if (open && text.trim() === '') return setOpen(false);
          setOpen(true);
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`#${formId} textarea`)?.focus());
        }}
      >
        <CommentsIcon aria-hidden="true" />
        {t('notifications', 'reply')}
      </Button>
    ) : (
      // Without scripts (and until the page hydrates), and for a sensitive notice, Reply leads to the comment, whose page has the reply form.
      <ButtonLink variant="ghost" size="sm" href={replyTarget} aria-label={replyName}>
        <CommentsIcon aria-hidden="true" />
        {t('notifications', 'reply')}
      </ButtonLink>
    ));

  return (
    <InboxRow
      unread={!item.read}
      kind={item.kind}
      mark={markOf(item.kind)}
      initial={item.initial}
      headline={
        <>
          {!item.read && (
            <Text as="span" className="pb-sr">
              {t('notifications', 'unread.hidden')}{' '}
            </Text>
          )}
          <Text variant="label" className="pb-notice__actor">
            {item.actor ? <Handle prefix="@" handle={item.actor.handle} /> : t('notifications', 'actor.unknown')}
          </Text>
          {moderator && (
            <>
              {' '}
              <Badge tone="moderator">{t('notifications', 'mark.mod')}</Badge>
            </>
          )}{' '}
          {sentence}
        </>
      }
      age={<Time iso={item.createdAt} locale={locale} now={new Date(now)} />}
      context={
        !account &&
        (target || community) && (
          <>
            {target && (
              <Link href={target} onActivate={markOnOpen}>
                {item.postTitle !== null ? <BidiText text={item.postTitle} /> : t('notifications', 'open')}
              </Link>
            )}
            {community && (
              <>
                {' '}
                {t('notifications', 'in')} {community}
              </>
            )}
          </>
        )
      }
      actions={
        <>
          {replyControl}
          <form
            method="post"
            action={inboxAction({ intent: item.read ? 'unread' : 'read', id: item.id }, page)}
            onSubmit={submit}
            data-toggle=""
          >
            {/* Every row has one: the name says whose notice about what ("Mark read: @ada, Her post"); the visible text stays short. */}
            <Button type="submit" variant="ghost" size="sm" aria-label={t('notifications', 'markFor', { action: toggle, actor, subject })}>
              {toggle}
            </Button>
          </form>
        </>
      }
      reply={
        <>
          {replyable && open && (
            <InboxReply
              id={formId}
              labels={{
                field: t('notifications', 'reply.field', { actor }),
                send: t('notifications', 'reply'),
                cancel: t('notifications', 'reply.cancel'),
              }}
              value={text}
              onChange={setText}
              onSubmit={() => void sendNow()}
              onCancel={() => {
                setOpen(false);
                backToReply();
              }}
              action={`/post/${item.postId}/comments?${new URLSearchParams({ intent: 'reply', parent: item.commentId ?? '' })}`}
              pending={pending}
              error={error && t('comments', errorKey(error))}
            />
          )}
          {replyable && (
            <Text as="p" size="sm" role="status" className="pb-notice__posted">
              {posted !== null && (
                <>
                  {t('notifications', 'reply.posted')}{' '}
                  {posted && item.postId && <Link href={commentPath(item.postId, posted)}>{t('notifications', 'reply.view')}</Link>}
                </>
              )}
            </Text>
          )}
        </>
      }
    >
      {item.withheld ? (
        <Text as="p" size="sm" color="muted" className="pb-notice__note">
          {t('notifications', `withheld.${item.withheld}`)}
        </Text>
      ) : (
        item.excerpt && (
          <Quote size="sm" className="pb-notice__quote">
            {item.excerpt}
          </Quote>
        )
      )}
      {item.statement && (item.statement.reasonWithheld || item.statement.reason) && (
        <Quote edge size="sm" className="pb-notice__reason">
          {item.statement.reasonWithheld
            ? t('notifications', 'reason.withheld')
            : t('notifications', 'reason', { reason: item.statement.reason ?? '' })}
        </Quote>
      )}
      {(item.statement || (moderator && item.community)) && (
        <Text as="p" size="sm" className="pb-notice__links">
          {/* The modlog shows the entry to the person it is about, public or not. */}
          {item.statement && <Link href={modlogEntryPath(item.statement.modlogId)}>{t('notifications', 'statement')}</Link>}
          {moderator && item.community && (
            <Link href={communityPath(item.community)}>{t('notifications', 'rules', { community: handle })}</Link>
          )}
        </Text>
      )}
    </InboxRow>
  );
}
