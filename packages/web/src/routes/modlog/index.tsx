import { isActionGroup, type ActionGroup } from '@peblish/core/modlog/groups';
import { Handle } from '@peblish/ui/components/handle';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { DEFAULT_LOCALE } from '../../i18n/negotiate.ts';
import { translate } from '../../i18n/translate.ts';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { commentPath, communityPath, postPath, userPath } from '../../shell/paths.ts';
import { rootTitleData } from '../../shell/title.ts';
import { loadModlog, modlogEntryValid, type LineView, type ModlogData, type ModlogSearch } from './-load.ts';
import { actionKey, banLength } from './-ui/labels.ts';
import modlogCss from './-ui/modlog.css?url';

// /modlog: the moderation log as a stream (R2 pick modlog-feed). Entries grouped by day, two lines
// each, with a facet rail of counts. Public rows for everyone; staff also see private rows.
// A community's moderators and the admins reach more of it (core/modlog/filters.ts ModlogViewer).

const truthy = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';
const text = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined;

/** A lenient search: anything unreadable is left out, never an error page. */
export function parseModlogSearch(raw: Record<string, unknown>): ModlogSearch {
  const action = text(raw.action);
  const community = text(raw.community);
  const entry = text(raw.entry);
  const cursor = text(raw.cursor);
  return {
    ...(entry ? { entry } : {}),
    ...(community ? { community } : {}),
    ...(action && isActionGroup(action) ? { action } : {}),
    ...(truthy(raw.remote) ? { remote: true } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** The address of the page for a set of choices; `cursor` pages, the rest filter and start over. */
function href(choice: {
  community?: string | undefined;
  action?: ActionGroup | undefined;
  remote?: boolean | undefined;
  cursor?: string | undefined;
}) {
  const query = new URLSearchParams();
  if (choice.community) query.set('community', choice.community);
  if (choice.action) query.set('action', choice.action);
  if (choice.remote) query.set('remote', '1');
  if (choice.cursor) query.set('cursor', choice.cursor);
  return query.size > 0 ? `/modlog?${query}` : '/modlog';
}

export const Route = createFileRoute('/modlog/')({
  validateSearch: parseModlogSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => {
    if (deps.entry !== undefined && !modlogEntryValid(deps.entry)) throw notFound();
    return loadModlog({ data: deps });
  },
  head: ({ matches }: { matches: readonly { routeId: string; loaderData?: unknown }[] }) => {
    const { locale, site } = rootTitleData(matches.find((match) => match.routeId === '__root__')?.loaderData, DEFAULT_LOCALE);
    return { meta: [{ title: `${translate(locale, 'modlog', 'title')} · ${site}` }], links: [{ rel: 'stylesheet', href: modlogCss }] };
  },
  component: ModlogPage,
});

const groupOrder: ActionGroup[] = ['removals', 'bans', 'locks', 'community', 'site'];

function ModlogPage() {
  const { t, locale } = useTranslate();
  const data = Route.useLoaderData();
  useRouteHydrated();
  const { chosen } = data;
  const number = new Intl.NumberFormat(locale);
  const filtered = Boolean(chosen.communityHandle || chosen.group || chosen.remote || chosen.entry);
  const keep = { community: chosen.communityHandle ?? undefined, action: chosen.group ?? undefined, remote: chosen.remote || undefined };
  const days = groupByDay(data.lines);
  return (
    <main className="modlog">
      <div className="modlog-head">
        <h1>{t('modlog', 'title')}</h1>
        <span>{chosen.community ? <Handle prefix="!" handle={chosen.community.handle} /> : t('modlog', 'allCommunities')}</span>
        <span className="modlog-note">{t('modlog', 'timesInUtc')}</span>
        {data.staff && <span className="modlog-note">{t('modlog', 'staffView')}</span>}
        {!data.signedIn && <span className="modlog-note">{t('modlog', 'signedOut')}</span>}
      </div>
      <div className="modlog-layout">
        <Rail data={data} keep={keep} />
        <div className="modlog-body">
          {data.lines.length === 0 ? (
            <p className="modlog-empty" data-testid="modlog-empty">
              {filtered ? t('modlog', 'noMatch') : t('modlog', 'empty')} {filtered && <a href="/modlog">{t('modlog', 'clearFilters')}</a>}
            </p>
          ) : (
            days.map(({ day, lines }) => (
              <section key={day} aria-label={day}>
                <h2 className="modlog-day">{dayHeading(lines[0]!.entry.createdAt, locale)}</h2>
                {lines.map((line) => (
                  <Entry key={line.entry.id} line={line} />
                ))}
              </section>
            ))
          )}
          {data.lines.length > 0 && (
            <nav className="modlog-pages" aria-label={t('modlog', 'older')}>
              <span className="modlog-note" data-testid="modlog-range">
                {t('modlog', 'range', {
                  from: number.format(data.from),
                  to: number.format(data.from + data.lines.length - 1),
                  total: number.format(data.total),
                })}
              </span>
              {chosen.cursor && <a href={href(keep)}>{t('modlog', 'newest')}</a>}
              {data.next && <a href={href({ ...keep, cursor: data.next })}>{t('modlog', 'older')}</a>}
            </nav>
          )}
          <p className="modlog-legend">
            <span>
              <b>{t('modlog', 'marker.relayed')}</b> {t('modlog', 'legend.relayed')}
            </span>
            <span>
              <b>{t('modlog', 'marker.withheld')}</b> {t('modlog', 'legend.withheld')}
            </span>
            {data.staff && (
              <span>
                <b>{t('modlog', 'marker.private')}</b> {t('modlog', 'legend.private')}
              </span>
            )}
          </p>
        </div>
      </div>
    </main>
  );
}

function Rail({
  data,
  keep,
}: {
  data: ModlogData;
  keep: { community: string | undefined; action: ActionGroup | undefined; remote: true | undefined };
}) {
  const { t, locale } = useTranslate();
  const number = new Intl.NumberFormat(locale);
  const { chosen, facets } = data;
  const communityTotal = facets.communities.reduce((sum, row) => sum + row.count, 0);
  const item = (label: React.ReactNode, count: number, target: string, current: boolean) => (
    <li>
      <a href={target} aria-current={current ? 'true' : undefined}>
        <span>{label}</span>
        <span className="modlog-note">{number.format(count)}</span>
      </a>
    </li>
  );
  return (
    <aside className="modlog-rail" aria-label={t('modlog', 'rail.label')}>
      <h2>{t('modlog', 'rail.community')}</h2>
      <ul>
        {item(t('modlog', 'rail.all'), communityTotal, href({ ...keep, community: undefined }), !chosen.communityHandle)}
        {facets.communities.map((row) => {
          const handle = row.label?.handle ?? row.apId;
          return item(
            <Handle prefix="!" handle={handle} />,
            row.count,
            href({ ...keep, community: handle }),
            chosen.community?.id === row.id,
          );
        })}
        {item(t('modlog', 'rail.remote'), facets.remote, href({ ...keep, remote: chosen.remote ? undefined : true }), chosen.remote)}
      </ul>
      <h2>{t('modlog', 'rail.action')}</h2>
      <ul>
        {groupOrder
          .filter((group) => group !== 'site' || data.staff || facets.groups.site > 0)
          .map((group) =>
            item(
              t('modlog', `group.${group}`),
              facets.groups[group],
              href({ ...keep, action: chosen.group === group ? undefined : group }),
              chosen.group === group,
            ),
          )}
      </ul>
    </aside>
  );
}

function Entry({ line }: { line: LineView }) {
  const { t, locale } = useTranslate();
  const { entry } = line;
  const length = banLength(line);
  const moderator = line.moderator;
  const host = new URL(entry.actorApId).host;
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(
    new Date(entry.createdAt),
  );
  return (
    <article className="modlog-entry" data-testid="modlog-entry" data-action={entry.action}>
      <div className="modlog-l1">
        <time dateTime={entry.createdAt}>{time}</time>
        <b>
          {!entry.public && <span className="modlog-tag">{t('modlog', 'marker.private')} </span>}
          {t('modlog', actionKey(entry.action, line.target))}
          {length && (
            <>
              ,{' '}
              {length.kind === 'permanent'
                ? t('modlog', 'ban.permanent')
                : length.kind === 'days'
                  ? length.count === 1
                    ? t('modlog', 'ban.days.one', { count: 1 })
                    : t('modlog', 'ban.days.other', { count: length.count })
                  : t('modlog', 'ban.until', {
                      date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
                        new Date(length.at),
                      ),
                    })}
            </>
          )}
        </b>
        <Target line={line} />
      </div>
      <div className="modlog-l2">
        {moderator && (!line.relayed || line.staff) ? (
          moderator.id ? (
            <a href={userPath(moderator)}>
              <Handle prefix="@" handle={moderator.handle} />
            </a>
          ) : (
            <Handle prefix="@" handle={moderator.handle} />
          )
        ) : (
          <span>{t('modlog', 'moderator.on', { host })}</span>
        )}
        {line.relayed && <span className="modlog-tag"> {t('modlog', 'marker.relayed')}</span>}
        <span className="modlog-reason">
          {' · '}
          {entry.reasonWithheld ? (
            <>
              <span className="modlog-tag">{t('modlog', 'marker.withheld')}</span>{' '}
              <span className="modlog-note">{t('modlog', 'withheld.why', { host })}</span>
            </>
          ) : entry.reason ? (
            entry.reason
          ) : (
            <span className="modlog-note">{t('modlog', 'reason.none')}</span>
          )}
          {entry.details.removeContent && (
            <span className="modlog-note">
              {' · '}
              {t('modlog', 'ban.removed', { posts: entry.details.removedPosts ?? 0, comments: entry.details.removedComments ?? 0 })}
            </span>
          )}
        </span>
      </div>
    </article>
  );
}

function Target({ line }: { line: LineView }) {
  const { t } = useTranslate();
  const { target, community } = line;
  if (!target) return null;
  switch (target.kind) {
    case 'post':
    case 'comment': {
      const path =
        target.kind === 'post'
          ? target.postId
            ? postPath(target.postId)
            : null
          : target.postId && target.commentId
            ? commentPath(target.postId, target.commentId)
            : null;
      const name = target.label ?? (path ? t('modlog', 'target.hidden') : t('modlog', 'target.gone'));
      return (
        <span className="modlog-target">
          <span className="modlog-note">{t('modlog', `target.${target.kind}`)}</span> {path ? <a href={path}>{name}</a> : name}
          <span className="modlog-note">
            {target.author && ` ${t('modlog', 'target.by', { author: `@${target.author.handle}` })}`}
            {community && ` ${t('modlog', 'target.in', { community: `!${community.handle}` })}`}
          </span>
        </span>
      );
    }
    case 'person':
      return (
        <span className="modlog-target">
          <span className="modlog-note">{t('modlog', 'target.person')}</span>{' '}
          {target.person.id ? (
            <a href={userPath(target.person)}>
              <Handle prefix="@" handle={target.person.handle} />
            </a>
          ) : (
            <Handle prefix="@" handle={target.person.handle} />
          )}
          {community && <span className="modlog-note"> {t('modlog', 'target.in', { community: `!${community.handle}` })}</span>}
        </span>
      );
    case 'community':
      return (
        <span className="modlog-target">
          <span className="modlog-note">{t('modlog', 'target.community')}</span>{' '}
          <a href={communityPath(target.community)}>
            <Handle prefix="!" handle={target.community.handle} />
          </a>
        </span>
      );
    case 'instance':
      return (
        <span className="modlog-target">
          <span className="modlog-note">{t('modlog', 'target.instance')}</span> {target.host}
        </span>
      );
  }
}

/** Day by day in UTC, in the order given (newest first). */
function groupByDay(lines: LineView[]) {
  const days: { day: string; lines: LineView[] }[] = [];
  for (const line of lines) {
    const day = line.entry.createdAt.slice(0, 10);
    const last = days.at(-1);
    if (last?.day === day) last.lines.push(line);
    else days.push({ day, lines: [line] });
  }
  return days;
}

const dayHeading = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );
