import type { SiteBanRow } from '@peblish/core/bans/read';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { BidiText, Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths, userPath } from '../../../shell/paths.ts';
import { rich } from '../../auth/-ui/form.tsx';
import { useDate } from '../../auth/-ui/page.tsx';
import { BanFields, Panel, ReasonFields } from '../../modlog/-ui/panels.tsx';
import { Denial } from '../-denial.tsx';
import { NoEnterSubmit } from '../-no-enter-submit.tsx';
import { type BansData, loadBans } from './-load.ts';
import bansCss from './-ui/bans.css?url';
import { headTitle } from '../../../shell/title.ts';

// /admin/bans: the Bans tab (R2 pick admin-tabs). Who is banned from this instance, a form to
// ban someone by handle (a person of ours, or one of a peer we hold) that first shows what the
// ban would remove, and Lift. The forms post to /modlog/act, as the panels do.
//
// The table only reads. Lift opens its panel below the table for the ban chosen with
// ?lift=<person id> (a refusal comes back with ?modFor=site_unban:<id> and opens it too): the
// panel's reason box cannot sit in a Mux Table cell, whose grid takes arrow keys and letters.
// When the two disagree nothing opens, and a ban that is not in the list opens nothing and says so.
// Enter in either panel's fields bans or lifts nothing: only the panel's own button does.

type Search = { person?: string; lift?: string; modFor?: string };

/** A lenient search: the handle asked after, if the address has one, and the ban being lifted. */
const parseSearch = (raw: Record<string, unknown>): Search => {
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
  const [person, lift, modFor] = [text(raw.person), text(raw.lift), text(raw.modFor)];
  return { ...(person !== undefined && { person }), ...(lift !== undefined && { lift }), ...(modFor !== undefined && { modFor }) };
};

export const Route = createFileRoute('/admin/bans/')({
  validateSearch: parseSearch,
  loaderDeps: ({ search }) => (search.person === undefined ? {} : { person: search.person }),
  loader: ({ deps }) => loadBans({ data: deps }),
  head: ({ matches }) => ({ meta: [headTitle(matches, 'bans', 'title')], links: [{ rel: 'stylesheet', href: bansCss }] }),
  component: Bans,
  server: {
    handlers: {
      // Only the panels' hidden first button posts here: Enter in one of their fields without
      // scripts (NoEnterSubmit). It decides nothing and goes back to the panel it came from.
      POST: ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const url = new URL(request.url);
        return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}` } });
      },
    },
  },
});

/** The chosen ban's Lift panel, open, with the optional reason. */
function LiftPanel({ ban }: { ban: SiteBanRow }) {
  const { t } = useTranslate();
  return (
    <Card.Root variant="outlined" padding="sm" id="ban-lift" data-testid="ban-lift">
      <Card.Header>
        <Text as="h2" variant="title" size="sm">
          {rich(t('bans', 'liftTitle'), { handle: <Handle prefix="@" handle={ban.person.handle} /> })}
        </Text>
      </Card.Header>
      <Card.Body>
        <Panel
          panel={`site_unban:${ban.person.id}`}
          summary={t('bans', 'lift')}
          intent="site_unban"
          fields={{ person: ban.person.id }}
          back={adminPaths.bans}
          submit={t('bans', 'liftSubmit')}
          defaultOpen
        >
          <NoEnterSubmit formAction={`${adminPaths.bans}?${new URLSearchParams({ lift: ban.person.id })}`} />
          <ReasonFields required={false} id={`lift-${ban.person.id}`} />
        </Panel>
      </Card.Body>
    </Card.Root>
  );
}

function Bans() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <main className="pb-page bans-page">
        <Text as="h1" variant="heading" size="sm">
          {t('bans', 'title')}
        </Text>
        <Denial
          access={data.access}
          copy={{ needsTwoFactor: t('bans', 'needsTwoFactor'), securityLink: t('bans', 'securityLink'), notAdmin: t('bans', 'notAdmin') }}
        />
      </main>
    );
  const { bans, candidate } = data;
  const refused = search.modFor?.startsWith('site_unban:') ? search.modFor.slice('site_unban:'.length) : undefined;
  const wanted = search.lift !== undefined && refused !== undefined && search.lift !== refused ? undefined : (search.lift ?? refused);
  const lifting = wanted ? bans.find((ban) => ban.person.id === wanted) : undefined;
  return <BansPage bans={bans} candidate={candidate} wanted={wanted} lifting={lifting} />;
}

/**
 * The page for an admin. A hydrated Lift reloads the list in place; once the lifted ban has left
 * it, the address drops the selector, so the page shows the list and not "That ban is not in the list".
 */
function BansPage({
  bans,
  candidate,
  wanted,
  lifting,
}: Pick<Extract<BansData, { access: 'ok' }>, 'bans' | 'candidate'> & {
  wanted: string | undefined;
  lifting: SiteBanRow | undefined;
}) {
  const { t } = useTranslate();
  const date = useDate();
  const navigate = useNavigate();
  // The ban this view showed a Lift panel for: when it goes from the list, it was just lifted.
  const [shown, setShown] = useState<string>();
  if (lifting && shown !== lifting.person.id) setShown(lifting.person.id);
  const lifted = wanted !== undefined && lifting === undefined && shown === wanted;
  useEffect(() => {
    if (lifted) void navigate({ to: adminPaths.bans, search: {}, replace: true });
  }, [lifted, navigate]);
  return (
    <main className="pb-page bans-page">
      <Text as="h1" variant="heading" size="sm">
        {t('bans', 'title')}
      </Text>
      <form method="get" action={adminPaths.bans} className="bans-find">
        <TextField
          name="person"
          label={t('bans', 'find')}
          placeholder={t('bans', 'findPlaceholder')}
          defaultValue={candidate && 'person' in candidate ? candidate.person.handle : (candidate?.missing ?? '')}
          description={t('bans', 'findHint')}
          required
        />
        <Button type="submit" variant="neutral">
          {t('bans', 'check')}
        </Button>
      </form>
      {candidate && 'missing' in candidate && (
        <Notice tone="warning" role="alert" data-testid="ban-missing">
          {t('bans', 'missing', { handle: candidate.missing })}
        </Notice>
      )}
      {candidate && 'person' in candidate && (
        <Card.Root variant="outlined" padding="sm" aria-label={t('bans', 'confirm')} role="region" data-testid="ban-confirm">
          <Card.Header>
            <Text as="h2" variant="title" size="sm">
              {rich(t('bans', 'confirmTitle'), { handle: <Handle prefix="@" handle={candidate.person.handle} /> })}
            </Text>
          </Card.Header>
          <Card.Body>
            {candidate.banned ? (
              <Text as="p">{t('bans', 'already')}</Text>
            ) : (
              <>
                <Text as="p">{t('bans', 'counts', { posts: candidate.counts.posts, comments: candidate.counts.comments })}</Text>
                <Panel
                  panel={`site_ban:${candidate.person.id}`}
                  summary={t('bans', 'banSummary')}
                  intent="site_ban"
                  fields={{ person: candidate.person.id }}
                  back={adminPaths.bans}
                  submit={t('bans', 'ban')}
                  defaultOpen
                >
                  <NoEnterSubmit formAction={`${adminPaths.bans}?${new URLSearchParams({ person: candidate.person.handle })}`} />
                  <BanFields id="confirm" person={candidate.person.id} />
                  <ReasonFields required id="confirm" />
                </Panel>
              </>
            )}
          </Card.Body>
        </Card.Root>
      )}
      {bans.length === 0 ? (
        <EmptyState title={t('bans', 'empty')} className="bans-empty" />
      ) : (
        <Card.Root variant="outlined" padding="sm" className="bans-table" data-testid="bans-table">
          <Table
            aria-label={t('bans', 'title')}
            columns={[
              { id: 'person', label: t('bans', 'colPerson'), isRowHeader: true },
              { id: 'home', label: t('bans', 'colHome') },
              { id: 'reason', label: t('bans', 'colReason') },
              { id: 'by', label: t('bans', 'colBy') },
              { id: 'date', label: t('bans', 'colDate') },
              { id: 'ends', label: t('bans', 'colEnds') },
              { id: 'actions', label: t('bans', 'colActions') },
            ]}
            rows={bans.map((ban) => ({
              id: ban.person.id,
              values: {
                person: (
                  <Link href={userPath(ban.person)}>
                    <Handle prefix="@" handle={ban.person.handle} />
                  </Link>
                ),
                home: <BidiText text={ban.home} />,
                reason: ban.reason ?? <Text color="muted">{t('bans', 'noReason')}</Text>,
                by:
                  ban.source === 'remote' ? (
                    rich(t('bans', 'byPeer'), { host: <BidiText text={ban.home} /> })
                  ) : ban.bannedBy ? (
                    <Handle prefix="@" handle={ban.bannedBy.handle} />
                  ) : (
                    ''
                  ),
                date: date(ban.createdAt),
                ends: ban.expiresAt ? date(ban.expiresAt) : t('bans', 'permanent'),
                actions: (
                  <Link
                    href={`${adminPaths.bans}?${new URLSearchParams({ lift: ban.person.id })}#ban-lift`}
                    aria-label={t('bans', 'liftFor', { handle: `@${ban.person.handle}` })}
                  >
                    {t('bans', 'lift')}
                  </Link>
                ),
              },
            }))}
          />
        </Card.Root>
      )}
      {lifting && <LiftPanel key={lifting.person.id} ban={lifting} />}
      {wanted && !lifting && !lifted && (
        <Notice tone="warning" role="alert" data-testid="lift-missing">
          {t('bans', 'liftMissing')}
        </Notice>
      )}
    </main>
  );
}
