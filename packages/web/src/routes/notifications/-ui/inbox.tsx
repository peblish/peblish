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
import { useState, type FormEvent } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { commentPath, communityPath, modlogEntryPath, postPath } from '../../../shell/paths.ts';
import { ViewHeader } from '../../../shell/view-header.tsx';
import { asCommentError, errorKey, type CommentError } from '../../post/$id/comments/-ui/errors.ts';
import type { InboxData } from '../-load.ts';
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
 * The page's title: the h1 and, beside it, the unread count. It heads the page rather than the view
 * header, whose title stays quiet: beside a long site name on a phone the bar has no room for it.
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

export function Inbox({ data, search }: { data: InboxData; search: InboxSearch }) {
  const { t } = useTranslate();
  useRouteHydrated();
  if (!data.signedIn)
    return (
      <main className="pb-inbox">
        <ViewHeader root quiet />
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

function SignedInbox({ data, search }: { data: Signed; search: InboxSearch }) {
  const { t } = useTranslate();
  const router = useRouter();
  const [failed, setFailed] = useState<string | null>(null);
  const filter = search.filter ?? 'all';
  const page = { filter, cursor: search.cursor };
  const shownError = failed ?? search.error;
  const errorKey = errorKeys.find((key) => key === shownError);

  // Hydrated, a form posts by fetch and the page reloads its data; before that the browser posts it and follows the 303.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const answer = await post(event.currentTarget.action);
    setFailed('ok' in answer ? null : answer.error === 'network' ? 'generic' : answer.error);
    await router.invalidate();
  }

  return (
    <main className="pb-inbox">
      <ViewHeader
        root
        quiet
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
          <EmptyState title={t('notifications', 'empty')} />
        ) : (
          <ul className="pb-rows pb-notices" aria-label={t('notifications', 'list')}>
            {data.items.map((item) => (
              <NoticeRow key={item.id} item={item} now={data.now} submit={submit} page={page} />
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
}: {
  item: InboxItem;
  now: string;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  page: InboxSearch;
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

  // A reply or mention whose words are still there can be answered in place; a removed or deleted comment cannot.
  const replyable =
    (item.kind === 'reply' || item.kind === 'mention') && target !== null && item.withheld !== 'removed' && item.withheld !== 'deleted';
  const formId = `reply-${item.id}`;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CommentError>();
  const [posted, setPosted] = useState<string | null>(null);
  const backToReply = () =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-controls="${formId}"]`)?.focus({ preventScroll: true }));

  async function sendNow() {
    setPending(true);
    setError(undefined);
    const answer = await sendReply(item, text);
    setPending(false);
    if (!('ok' in answer)) {
      // The text stays in the field, with the refusal under it.
      setError(asCommentError(answer.error) ?? 'generic');
      return;
    }
    if (!item.read) await post(readAction);
    setPosted(answer.id ?? '');
    setText('');
    setOpen(false);
    backToReply();
    await router.invalidate();
  }

  const replyName = t('notifications', 'markFor', { action: t('notifications', 'reply'), actor, subject });
  const replyControl =
    replyable &&
    (hydrated ? (
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
      // Without scripts (and until the page hydrates) Reply leads to the comment, whose page has the reply form.
      <ButtonLink variant="ghost" size="sm" href={target} aria-label={replyName}>
        <CommentsIcon aria-hidden="true" />
        {t('notifications', 'reply')}
      </ButtonLink>
    ));

  return (
    <InboxRow
      unread={!item.read}
      kind={item.kind}
      mark={markOf(item.kind)}
      initial={(neutraliseBidi(item.actor?.handle ?? '', '') || '?').slice(0, 1).toUpperCase()}
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
          <form method="post" action={inboxAction({ intent: item.read ? 'unread' : 'read', id: item.id }, page)} onSubmit={submit}>
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
