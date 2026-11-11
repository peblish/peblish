import type { InboxFilter, InboxItem } from '@peblish/core/notifications/view';
import { filterKinds, inboxFilters, unreadCap } from '@peblish/core/notifications/view';
import { Avatar } from '@peblish/ui/components/avatar';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { commentPath, modlogEntryPath, postPath } from '../../../shell/paths.ts';
import type { InboxData } from '../-load.ts';
import { inboxAction, inboxHref, type InboxSearch } from '../-search.ts';

// The inbox (notifications-list): a header with the unread count and Mark all read, the filter
// tabs with their unread badges, and one row per notice in a Mux Card. Everything is a plain form
// or link, so it works without scripts; once hydrated the forms post by fetch and the page
// reloads its data (router.invalidate), so the sidebar's badge follows. A form's fields ride in
// its action's address (inboxAction), so a row's form holds only its Mux submit Button.

type Signed = Extract<InboxData, { signedIn: true }>;

const badgeText = (count: number) => (count >= unreadCap ? `${unreadCap - 1}+` : String(count));

/** Where the filter links' badges come from: the group's unread count; All and Unread show the total. */
function unreadFor(filter: InboxFilter, inbox: Signed): number {
  if (filter === 'all' || filter === 'unread') return inbox.unread;
  return inbox.unreadByGroup[filter];
}

const errorKeys = ['auth.required', 'auth.site_banned', 'notification.not_yours', 'target.not_found', 'invalid'] as const;

export function Inbox({ data, search }: { data: InboxData; search: InboxSearch }) {
  const { t } = useTranslate();
  useRouteHydrated();
  if (!data.signedIn)
    return (
      <main className="pb-page pb-inbox">
        <Text as="h1" variant="heading" size="md">
          {t('notifications', 'title')}
        </Text>
        <Text as="p">
          {t('notifications', 'signedOut')} <Link href="/auth/sign-in?redirect=%2Fnotifications">{t('notifications', 'signIn')}</Link>
        </Text>
      </main>
    );
  return <SignedInbox data={data} search={search} />;
}

function SignedInbox({ data, search }: { data: Signed; search: InboxSearch }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const [failed, setFailed] = useState<string | null>(null);
  const filter = search.filter ?? 'all';
  const page = { filter, cursor: search.cursor };
  const shownError = failed ?? search.error;
  const errorKey = errorKeys.find((key) => key === shownError);

  // Hydrated, a form posts by fetch and the page reloads its data; before that the browser posts it and follows the 303.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(event.currentTarget.action, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    if (response.ok) setFailed(null);
    else setFailed(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? 'generic');
    await router.invalidate();
  }

  return (
    <main className="pb-page pb-inbox">
      <div className="pb-inbox__head">
        <Text as="h1" variant="heading" size="md">
          {t('notifications', 'title')}
        </Text>
        <Text color="muted">
          {data.unread > 0 ? translatePlural(locale, 'notifications', 'unread', data.unread) : t('notifications', 'allRead')}
        </Text>
        <form method="post" action={inboxAction({ intent: 'read_all' }, page)} onSubmit={submit} className="pb-inbox__all">
          <Button type="submit" variant="neutral" size="sm" disabled={data.unread === 0}>
            {t('notifications', 'markAllRead')}
          </Button>
        </form>
      </div>
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
        <Card.Root variant="outlined" padding="sm" className="pb-inbox__card">
          <ul className="pb-inbox__list" aria-label={t('notifications', 'list')}>
            {data.items.map((item) => (
              <NoticeRow key={item.id} item={item} now={data.now} submit={submit} page={page} />
            ))}
          </ul>
        </Card.Root>
      )}
      <Pager
        aria-label={t('notifications', 'pages')}
        next={data.next ? { href: inboxHref({ filter, cursor: data.next }), label: t('notifications', 'older') } : undefined}
      />
    </main>
  );
}

function NoticeRow({
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
  const moderator = filterKinds.content.some((kind) => kind === item.kind) || filterKinds.account.some((kind) => kind === item.kind);
  const target = item.postId ? (item.commentId ? commentPath(item.postId, item.commentId) : postPath(item.postId)) : null;
  const where = item.about ?? 'post';
  const community = item.community ? <Handle prefix="!" handle={item.community.handle} /> : null;

  const account = item.kind === 'ban' || item.kind === 'unban';
  const handle = item.community ? `!${item.community.handle}` : '';
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

  return (
    <li className="pb-notice" data-read={item.read ? '' : undefined} data-kind={item.kind}>
      {/* Decorative: the handle beside it names the person. */}
      <Avatar.Root size="sm" aria-hidden="true" className="pb-notice__avatar">
        <Avatar.Fallback>{(item.actor?.handle ?? '?').slice(0, 1).toUpperCase()}</Avatar.Fallback>
      </Avatar.Root>
      <div className="pb-notice__body">
        <div className="pb-notice__meta">
          <Badge tone={moderator ? 'moderator' : 'neutral'}>{t('notifications', `type.${item.kind}`)}</Badge>
          <Text size="sm" color="muted">
            <Time iso={item.createdAt} locale={locale} now={new Date(now)} />
          </Text>
        </div>
        <Text as="p" className="pb-notice__text">
          {!item.read && <span className="pb-sr">{t('notifications', 'unread.hidden')} </span>}
          <strong>{item.actor ? <Handle prefix="@" handle={item.actor.handle} /> : t('notifications', 'actor.unknown')}</strong>
          {moderator && (
            <>
              {' '}
              <Badge tone="moderator">{t('notifications', 'mark.mod')}</Badge>
            </>
          )}{' '}
          {sentence}
          {!account && (
            <>
              {' '}
              {target && <Link href={target}>{item.postTitle ?? t('notifications', 'open')}</Link>}
              {community && (
                <Text color="muted">
                  {' '}
                  {t('notifications', 'in')} {community}
                </Text>
              )}
            </>
          )}
        </Text>
        {item.withheld ? (
          <Text as="p" size="sm" color="muted" className="pb-notice__excerpt">
            {t('notifications', `withheld.${item.withheld}`)}
          </Text>
        ) : (
          item.excerpt && (
            <Text as="p" size="sm" color="muted" className="pb-notice__excerpt">
              {item.excerpt}
            </Text>
          )
        )}
        {item.statement && (
          <Text as="p" size="sm">
            {item.statement.reasonWithheld
              ? t('notifications', 'reason.withheld')
              : item.statement.reason && t('notifications', 'reason', { reason: item.statement.reason })}
            {/* The modlog shows the entry to the person it is about, public or not. */}{' '}
            <Link href={modlogEntryPath(item.statement.modlogId)}>{t('notifications', 'statement')}</Link>
          </Text>
        )}
      </div>
      <form method="post" action={inboxAction({ intent: item.read ? 'unread' : 'read', id: item.id }, page)} onSubmit={submit}>
        <Button type="submit" variant="ghost" size="sm">
          {t('notifications', item.read ? 'markUnread' : 'markRead')}
        </Button>
      </form>
    </li>
  );
}
