import { removeFromReportAs, resolveReportsAs, routeReportsAs } from '@peblish/core/reports/actions';
import type { ReportTarget } from '@peblish/core/reports/types';
import { Uuid } from '@peblish/schema/ids';
import { Button } from '@peblish/ui/components/button';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Pager } from '@peblish/ui/components/pager';
import { Select } from '@peblish/ui/components/select';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { SearchText } from '../../auth/-route.ts';
import { answer } from '../../report/-form.ts';
import { asReportError, errorKey } from '../../report/-ui/errors.ts';
import { loadQueue } from './-load.ts';
import { queueHref, type QueueView } from './-href.ts';
import { QueueTable } from './-ui/queue.tsx';
import queueCss from './-ui/queue.css?url';

// /admin/reports: the report queue, open to moderators (their communities' groups, and their
// own escalations read only) and to admins (everything). The admin layout draws the tab bar and
// admits nobody, so this page checks who may look: signed out is a redirect, anyone else who
// moderates nothing is a 403. Actions are plain form posts to this URL: 303 back to the queue,
// or back with ?error=<code>; once hydrated they post by fetch and reload the data.
//
// Blur by default: the quote of reported content is in the markup but blurred, unselectable and
// hidden from assistive technology until Show. There is never an image in the queue.

const Search = type({
  'tab?': 'string',
  'community?': SearchText,
  'sort?': 'string',
  'cursor?': SearchText,
  'show?': 'string',
  'details?': 'string',
  'remove?': 'string',
  'error?': 'string',
});

const Target = type(/^(post|comment|actor):[0-9a-f-]{36}$/);
const Body = type({
  intent: "'resolve' | 'dismiss' | 'remove' | 'escalate' | 'back'",
  target: 'string',
  audience: "'moderators' | 'admins'",
  'note?': 'string',
  'rule?': 'string',
  'explanation?': 'string',
  'back?': 'string',
});

export const Route = createFileRoute('/admin/reports/')({
  validateSearch: Search,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const data = await loadQueue({ data: deps });
    if (data.access === 'signed-out') {
      throw redirect({
        to: '/auth/sign-in',
        search: { redirect: queueHref({ tab: 'open', community: null, sort: 'oldest' }) },
        statusCode: 303,
      });
    }
    return data;
  },
  head: () => ({ links: [{ rel: 'stylesheet', href: queueCss }] }),
  component: Queue,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const form = Body(await readForm(request));
        const base = '/admin/reports';
        if (form instanceof type.errors) return answer(request, cookies, { error: 'form.invalid', back: base });
        // The way back is a queue address (its tab, community and sort); anything else goes to the queue itself.
        const back = form.back?.startsWith(`${base}?`) || form.back === base ? form.back : base;
        if (!session) return answer(request, cookies, { redirect: `/auth/sign-in?${new URLSearchParams({ redirect: back })}` });
        const parsed = Target(form.target);
        if (parsed instanceof type.errors) return answer(request, cookies, { error: 'form.invalid', back });
        const [kind, id] = parsed.split(':') as ['post' | 'comment' | 'actor', string];
        if (!Uuid.allows(id)) return answer(request, cookies, { error: 'form.invalid', back });
        const target: ReportTarget = { kind, id };
        const key = { target, audience: form.audience };
        const principal = principalOf(session.view);
        const note = form.note?.trim() || null;
        const result =
          form.intent === 'resolve' || form.intent === 'dismiss'
            ? await resolveReportsAs(principal, key, { resolution: form.intent === 'resolve' ? 'resolved' : 'dismissed', note })
            : form.intent === 'remove'
              ? await removeFromReportAs(principal, key, { rule: Number(form.rule), explanation: form.explanation ?? '' })
              : await routeReportsAs(principal, key, form.intent === 'escalate' ? 'admins' : 'moderators');
        if (!result.ok) return answer(request, cookies, { error: asReportError(result.reason) ?? 'generic', back });
        return answer(request, cookies, { redirect: back });
      },
    },
  },
});

function Queue() {
  const { t } = useTranslate();
  useRouteHydrated();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  if (data.access !== 'ok') {
    return (
      <main className="pb-page rq-page">
        <Text as="h1" variant="heading" size="sm">
          {t('reports', 'queue.title')}
        </Text>
        <Notice tone="danger" role="alert">
          {t('reports', 'queue.notStaff')}
        </Notice>
      </main>
    );
  }
  const view: QueueView = {
    tab: data.tab,
    community: data.community,
    sort: data.sort,
    // Kept in every row link and form's way back, so a later page stays that page; the tabs and the filter drop it.
    cursor: search.cursor ?? null,
    show: search.show ?? null,
    details: search.details ?? null,
    remove: search.remove ?? null,
  };
  const tabs = data.admin
    ? (['open', 'escalated', 'admins', 'resolved', 'dismissed'] as const)
    : (['open', 'escalated', 'resolved', 'dismissed'] as const);
  const error = asReportError(search.error);
  return (
    <main className="pb-page rq-page">
      <Text as="h1" variant="heading" size="sm">
        {t('reports', 'queue.title')}
      </Text>
      <LinkTabs
        aria-label={t('reports', 'queue.tabs')}
        items={tabs.map((tab) => ({
          to: queueHref(view, { tab, cursor: null, show: null, details: null, remove: null }),
          label: t('reports', `queue.tab.${tab}`),
          active: tab === data.tab,
        }))}
      />
      <form method="get" action="/admin/reports" className="rq-filter">
        <input type="hidden" name="tab" value={data.tab} />
        <Select
          name="community"
          size="sm"
          label={t('reports', 'queue.community')}
          defaultValue={data.community ?? ''}
          items={[
            { id: '', label: t('reports', 'queue.community.all') },
            ...data.communities.map((community) => ({ id: community.id, label: `!${community.handle}` })),
          ]}
        />
        <Select
          name="sort"
          size="sm"
          label={t('reports', 'queue.sort')}
          defaultValue={data.sort}
          items={(['oldest', 'newest', 'most'] as const).map((sort) => ({ id: sort, label: t('reports', `queue.sort.${sort}`) }))}
        />
        <Button type="submit" variant="neutral" size="sm">
          {t('reports', 'queue.apply')}
        </Button>
      </form>
      {error && (
        <Notice tone="danger" role="alert">
          {t('reports', errorKey(error))}
        </Notice>
      )}
      {data.groups.length === 0 ? (
        <EmptyState title={t('reports', data.tab === 'open' ? 'queue.empty.open' : 'queue.empty.other')} />
      ) : (
        <QueueTable groups={data.groups} tab={data.tab} admin={data.admin} view={view} now={data.now} />
      )}
      {data.next && (
        <Pager
          aria-label={t('reports', 'queue.pages')}
          next={{
            href: queueHref(view, { cursor: data.next, show: null, details: null, remove: null }),
            label: t('reports', 'queue.more'),
          }}
        />
      )}
    </main>
  );
}
