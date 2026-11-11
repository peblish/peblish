import type { SiteBanRow } from '@peblish/core/bans/read';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { createFileRoute } from '@tanstack/react-router';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths, userPath } from '../../../shell/paths.ts';
import { useDate } from '../../auth/-ui/page.tsx';
import { BanFields, Panel, ReasonFields } from '../../modlog/-ui/panels.tsx';
import { Denial } from '../-denial.tsx';
import { loadBans } from './-load.ts';
import bansCss from './-ui/bans.css?url';

// /admin/bans: the Bans tab (R2 pick admin-tabs). Who is banned from this instance, a form to
// ban someone by handle (a person of ours, or one of a peer we hold) that first shows what the
// ban would remove, and Lift. The forms post to /modlog/act, as the panels do.
//
// The table only reads. Lift opens its panel below the table for the ban chosen with
// ?lift=<person id> (a refusal comes back with ?modFor=site_unban:<id> and opens it too): the
// panel's reason box cannot sit in a Mux Table cell, whose grid takes arrow keys and letters.

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
  head: () => ({ links: [{ rel: 'stylesheet', href: bansCss }] }),
  component: Bans,
});

/** The chosen ban's Lift panel, open, with the optional reason. */
function LiftPanel({ ban }: { ban: SiteBanRow }) {
  const { t } = useTranslate();
  return (
    <Card.Root variant="outlined" padding="sm" id="ban-lift" data-testid="ban-lift">
      <Card.Header>
        <Text as="h2" variant="title" size="sm">
          {t('bans', 'liftTitle', { handle: `@${ban.person.handle}` })}
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
  const date = useDate();
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
  const lifting = bans.find((ban) => ban.person.id === search.lift || search.modFor === `site_unban:${ban.person.id}`);
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
              {t('bans', 'confirmTitle', { handle: `@${candidate.person.handle}` })}
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
                person: <Link href={userPath(ban.person)}>@{ban.person.handle}</Link>,
                home: ban.home,
                reason: ban.reason ?? <Text color="muted">{t('bans', 'noReason')}</Text>,
                by: ban.source === 'remote' ? t('bans', 'byPeer', { host: ban.home }) : ban.bannedBy ? `@${ban.bannedBy.handle}` : '',
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
    </main>
  );
}
