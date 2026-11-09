import { putFlash, takeFlash } from '@peblish/core/identity/flash';
import { mediaOverview, type MediaOverview } from '@peblish/core/mediascan/overview';
import { addToBlocklist, blockCategories, removeFromBlocklist } from '@peblish/core/mediascan/list';
import { confirmQuarantined, holdQuarantined, releaseQuarantined } from '@peblish/core/mediascan/review';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { type } from 'arktype';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { authHead, SearchText } from '../../auth/-ui/page.tsx';
import { Evidence, Failed, Hashes, Review, sections, Status, StatusStrip, SubNav, Warning, type Section } from './-ui/sections.tsx';
import mediaCss from './-ui/media.css?url';

// The admin Media tab (R2b pick media-split): scanner status, the quarantine review with one
// shared decision control, the blocked-image list, failed scans, evidence manifests. Admins only
// (a moderator sees the Reports tab and nothing here); the page shows metadata and never an image.

const Search = type({
  'section?': SearchText,
  'item?': SearchText,
  'error?': SearchText,
  'value?': SearchText,
});

/** The refusals and form errors this page has a message for (error.<code> in mediascan.json). */
const errorCodes = [
  'media.not_pending',
  'media.not_quarantined',
  'media.already_decided',
  'media.hash_invalid',
  'media.hash_exists',
  'media.hold_invalid',
  'auth.required',
  'auth.admin_required',
  'target.not_found',
  'form.invalid',
  'generic',
] as const;
type ErrorCode = (typeof errorCodes)[number];
const asErrorCode = (value: string | undefined): ErrorCode | undefined => errorCodes.find((code) => code === value);

/** What the last POST did, carried once to the page it redirects to (identity/flash.ts). */
const NOTICE = 'media-notice';
const Notice = type({
  kind: "'confirmed' | 'released' | 'held' | 'hash-added' | 'hash-removed'",
  'removed?': 'number',
  'refused?': 'number',
  'count?': 'number',
});

const loadMedia = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await pageSession();
  if (!session) throw redirect({ to: '/auth/sign-in', search: { redirect: '/admin/media' } });
  const access = session.role !== 'admin' ? 'not-admin' : session.view.siteRole !== 'admin' ? 'needs-two-factor' : 'ok';
  if (access !== 'ok') return { access } as const;
  const [overview, flash] = await Promise.all([mediaOverview(), takeFlash(session.sessionId, NOTICE)]);
  const parsed = flash ? Notice(JSON.parse(flash)) : null;
  const notice = parsed instanceof type.errors ? null : parsed;
  return { access, overview, notice } as const;
});

const Body = type({
  intent: "'confirm' | 'hold' | 'release' | 'add-hash' | 'remove-hash'",
  'item?': 'string.uuid',
  'entry?': 'string.uuid',
  'note?': 'string <= 500',
  'removePosts?': 'string',
  'authority?': "'afp' | 'ncmec' | 'nca'",
  'reference?': 'string <= 200',
  'until?': 'string',
  'value?': 'string <= 200',
  'category?': 'string',
  'reason?': 'string <= 500',
});

const page = (section: Section, extra: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams({ section });
  for (const [name, value] of Object.entries(extra)) if (value) params.set(name, value);
  return `${adminPaths.media}?${params}`;
};

export const Route = createFileRoute('/admin/media/')({
  validateSearch: Search,
  loader: () => loadMedia(),
  head: () => ({ links: [...(authHead().links ?? []), { rel: 'stylesheet', href: mediaCss }] }),
  component: MediaTab,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        const { session, reply } = await formSession(request);
        if (!session) return reply({ redirect: '/auth/sign-in?redirect=%2Fadmin%2Fmedia' });
        const body = Body(await readForm(request));
        if (body instanceof type.errors) return reply({ redirect: page('review', { error: 'form.invalid' }) });
        const principal = principalOf(session.view);
        const notice = (value: typeof Notice.infer) => putFlash(session.sessionId, NOTICE, JSON.stringify(value));
        const failed = (section: Section, reason: string, extra: Record<string, string | undefined> = {}) =>
          reply({ redirect: page(section, { error: reason, ...extra }) });
        const note = body.note?.trim() || null;

        if (body.intent === 'confirm' || body.intent === 'hold' || body.intent === 'release') {
          if (!body.item) return failed('review', 'form.invalid');
          const item = { item: body.item };
          if (body.intent === 'confirm') {
            const result = await confirmQuarantined(principal, { mediaId: body.item, removePosts: body.removePosts === 'on', note });
            if (!result.ok) return failed('review', result.reason, item);
            await notice({ kind: 'confirmed', removed: result.removedPosts, refused: result.refusedPosts });
          } else if (body.intent === 'release') {
            if (!note) return failed('review', 'form.invalid', item);
            const result = await releaseQuarantined(principal, { mediaId: body.item, note });
            if (!result.ok) return failed('review', result.reason, item);
            await notice({ kind: 'released' });
          } else {
            const until = /^\d{4}-\d{2}-\d{2}$/.test(body.until ?? '') ? new Date(`${body.until}T23:59:59.000Z`) : null;
            if (!body.authority) return failed('review', 'form.invalid', item);
            if (!until || Number.isNaN(until.getTime())) return failed('review', 'media.hold_invalid', item);
            const result = await holdQuarantined(principal, {
              mediaId: body.item,
              authority: body.authority,
              reference: body.reference ?? '',
              until,
            });
            if (!result.ok) return failed('review', result.reason, item);
            await notice({ kind: 'held' });
            return reply({ redirect: page('review', item) });
          }
          return reply({ redirect: page('review') });
        }
        if (body.intent === 'add-hash') {
          const category = blockCategories.find((candidate) => candidate === body.category);
          if (!category) return failed('hashes', 'form.invalid', { value: body.value });
          const result = await addToBlocklist(principal, { value: body.value ?? '', category, reason: body.reason?.trim() || null });
          if (!result.ok) return failed('hashes', result.reason, { value: body.value });
          await notice({ kind: 'hash-added', count: result.quarantined });
          return reply({ redirect: page('hashes') });
        }
        if (!body.entry) return failed('hashes', 'form.invalid');
        const result = await removeFromBlocklist(principal, body.entry);
        if (!result.ok) return failed('hashes', result.reason);
        await notice({ kind: 'hash-removed' });
        return reply({ redirect: page('hashes') });
      },
    },
  },
});

function NoticeBanner({ notice }: { notice: typeof Notice.infer }) {
  const { t, locale } = useTranslate();
  const parts: string[] = [];
  if (notice.kind === 'confirmed') {
    parts.push(t('mediascan', 'media.notice.confirmed'));
    if (notice.removed) parts.push(translatePlural(locale, 'mediascan', 'media.notice.removedPosts', notice.removed));
    if (notice.refused) parts.push(translatePlural(locale, 'mediascan', 'media.notice.refusedPosts', notice.refused));
  } else if (notice.kind === 'hash-added') parts.push(translatePlural(locale, 'mediascan', 'media.notice.hashAdded', notice.count ?? 0));
  else if (notice.kind === 'hash-removed') parts.push(t('mediascan', 'media.notice.hashRemoved'));
  else parts.push(t('mediascan', notice.kind === 'released' ? 'media.notice.released' : 'media.notice.held'));
  return (
    <p className="flash ok" role="status" data-testid="media-notice">
      {parts.join(' ')}
    </p>
  );
}

function MediaTab() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <main className="auth-page">
        <h1>{t('mediascan', 'media.title')}</h1>
        {data.access === 'needs-two-factor' ? (
          <p role="alert">
            {t('mediascan', 'media.needsTwoFactor')} <Link to="/settings/security">{t('mediascan', 'media.securityLink')}</Link>
          </p>
        ) : (
          <p role="alert">{t('mediascan', 'media.notAdmin')}</p>
        )}
      </main>
    );
  const { overview, notice } = data;
  const section: Section = sections.find((key) => key === search.section) ?? 'review';
  const error = asErrorCode(search.error);
  return (
    <main className="auth-page wide media-admin">
      <h1>{t('mediascan', 'media.title')}</h1>
      <Warning scanner={overview.scanner} />
      <StatusStrip overview={overview} />
      {notice && <NoticeBanner notice={notice} />}
      {search.error && (
        <p className="flash err" role="alert" data-testid="media-error">
          <b>{t('mediascan', 'media.failedTitle')}</b> {t('mediascan', `error.${error ?? 'generic'}`)}
        </p>
      )}
      <SubNav section={section} counts={overview.counts} />
      <Sections section={section} overview={overview} item={search.item} value={search.value} />
    </main>
  );
}

function Sections({
  section,
  overview,
  item,
  value,
}: {
  section: Section;
  overview: MediaOverview;
  item: string | undefined;
  value: string | undefined;
}) {
  switch (section) {
    case 'review':
      return <Review overview={overview} item={item} />;
    case 'failed':
      return <Failed rows={overview.failed} />;
    case 'hashes':
      return <Hashes rows={overview.hashes} value={value} />;
    case 'evidence':
      return <Evidence rows={overview.evidence} />;
    case 'status':
      return <Status overview={overview} />;
  }
}
