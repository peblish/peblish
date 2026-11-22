import { directoryHref, directorySorts, nsfwModes, scopes, type DirectoryQuery } from '@peblish/core/directory/input';
import type { DirectoryRow } from '@peblish/core/directory/read';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { CommunityList, CommunityViewControl, type CommunityListItem, type CommunityView } from '@peblish/ui/components/community-list';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { FactList } from '@peblish/ui/components/fact-list';
import { BidiText, Handle, handleHost } from '@peblish/ui/components/handle';
import { JoinButton } from '@peblish/ui/components/join-button';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { RailPanel } from '@peblish/ui/components/rail-panel';
import { SearchField } from '@peblish/ui/components/search-field';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { Fragment, useState, type ReactNode } from 'react';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, directoryPaths, newCommunityPath } from '../../../shell/paths.ts';
import { Rail } from '../../../shell/rail.tsx';
import { ViewHeader } from '../../../shell/view-header.tsx';
import type { DirectoryData } from '../-load.ts';
import { storeView } from '../-view.ts';
import { asDirectoryError, errorKey, type DirectoryError } from './errors.ts';
import { FollowForm } from './follow-form.tsx';

// The community directory (Commons, the mock's CommunitiesView): its name in the view header, the
// scope, sort and NSFW choices as link tabs with the List or Cards choice, one GET search form
// around a Mux SearchField, then the communities as rows or cards, and the rail's facts. The
// choices, the search and Join, Leave and Cancel all work before the page hydrates and without
// script (Join and its siblings are form posts); hydrated, they post by fetch and the page reloads
// its data. List or Cards needs script to change, and is kept in this browser (-view.ts).

const here = '/communities';
const scopeKey = { all: 'directory.scope.all', local: 'directory.scope.local' } as const;
const sortKey = {
  subscribers: 'directory.sort.subscribers',
  active: 'directory.sort.active',
  newest: 'directory.sort.newest',
  name: 'directory.sort.name',
} as const;
const nsfwKey = { hide: 'directory.nsfw.hide', show: 'directory.nsfw.show', only: 'directory.nsfw.only' } as const;

/** A message whose {placeholders} are elements: the age of a copy is a <time>. */
function rich(message: string, parts: Record<string, ReactNode>): ReactNode[] {
  return message.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={index}>{name !== undefined && name in parts ? parts[name] : piece}</Fragment>;
  });
}

export function DirectoryPage({ data, error: fromAddress }: { data: DirectoryData; error: string | undefined }) {
  const { t, locale } = useTranslate();
  useRouteHydrated();
  const [refused, setRefused] = useState<DirectoryError | undefined>();
  // The loader reads the view from the cookie; a choice made on this page wins until the page is left.
  const [chosen, setChosen] = useState<CommunityView>();
  const view = chosen ?? data.view;
  // The communities whose Join, Leave or Cancel is on its way. Kept here, not in the row: List and Cards draw
  // different rows, so a switch remounts each action, and the post must stay pending through it.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyFor = (id: string) => (on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const { query } = data;
  const error = refused ?? asDirectoryError(fromAddress);
  const number = new Intl.NumberFormat(locale);
  const href = (change: Partial<DirectoryQuery>) => directoryHref(here, { ...query, page: 1, ...change });
  // Where a join sends the browser back to (without script), and where a signed-out visitor returns after signing in.
  const current = directoryHref(here, query);
  const now = new Date(data.now);

  const items: CommunityListItem[] = data.rows.map((row) => {
    const linkId = `dir-${row.actor.id}`;
    const { actor } = row;
    return {
      id: actor.id,
      href: communityPath(actor),
      linkId,
      title: <BidiText text={actor.displayName ?? actor.name} />,
      initial: row.initial,
      meta: (
        <>
          <Handle prefix="!" handle={actor.handle} />
          {' · '}
          {translatePlural(locale, 'directory', 'directory.row.subscribers', row.subscribers)}
          {' · '}
          {translatePlural(locale, 'directory', 'directory.row.active', row.active)}
        </>
      ),
      badges: row.sensitive ? <Badge kind="nsfw">{t('directory', 'directory.row.nsfw')}</Badge> : undefined,
      about: row.excerpt ?? undefined,
      note: actor.local ? undefined : <Source row={row} now={now} />,
      action: (
        <Action
          row={row}
          linkId={linkId}
          signedIn={data.signedIn}
          next={current}
          busy={busy.has(actor.id)}
          onBusy={busyFor(actor.id)}
          onError={setRefused}
        />
      ),
    };
  });

  const choose = (next: CommunityView) => {
    setChosen(next);
    storeView(next);
  };

  return (
    <>
      <main className="pb-page dir">
        <ViewHeader
          root
          title={
            <Text as="h1" variant="label" size="md" className="dir-title">
              {t('directory', 'directory.title')}
            </Text>
          }
        />
        <div className="dir-toolbar">
          <LinkTabs
            aria-label={t('directory', 'directory.scope.group')}
            variant="segment"
            size="sm"
            className="dir-seg"
            items={scopes.map((scope) => ({
              to: href({ scope }),
              label: t('directory', scopeKey[scope], { count: number.format(data.counts[scope]) }),
              active: query.scope === scope,
            }))}
          />
          <LinkTabs
            aria-label={t('directory', 'directory.sort.group')}
            variant="segment"
            size="sm"
            className="dir-seg"
            items={directorySorts.map((sort) => ({
              to: href({ sort }),
              label: t('directory', sortKey[sort]),
              active: query.sort === sort,
            }))}
          />
          {data.nsfwControls && (
            <LinkTabs
              aria-label={t('directory', 'directory.nsfw.group')}
              variant="segment"
              size="sm"
              className="dir-seg"
              items={nsfwModes.map((nsfw) => ({ to: href({ nsfw }), label: t('directory', nsfwKey[nsfw]), active: query.nsfw === nsfw }))}
            />
          )}
          {data.admin && (
            <Link href={newCommunityPath} className="dir-new">
              {t('directory', 'directory.new')}
            </Link>
          )}
          {/* Not in the view header, as in the mock: on a phone the bar has no room beside the drawer's button. */}
          <CommunityViewControl
            value={view}
            onChange={choose}
            labels={{
              group: t('directory', 'directory.view.group'),
              list: t('directory', 'directory.view.list'),
              cards: t('directory', 'directory.view.cards'),
            }}
          />
        </div>

        {/* A GET form, so a search works without script; the hidden fields keep the scope, sort and NSFW choice. */}
        <form className="dir-search" method="get" action={here} role="search">
          {query.scope !== 'all' && <input type="hidden" name="scope" value={query.scope} />}
          {query.sort !== 'subscribers' && <input type="hidden" name="sort" value={query.sort} />}
          {query.nsfw !== 'hide' && <input type="hidden" name="nsfw" value={query.nsfw} />}
          <SearchField
            className="dir-q"
            aria-label={t('directory', 'directory.search.label')}
            name="q"
            defaultValue={query.q}
            placeholder={t('directory', 'directory.search.placeholder')}
            inputProps={{ maxLength: 100 }}
          />
          <Button type="submit">{t('directory', 'directory.search.submit')}</Button>
        </form>
        {data.lookup && (
          <Text as="p" size="sm" color="muted">
            {t('directory', 'directory.hint.lookup')}{' '}
            <Link href={`${directoryPaths.find}?q=${encodeURIComponent(query.q)}`}>{t('directory', 'directory.hint.find')}</Link>
          </Text>
        )}
        {error && (
          <Notice tone="danger" role="alert">
            {t('directory', errorKey(error))}
          </Notice>
        )}

        {data.rows.length === 0 ? (
          <EmptyState
            title={t('directory', 'directory.empty.title')}
            action={<Link href={directoryPaths.find}>{t('directory', 'directory.empty.find')}</Link>}
          >
            {t('directory', 'directory.empty.body')}
          </EmptyState>
        ) : (
          <CommunityList view={view} label={t('directory', 'directory.table.label')} items={items} />
        )}

        <Pager
          aria-label={t('directory', 'directory.pages.label')}
          {...(data.page > 1 && {
            previous: { href: directoryHref(here, { ...query, page: data.page - 1 }), label: t('directory', 'directory.page.prev') },
          })}
          {...(data.hasNext && {
            next: { href: directoryHref(here, { ...query, page: data.page + 1 }), label: t('directory', 'directory.page.next') },
          })}
        />

        <footer className="dir-notes">
          <Text as="p" size="sm" color="muted" id="dir-note-counts">
            {t('directory', 'directory.foot.counts')}
          </Text>
          {data.nsfwControls && (
            <Text as="p" size="sm" color="muted" id="dir-note-nsfw">
              {t('directory', 'directory.foot.nsfw')}
            </Text>
          )}
        </footer>
      </main>
      <Rail label={t('directory', 'directory.rail.label')}>
        <RailPanel title={t('directory', 'directory.rail.title')}>
          <FactList
            size="xs"
            items={[
              { key: 'local', label: t('directory', 'directory.rail.local'), value: number.format(data.counts.local) },
              { key: 'remote', label: t('directory', 'directory.rail.remote'), value: number.format(data.counts.all - data.counts.local) },
            ]}
          />
          <Text as="p" size="sm" color="muted" className="dir-rail-note">
            {t('directory', 'directory.rail.note')} <Link href={directoryPaths.find}>{t('directory', 'directory.rail.find')}</Link>
          </Text>
        </RailPanel>
      </Rail>
    </>
  );
}

/** Where a remote community's copy comes from, and how fresh it is. */
function Source({ row, now }: { row: DirectoryRow; now: Date }) {
  const { t, locale } = useTranslate();
  // The server after the handle's last @, isolated and without directional controls: a username can hold an @ too.
  const host = <BidiText text={handleHost(row.actor.handle)} />;
  return row.refreshedAt
    ? rich(t('directory', 'directory.row.remote', { host: '{host}', time: '{time}' }), {
        host,
        time: <Time iso={row.refreshedAt} locale={locale} now={now} />,
      })
    : rich(t('directory', 'directory.row.remoteCopy', { host: '{host}' }), { host });
}

/** Join, Joined (leave) or Pending (cancel the request) as a form; signed out, a link to sign in. */
function Action({
  row,
  linkId,
  signedIn,
  next,
  busy,
  onBusy,
  onError,
}: {
  row: DirectoryRow;
  linkId: string;
  signedIn: boolean;
  next: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (error: DirectoryError | undefined) => void;
}) {
  const { t } = useTranslate();
  if (!signedIn)
    return (
      <Link href={`/auth/sign-in?redirect=${encodeURIComponent(next)}`} className="dir-signin" aria-describedby={linkId}>
        {t('directory', 'directory.row.signIn')}
      </Link>
    );
  const state = row.follow === 'accepted' ? 'joined' : row.follow === 'pending' ? 'pending' : 'none';
  return (
    <FollowForm
      community={row.actor.id}
      intent={state === 'none' ? 'join' : 'leave'}
      next={next}
      busy={busy}
      onBusy={onBusy}
      onError={onError}
    >
      <JoinButton
        state={state}
        size="sm"
        quiet
        busy={busy}
        describedBy={linkId}
        labels={{
          join: t('directory', 'directory.row.join'),
          joined: t('directory', 'directory.row.joined'),
          leave: t('directory', 'directory.row.leave'),
          pending: t('directory', 'directory.row.pending'),
          cancel: t('directory', 'directory.row.cancel'),
        }}
      />
    </FollowForm>
  );
}
