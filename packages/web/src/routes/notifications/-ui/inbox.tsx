import type { InboxFilter, InboxItem } from '@peblish/core/notifications/view';
import { filterKinds, inboxFilters, unreadCap } from '@peblish/core/notifications/view';
import { Handle } from '@peblish/ui/components/handle';
import { Time } from '@peblish/ui/components/time';
import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { commentPath, modlogEntryPath, postPath } from '../../../shell/paths.ts';
import type { InboxData } from '../-load.ts';
import { inboxHref, type InboxSearch } from '../-search.ts';

// The inbox (notifications-list): a header with the unread count and Mark all read, the filter
// links with their unread badges, and one row per notice. Everything is a plain form or link,
// so it works without scripts; once hydrated the forms post by fetch and the page reloads its
// data (router.invalidate), so the sidebar's badge follows.

type Signed = Extract<InboxData, { signedIn: true }>;

const badgeText = (count: number) => (count >= unreadCap ? `${unreadCap - 1}+` : String(count));

/** Where the filter links' badges come from: the group's unread count; All and Unread show the total. */
function unreadFor(filter: InboxFilter, inbox: Signed): number {
  if (filter === 'all' || filter === 'unread') return inbox.unread;
  return inbox.unreadByGroup[filter];
}

const errorKeys = ['auth.required', 'notification.not_yours', 'target.not_found', 'invalid'] as const;

export function Inbox({ data, search }: { data: InboxData; search: InboxSearch }) {
  const { t } = useTranslate();
  useRouteHydrated();
  if (!data.signedIn)
    return (
      <main className="pb-inbox">
        <h1>{t('notifications', 'title')}</h1>
        <p>
          {t('notifications', 'signedOut')} <a href="/auth/sign-in?redirect=%2Fnotifications">{t('notifications', 'signIn')}</a>
        </p>
      </main>
    );
  return <SignedInbox data={data} search={search} />;
}

function SignedInbox({ data, search }: { data: Signed; search: InboxSearch }) {
  const { t, locale } = useTranslate();
  const router = useRouter();
  const [failed, setFailed] = useState<string | null>(null);
  const filter = search.filter ?? 'all';
  const shownError = failed ?? search.error;
  const errorKey = errorKeys.find((key) => key === shownError);

  // Hydrated, a form posts by fetch and the page reloads its data; before that the browser posts it and follows the 303.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Array.from(new FormData(form), ([name, value]) => [name, String(value)])),
    });
    if (response.ok) setFailed(null);
    else setFailed(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? 'generic');
    await router.invalidate();
  }

  const hidden = (
    <>
      {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
      {search.cursor && <input type="hidden" name="cursor" value={search.cursor} />}
    </>
  );

  return (
    <main className="pb-inbox">
      <div className="pb-inbox__head">
        <h1>{t('notifications', 'title')}</h1>
        <span>{data.unread > 0 ? translatePlural(locale, 'notifications', 'unread', data.unread) : t('notifications', 'allRead')}</span>
        <form method="post" action="/notifications" onSubmit={submit} className="pb-inbox__all">
          <input type="hidden" name="intent" value="read_all" />
          {hidden}
          <button type="submit" disabled={data.unread === 0}>
            {t('notifications', 'markAllRead')}
          </button>
        </form>
      </div>
      {shownError !== undefined && (
        <p role="alert" className="pb-inbox__error">
          {t('notifications', errorKey ? `error.${errorKey}` : 'error.generic')}
        </p>
      )}
      <nav className="pb-inbox__filters" aria-label={t('notifications', 'filters')}>
        {inboxFilters.map((key) => {
          const unread = unreadFor(key, data);
          return (
            <a key={key} href={inboxHref({ filter: key })} aria-current={key === filter ? 'page' : undefined}>
              {t('notifications', `filter.${key}`)}
              {unread > 0 && (
                <b className="pb-count" role="img" aria-label={t('notifications', 'filter.badge', { count: badgeText(unread) })}>
                  {badgeText(unread)}
                </b>
              )}
            </a>
          );
        })}
      </nav>
      {data.items.length === 0 ? (
        <p className="pb-inbox__empty">{t('notifications', 'empty')}</p>
      ) : (
        <ul className="pb-inbox__list">
          {data.items.map((item) => (
            <Notice key={item.id} item={item} now={data.now} submit={submit} hidden={hidden} />
          ))}
        </ul>
      )}
      {data.next && (
        <p className="pb-inbox__older">
          <a href={inboxHref({ filter, cursor: data.next })} rel="next">
            {t('notifications', 'older')}
          </a>
        </p>
      )}
    </main>
  );
}

function Notice({
  item,
  now,
  submit,
  hidden,
}: {
  item: InboxItem;
  now: string;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  hidden: React.ReactNode;
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
      <span className={moderator ? 'pb-notice__type pb-notice__type--mod' : 'pb-notice__type'}>
        {t('notifications', `type.${item.kind}`)}
      </span>
      <div className="pb-notice__body">
        <p className="pb-notice__text">
          {!item.read && <span className="pb-sr">{t('notifications', 'unread.hidden')} </span>}
          <b>{item.actor ? <Handle prefix="@" handle={item.actor.handle} /> : t('notifications', 'actor.unknown')}</b>
          {moderator && <span className="pb-notice__mark"> {t('notifications', 'mark.mod')}</span>} {sentence}
          {!account && (
            <>
              {' '}
              {target && <a href={target}>{item.postTitle ?? t('notifications', 'open')}</a>}
              {community && (
                <span className="pb-notice__community">
                  {' '}
                  {t('notifications', 'in')} {community}
                </span>
              )}
            </>
          )}
        </p>
        {item.withheld ? (
          <p className="pb-notice__excerpt">{t('notifications', `withheld.${item.withheld}`)}</p>
        ) : (
          item.excerpt && <p className="pb-notice__excerpt">{item.excerpt}</p>
        )}
        {item.statement && (
          <p className="pb-notice__reason">
            {item.statement.reasonWithheld
              ? t('notifications', 'reason.withheld')
              : item.statement.reason && t('notifications', 'reason', { reason: item.statement.reason })}
            {/* The modlog shows the entry to the person it is about, public or not. */}{' '}
            <a href={modlogEntryPath(item.statement.modlogId)}>{t('notifications', 'statement')}</a>
          </p>
        )}
      </div>
      <div className="pb-notice__side">
        <Time iso={item.createdAt} locale={locale} now={new Date(now)} />
        <form method="post" action="/notifications" onSubmit={submit}>
          <input type="hidden" name="intent" value={item.read ? 'unread' : 'read'} />
          <input type="hidden" name="id" value={item.id} />
          {hidden}
          <button type="submit" className="pb-notice__toggle">
            {t('notifications', item.read ? 'markUnread' : 'markRead')}
          </button>
        </form>
      </div>
    </li>
  );
}
