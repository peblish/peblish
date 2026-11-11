import { attempt } from '@peblish/core/identity/throttle';
import { createReportAs } from '@peblish/core/reports/actions';
import { ReportCategory, mayFederate } from '@peblish/core/reports/categories';
import { Uuid } from '@peblish/schema/ids';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { clientIp, forbidden, formSession, privateResponses, principalOf, readForm, sameOrigin } from '../../server/auth.ts';
import { reportBack } from './-back.ts';
import { answer, type Outcome } from './-form.ts';
import { loadReportForm } from './-load.ts';
import { asReportError, errorKey } from './-ui/errors.ts';
import { ReportFormView } from './-ui/report-form.tsx';
import reportCss from './-ui/report.css?url';

// /report?kind=post|comment|actor&id=<uuid>&back=<path>: the report form as a page. It is the
// same form the Report control opens in a dialog once hydrated. Signed out, GET answers 303 to
// sign-in and back. A target that is gone or withheld is not found; your own content, a ban and
// a report already open are said on the page. A plain POST answers 303 to the sent page, or back
// here with ?error=<code>. Typed details are not put in the URL (reports can be sensitive and
// URLs reach logs), so without JavaScript a refusal keeps the category only. `back` reaches the
// Cancel link only through reportBack on the server.

const Search = type({
  'kind?': 'string',
  'id?': 'string',
  'back?': 'string',
  'error?': 'string',
  'category?': 'string',
});

const Body = type({
  kind: "'post' | 'comment' | 'actor'",
  id: Uuid,
  'back?': 'string',
  'category?': 'string',
  'details?': 'string',
  'forward?': 'string',
  /** The hosts the form named for forwarding, space-separated. */
  'hosts?': 'string',
});

const notFoundReasons: ReadonlySet<string> = new Set([
  'target.not_found',
  'target.deleted',
  'target.removed',
  'community.removed',
  'community.deleted',
]);

export const Route = createFileRoute('/report/')({
  validateSearch: Search,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const target = type({ kind: "'post' | 'comment' | 'actor'", id: Uuid })({ kind: deps.kind, id: deps.id });
    if (target instanceof type.errors) throw notFound();
    const here = `/report?${new URLSearchParams({ kind: target.kind, id: target.id, ...(deps.back && { back: deps.back }) })}`;
    const { back, ...result } = await loadReportForm({ data: { ...target, ...(deps.back && { back: deps.back }) } });
    if (!result.ok && result.reason === 'auth.required') {
      throw redirect({ to: '/auth/sign-in', search: { redirect: here }, statusCode: 303 });
    }
    if (!result.ok && notFoundReasons.has(result.reason)) throw notFound();
    return result.ok ? { form: result, refusal: null, back } : { form: null, refusal: result.reason, back };
  },
  head: () => ({ links: [{ rel: 'stylesheet', href: reportCss }] }),
  component: ReportPage,
  server: {
    middleware: [privateResponses],
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session } = await formSession(request);
        const cookies = session?.setCookies ?? [];
        const form = Body(await readForm(request));
        const origin = new URL(request.url).origin;
        if (form instanceof type.errors) return answer(request, cookies, { error: 'form.invalid', back: '/' });
        const back = reportBack(form.back, origin);
        const here = `/report?${new URLSearchParams({ kind: form.kind, id: form.id, back })}`;
        const fail = (error: Parameters<typeof asReportError>[0], keep?: Record<string, string | undefined>): Outcome => ({
          error: asReportError(error) ?? 'generic',
          back: here,
          ...(keep && { keep }),
        });
        if (!session) return answer(request, cookies, { redirect: `/auth/sign-in?${new URLSearchParams({ redirect: here })}` });
        const category = ReportCategory(form.category);
        if (category instanceof type.errors) return answer(request, cookies, fail('category.required'));
        const details = (form.details ?? '').replaceAll('\r\n', '\n').trim();
        if (details.length > 2000) return answer(request, cookies, fail('details.too_long', { category }));
        if (category === 'other' && details === '') return answer(request, cookies, fail('details.required', { category }));
        const counted = await attempt('report', { ip: clientIp(request), id: session.view.actorId });
        if (!counted.allowed) return answer(request, cookies, fail('rate.limited', { category }));
        const forward = form.forward === 'yes' && mayFederate(category, form.kind === 'actor' ? 'actor' : form.kind);
        const made = await createReportAs(principalOf(session.view), {
          target: { kind: form.kind, id: form.id },
          category,
          forward,
          details,
          hosts: (form.hosts ?? '').split(/\s+/).filter(Boolean),
        });
        if (!made.ok) return answer(request, cookies, fail(made.reason, { category }));
        return answer(request, cookies, { redirect: `/report/sent?${new URLSearchParams({ n: String(made.number), back })}` });
      },
    },
  },
});

function ReportPage() {
  const { t } = useTranslate();
  useRouteHydrated();
  const { form, refusal, back } = Route.useLoaderData();
  const search = Route.useSearch();
  const kind = form ? (form.target.kind === 'actor' ? form.about.kind : form.target.kind) : null;
  return (
    <main className="rp-page">
      {form && kind ? (
        <>
          <Text as="h1" variant="display" size="sm">
            {t('reports', `form.title.${kind}`)}
          </Text>
          <ReportFormView form={form} back={back} initialError={asReportError(search.error)} initialCategory={search.category} />
        </>
      ) : (
        <>
          <Text as="h1" variant="display" size="sm">
            {t('reports', 'form.open')}
          </Text>
          <Text as="p" role="alert">
            {t('reports', errorKey(asReportError(refusal) ?? 'generic'))}
          </Text>
          <Link href={back}>{t('reports', 'sent.done')}</Link>
        </>
      )}
    </main>
  );
}
