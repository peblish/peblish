import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { type } from 'arktype';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { privateResponses } from '../../../server/auth.ts';
import { loadSentReport } from '../-load.ts';
import { hostList } from '../-ui/hosts.ts';
import reportCss from '../-ui/report.css?url';

// /report/sent?n=<number>: the reporter's receipt. Only the person who filed report #N sees it;
// anyone else, signed in or not, gets not found (the case number is not a secret to guess at).
// "The person you reported will not learn who you are" holds only for a report that stayed here;
// a forwarded one says which hosts' moderators can see it.
const Search = type({ 'n?': 'string | number', 'back?': 'string' });

export const Route = createFileRoute('/report/sent/')({
  validateSearch: Search,
  server: { middleware: [privateResponses] },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const number = Number(deps.n);
    if (!Number.isInteger(number) || number < 1) throw notFound();
    const result = await loadSentReport({ data: { number, ...(deps.back && { back: deps.back }) } });
    if (result.signedOut) throw redirect({ to: '/auth/sign-in', search: { redirect: `/report/sent?n=${number}` }, statusCode: 303 });
    if (!result.sent) throw notFound();
    return { ...result.sent, back: result.back };
  },
  head: () => ({ links: [{ rel: 'stylesheet', href: reportCss }] }),
  component: Sent,
});

function Sent() {
  const { t, locale } = useTranslate();
  useRouteHydrated();
  const sent = Route.useLoaderData();
  return (
    <main className="rp-page">
      <Text as="h1" variant="display" size="sm">
        {t('reports', 'sent.title', { number: sent.number })}
      </Text>
      {/* The anonymity promise holds only for a report that stayed here; a forwarded one names every host that can see it. */}
      <Text as="p" className="rp-text">
        {sent.forwardedTo.length > 0
          ? t('reports', 'sent.promise.forwarded', { hosts: hostList(locale, sent.forwardedTo) })
          : t('reports', 'sent.promise')}
      </Text>
      <div className="rp-buttons">
        {sent.blockHandle && (
          <Link href={`/settings/blocks?person=${encodeURIComponent(sent.blockHandle)}`}>
            {t('reports', 'sent.block', { handle: `@${sent.blockHandle}` })}
          </Link>
        )}
        <Link href={sent.back}>{t('reports', 'sent.done')}</Link>
      </div>
    </main>
  );
}
