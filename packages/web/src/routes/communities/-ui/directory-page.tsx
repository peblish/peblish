import { directoryHref, directorySorts, nsfwModes, scopes, type DirectoryQuery } from '@peblish/core/directory/input';
import type { DirectoryRow } from '@peblish/core/directory/read';
import { Button } from '@peblish/ui/components/button';
import { Handle } from '@peblish/ui/components/handle';
import { Time } from '@peblish/ui/components/time';
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath, directoryPaths } from '../../../shell/paths.ts';
import type { DirectoryData } from '../-load.ts';
import { asDirectoryError, errorKey, type DirectoryError } from './errors.ts';
import { FollowForm } from './follow-form.tsx';

// The community directory after directory-table.html: the scope, sort and NSFW choices as links,
// one GET search form, and a semantic table (no Mux Table, no Tabs: first-tap condition). Every
// control works before the page hydrates and without script; hydrated, Join and Leave post by
// fetch and the page reloads its data.

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

function Choice({ href, current, children }: { href: string; current: boolean; children: ReactNode }) {
  return (
    <a href={href} aria-current={current ? 'true' : undefined}>
      {children}
    </a>
  );
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

  return (
    <main className="pb-page dir">
      <div className="dir-toolbar">
        <h1>{t('directory', 'directory.title')}</h1>
        <div className="dir-seg" role="group" aria-label={t('directory', 'directory.scope.group')}>
          {scopes.map((scope) => (
            <Choice key={scope} href={href({ scope })} current={query.scope === scope}>
              {t('directory', scopeKey[scope], { count: number.format(data.counts[scope]) })}
            </Choice>
          ))}
        </div>
        <span className="dir-space" />
        <div className="dir-seg" role="group" aria-label={t('directory', 'directory.sort.group')}>
          {directorySorts.map((sort) => (
            <Choice key={sort} href={href({ sort })} current={query.sort === sort}>
              {t('directory', sortKey[sort])}
            </Choice>
          ))}
        </div>
        {data.nsfwControls && (
          <div className="dir-seg" role="group" aria-label={t('directory', 'directory.nsfw.group')}>
            {nsfwModes.map((nsfw) => (
              <Choice key={nsfw} href={href({ nsfw })} current={query.nsfw === nsfw}>
                {t('directory', nsfwKey[nsfw])}
              </Choice>
            ))}
          </div>
        )}
      </div>

      <form className="dir-search" method="get" action={here} role="search">
        {query.scope !== 'all' && <input type="hidden" name="scope" value={query.scope} />}
        {query.sort !== 'subscribers' && <input type="hidden" name="sort" value={query.sort} />}
        {query.nsfw !== 'hide' && <input type="hidden" name="nsfw" value={query.nsfw} />}
        <label className="pb-sr" htmlFor="dir-q">
          {t('directory', 'directory.search.label')}
        </label>
        <input
          id="dir-q"
          type="search"
          name="q"
          defaultValue={query.q}
          maxLength={100}
          placeholder={t('directory', 'directory.search.placeholder')}
        />
        <Button type="submit">{t('directory', 'directory.search.submit')}</Button>
      </form>
      {data.lookup && (
        <p className="dir-hint">
          {t('directory', 'directory.hint.lookup')}{' '}
          <a href={`${directoryPaths.find}?q=${encodeURIComponent(query.q)}`}>{t('directory', 'directory.hint.find')}</a>
        </p>
      )}
      {error && (
        <p className="dir-error" role="alert">
          {t('directory', errorKey(error))}
        </p>
      )}

      {data.rows.length === 0 ? (
        <section className="dir-empty">
          <h2>{t('directory', 'directory.empty.title')}</h2>
          <p>{t('directory', 'directory.empty.body')}</p>
          <p>
            <a href={directoryPaths.find}>{t('directory', 'directory.empty.find')}</a>
          </p>
        </section>
      ) : (
        <table className="dir-table">
          <caption className="pb-sr">{t('directory', 'directory.table.label')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('directory', 'directory.col.community')}</th>
              <th scope="col" className="dir-num">
                {t('directory', 'directory.col.subscribers')}
                <sup>
                  <a href="#dir-note-counts" aria-label="1">
                    1
                  </a>
                </sup>
              </th>
              <th scope="col" className="dir-num">
                {t('directory', 'directory.col.active')}
                <sup>
                  <a href="#dir-note-counts" aria-label="1">
                    1
                  </a>
                </sup>
              </th>
              <th scope="col">
                <span className="pb-sr">{t('directory', 'directory.col.action')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <Row key={row.actor.id} row={row} signedIn={data.signedIn} next={current} now={now} onError={setRefused} />
            ))}
          </tbody>
        </table>
      )}

      {(data.page > 1 || data.hasNext) && (
        <nav className="dir-pages" aria-label={t('directory', 'directory.pages.label')}>
          {data.page > 1 && (
            <a href={directoryHref(here, { ...query, page: data.page - 1 })} rel="prev">
              {t('directory', 'directory.page.prev')}
            </a>
          )}
          {data.hasNext && (
            <a href={directoryHref(here, { ...query, page: data.page + 1 })} rel="next">
              {t('directory', 'directory.page.next')}
            </a>
          )}
        </nav>
      )}

      <footer className="dir-notes">
        <p id="dir-note-counts">
          <sup>1</sup> {t('directory', 'directory.foot.counts')}
        </p>
        {data.nsfwControls && <p id="dir-note-nsfw">{t('directory', 'directory.foot.nsfw')}</p>}
      </footer>
    </main>
  );
}

function Row({
  row,
  signedIn,
  next,
  now,
  onError,
}: {
  row: DirectoryRow;
  signedIn: boolean;
  next: string;
  now: Date;
  onError: (error: DirectoryError | undefined) => void;
}) {
  const { t, locale } = useTranslate();
  const number = new Intl.NumberFormat(locale);
  const { actor } = row;
  const handleId = `dir-${actor.id}`;
  const host = actor.handle.includes('@') ? actor.handle.slice(actor.handle.indexOf('@') + 1) : '';
  return (
    <tr>
      <td data-label={t('directory', 'directory.col.community')}>
        {row.sensitive && <span className="dir-nsfw">{t('directory', 'directory.row.nsfw')} </span>}
        <a href={communityPath(actor)} id={handleId}>
          <Handle prefix="!" handle={actor.handle} />
        </a>
        {actor.displayName && actor.displayName.toLowerCase() !== actor.name.toLowerCase() && (
          <span className="dir-muted"> {actor.displayName}</span>
        )}
        {row.excerpt && <p className="dir-excerpt">{row.excerpt}</p>}
        <p className="dir-source">
          {actor.local
            ? t('directory', 'directory.row.local')
            : row.refreshedAt
              ? rich(t('directory', 'directory.row.remote', { host, time: '{time}' }), {
                  time: <Time iso={row.refreshedAt} locale={locale} now={now} />,
                })
              : t('directory', 'directory.row.remoteCopy', { host })}
        </p>
      </td>
      <td className="dir-num" data-label={t('directory', 'directory.col.subscribers')}>
        {number.format(row.subscribers)}
      </td>
      <td className="dir-num" data-label={t('directory', 'directory.col.active')}>
        {number.format(row.active)}
      </td>
      <td className="dir-action">
        {!signedIn ? (
          <a href={`/auth/sign-in?redirect=${encodeURIComponent(next)}`}>{t('directory', 'directory.row.signIn')}</a>
        ) : row.follow === 'pending' ? (
          <Button type="button" disabled aria-describedby={handleId}>
            {t('directory', 'directory.row.pending')}
          </Button>
        ) : row.follow === 'accepted' ? (
          <FollowForm community={actor.id} intent="leave" next={next} onError={onError}>
            <Button type="submit" aria-pressed="true" aria-describedby={handleId}>
              {t('directory', 'directory.row.joined')}
            </Button>
          </FollowForm>
        ) : (
          <FollowForm community={actor.id} intent="join" next={next} onError={onError}>
            <Button type="submit" aria-describedby={handleId}>
              {t('directory', 'directory.row.join')}
            </Button>
          </FollowForm>
        )}
      </td>
    </tr>
  );
}
