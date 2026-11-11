import { createFileRoute } from '@tanstack/react-router';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths, userPath } from '../../../shell/paths.ts';
import { authHead, AuthPage, useDate } from '../../auth/-ui/page.tsx';
import { BanFields, Panel, ReasonFields } from '../../modlog/-ui/panels.tsx';
import { Denial } from '../-denial.tsx';
import { loadBans } from './-load.ts';

// /admin/bans: the Bans tab (R2 pick admin-tabs). Who is banned from this instance, a form to
// ban someone by handle (a person of ours, or one of a peer we hold) that first shows what the
// ban would remove, and Lift. The forms post to /modlog/act, as the panels do.

/** A lenient search: the handle asked after, if the address has one. */
const parseSearch = (raw: Record<string, unknown>): { person?: string } =>
  typeof raw.person === 'string' || typeof raw.person === 'number' ? { person: String(raw.person) } : {};

export const Route = createFileRoute('/admin/bans/')({
  validateSearch: parseSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => loadBans({ data: deps }),
  head: authHead,
  component: Bans,
});

function Bans() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const date = useDate();
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <AuthPage>
        <h1>{t('bans', 'title')}</h1>
        <Denial
          access={data.access}
          copy={{ needsTwoFactor: t('bans', 'needsTwoFactor'), securityLink: t('bans', 'securityLink'), notAdmin: t('bans', 'notAdmin') }}
        />
      </AuthPage>
    );
  const { bans, candidate } = data;
  return (
    <AuthPage wide>
      <h1>{t('bans', 'title')}</h1>
      <form method="get" action={adminPaths.bans} className="bans-find">
        <div className="fld">
          <label htmlFor="ban-person">{t('bans', 'find')}</label>
          <input
            id="ban-person"
            name="person"
            placeholder={t('bans', 'findPlaceholder')}
            defaultValue={candidate && 'person' in candidate ? candidate.person.handle : (candidate?.missing ?? '')}
            required
          />
          <span className="hint">{t('bans', 'findHint')}</span>
        </div>
        <button type="submit">{t('bans', 'check')}</button>
      </form>
      {candidate && 'missing' in candidate && (
        <p role="alert" data-testid="ban-missing">
          {t('bans', 'missing', { handle: candidate.missing })}
        </p>
      )}
      {candidate && 'person' in candidate && (
        <section aria-label={t('bans', 'confirm')} data-testid="ban-confirm">
          <h2>{t('bans', 'confirmTitle', { handle: `@${candidate.person.handle}` })}</h2>
          {candidate.banned ? (
            <p>{t('bans', 'already')}</p>
          ) : (
            <>
              <p>{t('bans', 'counts', { posts: candidate.counts.posts, comments: candidate.counts.comments })}</p>
              <Panel
                panel={`site_ban:${candidate.person.id}`}
                summary={t('bans', 'banSummary')}
                intent="site_ban"
                fields={{ person: candidate.person.id }}
                back={adminPaths.bans}
                submit={t('bans', 'ban')}
                defaultOpen
              >
                <BanFields id="confirm" person={candidate.person.id} />
                <ReasonFields required id="confirm" />
              </Panel>
            </>
          )}
        </section>
      )}
      {bans.length === 0 ? (
        <p className="muted" data-testid="bans-empty">
          {t('bans', 'empty')}
        </p>
      ) : (
        <table className="invites" data-testid="bans-table">
          <thead>
            <tr>
              <th>{t('bans', 'colPerson')}</th>
              <th>{t('bans', 'colHome')}</th>
              <th>{t('bans', 'colReason')}</th>
              <th>{t('bans', 'colBy')}</th>
              <th>{t('bans', 'colDate')}</th>
              <th>{t('bans', 'colEnds')}</th>
              <th>
                <span className="sr">{t('bans', 'colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bans.map((ban) => (
              <tr key={ban.person.id} data-testid="ban-row">
                <td data-label={t('bans', 'colPerson')}>
                  <a href={userPath(ban.person)}>@{ban.person.handle}</a>
                </td>
                <td data-label={t('bans', 'colHome')}>{ban.home}</td>
                <td data-label={t('bans', 'colReason')}>{ban.reason ?? <span className="muted">{t('bans', 'noReason')}</span>}</td>
                <td data-label={t('bans', 'colBy')}>
                  {ban.source === 'remote' ? t('bans', 'byPeer', { host: ban.home }) : ban.bannedBy ? `@${ban.bannedBy.handle}` : ''}
                </td>
                <td data-label={t('bans', 'colDate')}>{date(ban.createdAt)}</td>
                <td data-label={t('bans', 'colEnds')}>{ban.expiresAt ? date(ban.expiresAt) : t('bans', 'permanent')}</td>
                <td data-label="">
                  <Panel
                    panel={`site_unban:${ban.person.id}`}
                    summary={t('bans', 'lift')}
                    intent="site_unban"
                    fields={{ person: ban.person.id }}
                    back={adminPaths.bans}
                    submit={t('bans', 'liftSubmit')}
                  >
                    <ReasonFields required={false} id={`lift-${ban.person.id}`} />
                  </Panel>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AuthPage>
  );
}
