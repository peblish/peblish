import { putFlash, takeFlash } from '@peblish/core/identity/flash';
import { mediaOverview, type MediaOverview } from '@peblish/core/mediascan/overview';
import { addToBlocklist, blockCategories, removeFromBlocklist } from '@peblish/core/mediascan/list';
import { confirmQuarantined, holdQuarantined, releaseQuarantined } from '@peblish/core/mediascan/review';
import { Notice as NoticeBox } from '@peblish/ui/components/notice';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseStatus } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { translatePlural } from '../../../i18n/translate.ts';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { forbidden, formSession, pageSession, principalOf, readForm, sameOrigin } from '../../../server/auth.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { adminPaths } from '../../../shell/paths.ts';
import { SearchText } from '../../auth/-route.ts';
import { Denial } from '../-denial.tsx';
import { accessOf } from '../settings/-access.ts';
import { Evidence, Failed, Hashes, Review, sections, Status, StatusStrip, SubNav, Warning, type Section } from './-ui/sections.tsx';
import mediaCss from './-ui/media.css?url';
import { headTitle } from '../../../shell/title.ts';

// The admin Media tab (R2b pick media-split): scanner status, the quarantine review with one
// shared decision control, the blocked-image list, failed scans, evidence manifests. Admins only
// (a moderator sees the Reports tab and nothing here); the page shows metadata and never an image.

const Search = type({
  'section?': SearchText,
  'item?': SearchText,
  'error?': SearchText,
  'value?': SearchText,
  /** The evidence manifest rendered open, for its link without scripts. */
  'manifest?': SearchText,
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
  const access = accessOf(session);
  if (access !== 'ok') {
    // A denial is a 403 with no data, as the Reports tab answers one.
    setResponseStatus(403);
    return { access } as const;
  }
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
  head: (context) => ({ meta: headTitle(context, 'mediascan', 'media.title'), links: [{ rel: 'stylesheet', href: mediaCss }] }),
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
    <NoticeBox tone="success" role="status" data-testid="media-notice">
      {parts.join(' ')}
    </NoticeBox>
  );
}

function MediaTab() {
  const { t } = useTranslate();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  useRouteHydrated();
  if (data.access !== 'ok')
    return (
      <main className="pb-page media-admin">
        <Text as="h1" variant="heading" size="sm">
          {t('mediascan', 'media.title')}
        </Text>
        <Denial
          access={data.access}
          copy={{
            needsTwoFactor: t('mediascan', 'media.needsTwoFactor'),
            securityLink: t('mediascan', 'media.securityLink'),
            notAdmin: t('mediascan', 'media.notAdmin'),
          }}
        />
      </main>
    );
  const { overview, notice } = data;
  const section: Section = sections.find((key) => key === search.section) ?? 'review';
  const error = asErrorCode(search.error);
  return (
    <main className="pb-page media-admin">
      <Text as="h1" variant="heading" size="sm">
        {t('mediascan', 'media.title')}
      </Text>
      <Warning scanner={overview.scanner} />
      <StatusStrip overview={overview} />
      {notice && <NoticeBanner notice={notice} />}
      {search.error && (
        <NoticeBox tone="danger" role="alert" title={t('mediascan', 'media.failedTitle')} data-testid="media-error">
          {t('mediascan', `error.${error ?? 'generic'}`)}
        </NoticeBox>
      )}
      <SubNav section={section} counts={overview.counts} />
      <Sections section={section} overview={overview} item={search.item} value={search.value} manifest={search.manifest} />
    </main>
  );
}

function Sections({
  section,
  overview,
  item,
  value,
  manifest,
}: {
  section: Section;
  overview: MediaOverview;
  item: string | undefined;
  value: string | undefined;
  manifest: string | undefined;
}) {
  switch (section) {
    case 'review':
      return <Review overview={overview} item={item} />;
    case 'failed':
      return <Failed rows={overview.failed} />;
    case 'hashes':
      return <Hashes rows={overview.hashes} value={value} />;
    case 'evidence':
      return <Evidence rows={overview.evidence} open={manifest} />;
    case 'status':
      return <Status overview={overview} />;
  }
}
