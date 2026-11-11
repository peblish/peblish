import { directoryHref, directorySorts, nsfwModes, scopes, type DirectoryQuery } from '@peblish/core/directory/input';
import type { DirectoryRow } from '@peblish/core/directory/read';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { BidiText, Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { SearchField } from '@peblish/ui/components/search-field';
import { Table, type MuxUITableRow } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { Time } from '@peblish/ui/components/time';
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, directoryPaths, newCommunityPath } from '../../../shell/paths.ts';
import type { DirectoryData } from '../-load.ts';
import { asDirectoryError, errorKey, type DirectoryError } from './errors.ts';
import { FollowForm } from './follow-form.tsx';

// The community directory after directory-table.html, in Mux UI: the scope, sort and NSFW choices
// as link tabs, one GET search form around a Mux SearchField, and a Mux Table. The choices, the
// search and Join and Leave all work before the page hydrates and without script (Join and Leave
// are form posts in the table's cells); hydrated, Join and Leave post by fetch and the page
// reloads its data.

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
  const { query } = data;
  const error = refused ?? asDirectoryError(fromAddress);
  const number = new Intl.NumberFormat(locale);
  const href = (change: Partial<DirectoryQuery>) => directoryHref(here, { ...query, page: 1, ...change });
  // Where a join sends the browser back to (without script), and where a signed-out visitor returns after signing in.
  const current = directoryHref(here, query);
  const now = new Date(data.now);

  const columns = [
    { id: 'community', label: t('directory', 'directory.col.community'), isRowHeader: true },
    { id: 'subscribers', label: <Counted>{t('directory', 'directory.col.subscribers')}</Counted> },
    { id: 'active', label: <Counted>{t('directory', 'directory.col.active')}</Counted> },
    {
      id: 'action',
      label: (
        <Text as="span" className="pb-sr">
          {t('directory', 'directory.col.action')}
        </Text>
      ),
      textValue: t('directory', 'directory.col.action'),
    },
  ];
  const rows: MuxUITableRow[] = data.rows.map((row) => {
    const handleId = `dir-${row.actor.id}`;
    return {
      id: row.actor.id,
      values: {
        community: <CommunityCell row={row} handleId={handleId} now={now} />,
        subscribers: <Text className="dir-num">{number.format(row.subscribers)}</Text>,
        active: <Text className="dir-num">{number.format(row.active)}</Text>,
        action: <ActionCell row={row} handleId={handleId} signedIn={data.signedIn} next={current} onError={setRefused} />,
      },
    };
  });

  return (
    <main className="pb-page dir">
      <div className="dir-toolbar">
        <Text as="h1" variant="heading" size="sm">
          {t('directory', 'directory.title')}
        </Text>
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
        <span className="dir-space" />
        <LinkTabs
          aria-label={t('directory', 'directory.sort.group')}
          variant="segment"
          size="sm"
          className="dir-seg"
          items={directorySorts.map((sort) => ({ to: href({ sort }), label: t('directory', sortKey[sort]), active: query.sort === sort }))}
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
        {data.admin && <Link href={newCommunityPath}>{t('directory', 'directory.new')}</Link>}
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
        // The table scrolls sideways on a narrow screen rather than squeezing its columns.
        <div className="dir-scroll">
          <Table className="dir-table" aria-label={t('directory', 'directory.table.label')} columns={columns} rows={rows} />
        </div>
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
          <sup>1</sup> {t('directory', 'directory.foot.counts')}
        </Text>
        {data.nsfwControls && (
          <Text as="p" size="sm" color="muted" id="dir-note-nsfw">
            {t('directory', 'directory.foot.nsfw')}
          </Text>
        )}
      </footer>
    </main>
  );
}

/** A column heading whose figures are explained by footnote 1. */
function Counted({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <sup>
        <Link href="#dir-note-counts" aria-label="1">
          1
        </Link>
      </sup>
    </>
  );
}

function CommunityCell({ row, handleId, now }: { row: DirectoryRow; handleId: string; now: Date }) {
  const { t, locale } = useTranslate();
  const { actor } = row;
  const host = actor.handle.includes('@') ? actor.handle.slice(actor.handle.indexOf('@') + 1) : '';
  return (
    <div className="dir-community">
      <Text as="div" className="dir-name">
        {row.sensitive && <Badge kind="nsfw">{t('directory', 'directory.row.nsfw')}</Badge>}
        <Link href={communityPath(actor)} id={handleId}>
          <Handle prefix="!" handle={actor.handle} />
        </Link>
        {actor.displayName && actor.displayName.toLowerCase() !== actor.name.toLowerCase() && (
          <Text color="muted">
            {' '}
            <BidiText text={actor.displayName} />
          </Text>
        )}
      </Text>
      {row.excerpt && (
        <Text as="p" size="sm">
          {row.excerpt}
        </Text>
      )}
      <Text as="p" size="xs" color="muted">
        {actor.local
          ? t('directory', 'directory.row.local')
          : row.refreshedAt
            ? rich(t('directory', 'directory.row.remote', { host, time: '{time}' }), {
                time: <Time iso={row.refreshedAt} locale={locale} now={now} />,
              })
            : t('directory', 'directory.row.remoteCopy', { host })}
      </Text>
    </div>
  );
}

function ActionCell({
  row,
  handleId,
  signedIn,
  next,
  onError,
}: {
  row: DirectoryRow;
  handleId: string;
  signedIn: boolean;
  next: string;
  onError: (error: DirectoryError | undefined) => void;
}) {
  const { t } = useTranslate();
  if (!signedIn) return <Link href={`/auth/sign-in?redirect=${encodeURIComponent(next)}`}>{t('directory', 'directory.row.signIn')}</Link>;
  if (row.follow === 'pending')
    return (
      <Button type="button" variant="neutral" size="sm" disabled aria-describedby={handleId}>
        {t('directory', 'directory.row.pending')}
      </Button>
    );
  if (row.follow === 'accepted')
    return (
      <FollowForm community={row.actor.id} intent="leave" next={next} onError={onError}>
        <Button type="submit" variant="neutral" size="sm" aria-pressed="true" aria-describedby={handleId}>
          {t('directory', 'directory.row.joined')}
        </Button>
      </FollowForm>
    );
  return (
    <FollowForm community={row.actor.id} intent="join" next={next} onError={onError}>
      <Button type="submit" size="sm" aria-describedby={handleId}>
        {t('directory', 'directory.row.join')}
      </Button>
    </FollowForm>
  );
}
