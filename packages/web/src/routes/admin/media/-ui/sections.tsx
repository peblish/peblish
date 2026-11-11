import type { EvidenceRow, FailedRow, HashRow, MediaOverview, QuarantineRow } from '@peblish/core/mediascan/overview';
import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { EmptyState } from '@peblish/ui/components/empty-state';
import { FactList } from '@peblish/ui/components/fact-list';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { LinkedDisclosure } from '@peblish/ui/components/linked-disclosure';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Notice } from '@peblish/ui/components/notice';
import { Select } from '@peblish/ui/components/select';
import { Table } from '@peblish/ui/components/table';
import { Tabs } from '@peblish/ui/components/tabs';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import { useState } from 'react';
import { translatePlural } from '../../../../i18n/translate.ts';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { adminPaths } from '../../../../shell/paths.ts';
import { useDate } from '../../../auth/-ui/page.tsx';
import { CheckedInput } from '../../-checked-input.tsx';
import { NoEnterSubmit } from '../../-no-enter-submit.tsx';

// The sections of the Media tab (R2b media-split). Every form is a plain POST, so the decisions
// work without JavaScript; the decision panels open and close with it. No image is rendered or
// linked anywhere in it.

export const sections = ['review', 'failed', 'hashes', 'evidence', 'status'] as const;
export type Section = (typeof sections)[number];

export const blockCategories = ['csam', 'intimate_image', 'violent', 'spam', 'other'] as const;

type HoldAuthority = NonNullable<QuarantineRow['holdAuthority']>;

/** Who may direct a hold (core evidence/tables.ts holdAuthorities); only AFP keeps the image file. */
export const holdAuthorities = ['afp', 'ncmec', 'nca'] as const satisfies readonly HoldAuthority[];

type T = ReturnType<typeof useTranslate>['t'];

const authorityLabel = (authority: HoldAuthority | null, t: T) => (authority ? t('mediascan', `media.hold.authority.${authority}`) : '');

/** `2026-11-09 14:05 UTC`: the same text on server and client, whatever the viewer's zone. */
const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const shortHash = (hash: string | null) => (hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : '');

function Who({ person }: { person: { handle: string } | null }) {
  const { t } = useTranslate();
  return person ? (
    // The overview's handle already starts with "@".
    <Handle prefix="@" handle={person.handle.replace(/^@/, '')} />
  ) : (
    <Text size="sm" color="muted">
      {t('mediascan', 'media.hash.bySystem')}
    </Text>
  );
}

/** A hash or other machine value: mono, wrapping anywhere. */
const Hex = ({ children, title, testId }: { children: string; title?: string; testId?: string }) => (
  <Text variant="mono" size="sm" className="media-hex" title={title} data-testid={testId}>
    {children}
  </Text>
);

export function Warning({ scanner }: { scanner: MediaOverview['scanner'] }) {
  const { t } = useTranslate();
  if (scanner.kind === 'provider') return null;
  const key = scanner.kind === 'none' ? 'none' : 'local';
  return (
    <Notice tone="warning" role="alert" title={t('mediascan', `media.warn.${key}.title`)} data-testid="scanner-warning">
      {t('mediascan', `media.warn.${key}.text`)}
    </Notice>
  );
}

export function StatusStrip({ overview }: { overview: MediaOverview }) {
  const { t } = useTranslate();
  const { scanner } = overview;
  const onOff = (on: boolean) => <Badge tone={on ? 'success' : 'neutral'}>{t('mediascan', on ? 'media.on' : 'media.off')}</Badge>;
  return (
    <div className="media-strip" data-testid="media-status">
      <FactList
        layout="inline"
        items={[
          {
            key: 'scanner',
            label: t('mediascan', 'media.scanner'),
            value:
              scanner.kind === 'provider' ? (
                <Badge tone="success">{t('mediascan', 'media.scanner.provider', { name: scanner.providers.join(', ') })}</Badge>
              ) : (
                <Badge tone="warning">{t('mediascan', scanner.kind === 'local-only' ? 'media.scanner.local' : 'media.scanner.none')}</Badge>
              ),
          },
          { key: 'uploads', label: t('mediascan', 'media.uploads'), value: onOff(overview.uploadsEnabled) },
          { key: 'remote', label: t('mediascan', 'media.remote'), value: onOff(overview.remoteMediaEnabled) },
          { key: 'hashes', label: t('mediascan', 'media.hashes'), value: overview.counts.hashes },
        ]}
      />
      {/* uploads.enabled and remote_media.enabled are changed in the admin settings (lane ADM). */}
      <Link href={adminPaths.settings}>{t('mediascan', 'media.settingsLink')}</Link>
    </div>
  );
}

export function SubNav({ section, counts }: { section: Section; counts: MediaOverview['counts'] }) {
  const { t } = useTranslate();
  const n: Partial<Record<Section, number>> = {
    review: counts.quarantined,
    failed: counts.failed24h,
    hashes: counts.hashes,
    evidence: counts.evidence,
  };
  return (
    <LinkTabs
      aria-label={t('mediascan', 'media.sections')}
      items={sections.map((key) => ({
        to: `${adminPaths.media}?section=${key}`,
        active: key === section,
        label: (
          <>
            {t('mediascan', `media.nav.${key}`)}
            {n[key] !== undefined && <Text color="muted"> {n[key]}</Text>}
          </>
        ),
      }))}
    />
  );
}

const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

/** What the admin has set in the three decisions so far, for one image. */
type Draft = { removePosts: boolean; note: string; authority: string; reference: string; until: string; releaseNote: string };

/**
 * One shared decision control: three exclusive panels as Mux Tabs, Confirm first, each a plain POST
 * form. The selected panel is in the server's page, so Confirm works without JavaScript.
 *
 * Mux Tabs unmount the panels not shown, so every field is controlled from the draft held here:
 * an unticked "remove posts" or a note stays as it was after a look at another decision. Only the
 * panel shown is in the page, so the decision posted is always the one on screen. The caller keys
 * this by the image, so one image's draft never shows on another. A disabled first submit button
 * in each form makes Enter in a field decide nothing.
 */
function Decision({ row }: { row: QuarantineRow }) {
  const { t } = useTranslate();
  const tomorrow = new Date(Date.parse(row.quarantinedAt) + 366 * 86_400_000).toISOString().slice(0, 10);
  const [draft, setDraft] = useState<Draft>({
    removePosts: true,
    note: '',
    authority: '',
    reference: '',
    until: tomorrow,
    releaseNote: '',
  });
  const field =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));
  return (
    <Tabs
      aria-label={t('mediascan', 'media.decision')}
      defaultValue="confirm"
      className="media-decision"
      items={[
        {
          id: 'confirm',
          label: t('mediascan', 'media.confirm.title'),
          panel: (
            <form method="post" action={adminPaths.media} aria-label={t('mediascan', 'media.confirm.title')} className="media-form">
              <NoEnterSubmit />
              {hidden('item', row.mediaId)}
              <Text as="p" size="sm" color="muted">
                {t('mediascan', 'media.confirm.help')}
              </Text>
              <Checkbox name="removePosts" checked={draft.removePosts} onChange={field('removePosts')}>
                {t('mediascan', 'media.confirm.removePosts')}
              </Checkbox>
              <TextField
                name="note"
                maxLength={500}
                label={`${t('mediascan', 'media.note')} ${t('mediascan', 'media.optional')}`}
                value={draft.note}
                onChange={field('note')}
              />
              <div>
                <Button type="submit" name="intent" value="confirm" variant="primary">
                  {t('mediascan', 'media.confirm.submit')}
                </Button>
              </div>
            </form>
          ),
        },
        {
          id: 'hold',
          label: t('mediascan', 'media.hold.title'),
          panel: (
            <form method="post" action={adminPaths.media} aria-label={t('mediascan', 'media.hold.heading')} className="media-form">
              <NoEnterSubmit />
              {hidden('item', row.mediaId)}
              <Text as="p" size="sm" color="muted">
                {t('mediascan', 'media.hold.help')}
              </Text>
              <Select
                name="authority"
                label={t('mediascan', 'media.hold.authority')}
                placeholder={t('mediascan', 'media.hold.authorityChoose')}
                value={draft.authority}
                onChange={field('authority')}
                required
                items={holdAuthorities.map((authority) => ({ id: authority, label: t('mediascan', `media.hold.authority.${authority}`) }))}
              />
              <TextField
                name="reference"
                maxLength={200}
                required
                label={t('mediascan', 'media.hold.reference')}
                placeholder={t('mediascan', 'media.hold.referencePlaceholder')}
                value={draft.reference}
                onChange={field('reference')}
              />
              {/* A native date input on Mux's Input parts: it posts YYYY-MM-DD without JavaScript. */}
              <CheckedInput
                label={t('mediascan', 'media.hold.until')}
                type="date"
                name="until"
                value={draft.until}
                onChange={field('until')}
                required
              />
              <div>
                <Button type="submit" name="intent" value="hold" variant="neutral">
                  {t('mediascan', 'media.hold.submit')}
                </Button>
              </div>
            </form>
          ),
        },
        {
          id: 'release',
          label: t('mediascan', 'media.release.title'),
          panel: (
            <form method="post" action={adminPaths.media} aria-label={t('mediascan', 'media.release.title')} className="media-form">
              <NoEnterSubmit />
              {hidden('item', row.mediaId)}
              <Text as="p" size="sm" color="muted">
                {t('mediascan', 'media.release.help')}
              </Text>
              <TextField
                name="note"
                maxLength={500}
                required
                label={t('mediascan', 'media.release.note')}
                placeholder={t('mediascan', 'media.release.notePlaceholder')}
                value={draft.releaseNote}
                onChange={field('releaseNote')}
              />
              <div>
                <Button type="submit" name="intent" value="release" variant="neutral">
                  {t('mediascan', 'media.release.submit')}
                </Button>
              </div>
            </form>
          ),
        },
      ]}
    />
  );
}

function verdictOf(row: QuarantineRow, t: T) {
  const kind = t('mediascan', row.matchType ? `media.match.${row.matchType}` : 'media.match.none');
  return row.classification === 'test' ? `${kind}, ${t('mediascan', 'media.d.test')}` : `${kind}, ${row.classification}`;
}

function Detail({ row }: { row: QuarantineRow }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  return (
    <Card.Root variant="outlined" padding="sm" className="media-detail" data-testid="media-detail">
      <Card.Header>
        <Text as="h2" variant="mono" size="md">
          {shortHash(row.sha256)}
        </Text>
      </Card.Header>
      <Card.Body>
        <FactList
          items={[
            { key: 'verdict', label: t('mediascan', 'media.d.verdict'), value: verdictOf(row, t) },
            { key: 'provider', label: t('mediascan', 'media.d.provider'), value: row.source },
            { key: 'uploader', label: t('mediascan', 'media.d.uploader'), value: <Who person={row.uploader} /> },
            { key: 'uploaded', label: t('mediascan', 'media.d.uploaded'), value: stamp(row.uploadedAt) },
            { key: 'quarantined', label: t('mediascan', 'media.d.quarantined'), value: stamp(row.quarantinedAt) },
            { key: 'sha', label: t('mediascan', 'media.d.sha'), value: <Hex>{row.sha256 ?? ''}</Hex> },
            {
              key: 'type',
              label: t('mediascan', 'media.d.type'),
              value: `${row.mimeType}, ${
                row.byteSize === null ? '' : `${new Intl.NumberFormat(locale).format(Math.max(1, Math.round(row.byteSize / 1024)))} kB`
              }`,
            },
            {
              key: 'posts',
              label: t('mediascan', 'media.d.posts'),
              value:
                row.livePosts.length === 0 ? (
                  t('mediascan', 'media.d.none')
                ) : (
                  <ul className="media-used-by">
                    {row.livePosts.map((post) => (
                      <li key={post.id}>
                        <Link className="pb-link-quiet" href={`/post/${post.id}`}>
                          {post.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ),
            },
            ...(row.holdReference && row.holdUntil
              ? [
                  {
                    key: 'hold',
                    label: t('mediascan', 'media.d.hold'),
                    value: t('mediascan', 'media.d.holdValue', {
                      authority: authorityLabel(row.holdAuthority, t),
                      reference: row.holdReference,
                      date: date(row.holdUntil),
                    }),
                  },
                ]
              : []),
            // Only an AFP hold stops the automatic block; under an NCMEC or NCA hold it still comes.
            ...(!row.bytesHeld
              ? [
                  {
                    key: 'auto',
                    label: t('mediascan', 'media.d.autoBlock'),
                    value: t('mediascan', 'media.d.autoBlockAt', { date: stamp(row.blocksAt) }),
                  },
                ]
              : []),
          ]}
        />
        <Decision key={row.mediaId} row={row} />
      </Card.Body>
    </Card.Root>
  );
}

export function Review({ overview, item }: { overview: MediaOverview; item: string | undefined }) {
  const { t, locale } = useTranslate();
  const rows = overview.quarantine;
  if (rows.length === 0) return <EmptyState title={t('mediascan', 'media.review.empty')} />;
  const selected = rows.find((row) => row.mediaId === item) ?? rows[0]!;
  return (
    <>
      <div className="media-split">
        <Card.Root variant="outlined" padding="sm" className="media-list-card">
          <ul className="media-list" aria-label={t('mediascan', 'media.review.list')}>
            {rows.map((row) => (
              <li key={row.mediaId} data-testid="quarantine-row">
                <Link
                  href={`${adminPaths.media}?section=review&item=${row.mediaId}`}
                  current={row === selected}
                  className="media-list__item"
                >
                  <span className="media-list__head">
                    <Text variant="mono" size="sm">
                      {shortHash(row.sha256)}
                    </Text>
                    <Text size="sm" color="muted">
                      {stamp(row.quarantinedAt).slice(0, 10)}
                    </Text>
                  </span>
                  <Text size="sm" color="muted">
                    <Who person={row.uploader} />, {verdictOf(row, t)}
                  </Text>
                  <Text size="sm" color="muted">
                    {row.source},{' '}
                    {row.livePosts.length === 0
                      ? t('mediascan', 'media.review.noPosts')
                      : translatePlural(locale, 'mediascan', 'media.review.posts', row.livePosts.length)}
                  </Text>
                </Link>
              </li>
            ))}
          </ul>
        </Card.Root>
        <Detail row={selected} />
      </div>
      <Text as="p" size="sm" color="muted">
        {t('mediascan', 'media.metadataOnly')}
      </Text>
    </>
  );
}

export function Failed({ rows }: { rows: FailedRow[] }) {
  const { t } = useTranslate();
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title={t('mediascan', 'media.failed.empty')} />
      ) : (
        <Card.Root variant="outlined" padding="sm" className="media-table">
          <Table
            aria-label={t('mediascan', 'media.nav.failed')}
            columns={[
              { id: 'upload', label: t('mediascan', 'media.failed.upload'), isRowHeader: true },
              { id: 'uploader', label: t('mediascan', 'media.failed.uploader') },
              { id: 'time', label: t('mediascan', 'media.failed.time') },
              { id: 'reason', label: t('mediascan', 'media.failed.reason') },
            ]}
            rows={rows.map((row) => ({
              id: row.mediaId,
              values: {
                upload: <Hex>{row.mediaId.slice(-8)}</Hex>,
                uploader: <Who person={row.uploader} />,
                time: stamp(row.at),
                reason: row.reason,
              },
            }))}
          />
        </Card.Root>
      )}
      <Text as="p" size="sm" color="muted">
        {t('mediascan', 'media.failed.help')}
      </Text>
    </>
  );
}

export function Hashes({ rows, value }: { rows: HashRow[]; value: string | undefined }) {
  const { t } = useTranslate();
  return (
    <>
      <form method="post" action={adminPaths.media} className="media-add-hash" aria-label={t('mediascan', 'media.hash.add')}>
        {/* Mux's Input parts rather than TextField: the hash is mono, without autocomplete or spell checking. */}
        <CheckedInput
          label={t('mediascan', 'media.hash.value')}
          defaultValue={value}
          required
          name="value"
          className="media-hex"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('mediascan', 'media.hash.valuePlaceholder')}
        />
        <Select
          name="category"
          label={t('mediascan', 'media.hash.category')}
          defaultValue="csam"
          items={blockCategories.map((category) => ({ id: category, label: t('mediascan', `media.category.${category}`) }))}
        />
        <TextField
          name="reason"
          maxLength={500}
          label={t('mediascan', 'media.hash.reason')}
          placeholder={t('mediascan', 'media.hash.reasonPlaceholder')}
        />
        <Button type="submit" name="intent" value="add-hash" variant="primary">
          {t('mediascan', 'media.hash.submit')}
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title={t('mediascan', 'media.hash.empty')} />
      ) : (
        <Card.Root variant="outlined" padding="sm" className="media-table">
          <Table
            aria-label={t('mediascan', 'media.nav.hashes')}
            columns={[
              { id: 'hash', label: t('mediascan', 'media.hash.colHash'), isRowHeader: true },
              { id: 'category', label: t('mediascan', 'media.hash.colCategory') },
              { id: 'reason', label: t('mediascan', 'media.hash.colReason') },
              { id: 'added', label: t('mediascan', 'media.hash.colAdded') },
              { id: 'remove', label: t('mediascan', 'media.hash.remove') },
            ]}
            rows={rows.map((row) => ({
              id: row.id,
              values: {
                // The test id marks the listed hash (a Mux Table row takes no attributes).
                hash: (
                  <Hex title={row.sha256} testId="hash-row">
                    {shortHash(row.sha256)}
                  </Hex>
                ),
                category: t('mediascan', `media.category.${row.category as (typeof blockCategories)[number]}`),
                reason: row.reason,
                added: (
                  <>
                    {stamp(row.addedAt).slice(0, 10)} <Who person={row.addedBy} />
                  </>
                ),
                remove: (
                  <form method="post" action={adminPaths.media}>
                    {hidden('entry', row.id)}
                    <Button type="submit" name="intent" value="remove-hash" variant="neutral" size="sm">
                      {t('mediascan', 'media.hash.remove')}
                    </Button>
                  </form>
                ),
              },
            }))}
          />
        </Card.Root>
      )}
      <Text as="p" size="sm" color="muted">
        {t('mediascan', 'media.hash.help')}
      </Text>
    </>
  );
}

/** Where the server renders a manifest open: without scripts its disclosure is a link here. */
const manifestHref = (id: string) => `${adminPaths.media}?section=evidence&manifest=${id}#manifest-${id}`;

/** One manifest as a record: its facts, and the manifest itself one disclosure away. */
function Manifest({ row, open }: { row: EvidenceRow; open: boolean }) {
  const { t } = useTranslate();
  const date = useDate();
  return (
    <Card.Root variant="outlined" padding="sm" className="media-evidence" data-testid="evidence-row">
      <Card.Header>
        <Text as="h2" variant="label" size="md">
          {t('mediascan', 'media.evidence.manifest')} <Hex title={row.manifestSha256}>{shortHash(row.manifestSha256)}</Hex>
        </Text>
      </Card.Header>
      <Card.Body>
        <FactList
          layout="inline"
          items={[
            { key: 'upload', label: t('mediascan', 'media.evidence.upload'), value: <Hex>{row.mediaId.slice(-8)}</Hex> },
            {
              key: 'decision',
              label: t('mediascan', 'media.evidence.decision'),
              value: (
                <>
                  {row.status === 'open' || !row.decidedAt
                    ? t('mediascan', 'media.evidence.open')
                    : t('mediascan', row.status === 'confirmed' ? 'media.evidence.confirmed' : 'media.evidence.released', {
                        date: date(row.decidedAt),
                      })}
                  {row.status !== 'open' && (
                    <>
                      {' '}
                      <Text size="sm" color="muted">
                        {row.decidedBy
                          ? t('mediascan', 'media.evidence.by', { who: row.decidedBy.handle })
                          : t('mediascan', 'media.evidence.bySystem')}
                      </Text>
                    </>
                  )}
                </>
              ),
            },
            { key: 'bytes', label: t('mediascan', 'media.evidence.bytes'), value: t('mediascan', `media.evidence.bytes.${row.bytes}`) },
            {
              key: 'hold',
              label: t('mediascan', 'media.evidence.hold'),
              value:
                row.holdReference && row.holdUntil ? (
                  <>
                    <Text variant="mono" size="sm">
                      {authorityLabel(row.holdAuthority, t)} {row.holdReference}
                    </Text>{' '}
                    <Text size="sm" color="muted">
                      {date(row.holdUntil)}
                    </Text>
                  </>
                ) : (
                  <Text size="sm" color="muted">
                    {t('mediascan', 'media.evidence.none')}
                  </Text>
                ),
            },
            { key: 'retain', label: t('mediascan', 'media.evidence.retain'), value: row.retainUntil ? date(row.retainUntil) : '' },
          ]}
        />
        <LinkedDisclosure
          id={`manifest-${row.evidenceId}`}
          title={t('mediascan', 'media.evidence.view')}
          openHref={manifestHref(row.evidenceId)}
          defaultExpanded={open}
        >
          <Text as="div" variant="mono" size="xs" className="media-manifest">
            {row.manifest}
          </Text>
        </LinkedDisclosure>
      </Card.Body>
    </Card.Root>
  );
}

/** `open`: the manifest the address asks to show (`?manifest=<evidence id>`). */
export function Evidence({ rows, open }: { rows: EvidenceRow[]; open: string | undefined }) {
  const { t } = useTranslate();
  if (rows.length === 0) return <EmptyState title={t('mediascan', 'media.evidence.empty')} />;
  return (
    <>
      <div className="media-evidence-list">
        {rows.map((row) => (
          <Manifest key={row.evidenceId} row={row} open={row.evidenceId === open} />
        ))}
      </div>
      <Text as="p" size="sm" color="muted">
        {t('mediascan', 'media.evidence.help')}
      </Text>
    </>
  );
}

export function Status({ overview }: { overview: MediaOverview }) {
  const { t, locale } = useTranslate();
  const { scanner, counts } = overview;
  const setting = (key: string, on: boolean) => ({
    key,
    label: (
      <Text variant="mono" size="sm">
        {key}
      </Text>
    ),
    value: (
      <>
        {t('mediascan', on ? 'media.on' : 'media.off')} <Link href={adminPaths.settings}>{t('mediascan', 'media.settingsLink')}</Link>
      </>
    ),
  });
  return (
    <Card.Root variant="outlined" padding="sm" className="media-status">
      <FactList
        data-testid="media-status-detail"
        items={[
          {
            key: 'scanner',
            label: t('mediascan', 'media.status.scanner'),
            value:
              scanner.kind === 'provider'
                ? t('mediascan', 'media.scanner.provider', { name: scanner.providers.join(', ') })
                : scanner.kind === 'local-only'
                  ? t('mediascan', 'media.scanner.local')
                  : `${t('mediascan', 'media.scanner.none')}. ${t('mediascan', 'media.status.noProvider')}`,
          },
          {
            key: 'list',
            label: t('mediascan', 'media.status.list'),
            value: translatePlural(locale, 'mediascan', 'media.status.listValue', counts.hashes),
          },
          setting('uploads.enabled', overview.uploadsEnabled),
          setting('remote_media.enabled', overview.remoteMediaEnabled),
          { key: 'quarantined', label: t('mediascan', 'media.status.quarantined'), value: counts.quarantined },
          { key: 'failed', label: t('mediascan', 'media.status.failed'), value: counts.failed24h },
          { key: 'blocked', label: t('mediascan', 'media.status.blocked'), value: counts.blocked },
          {
            key: 'window',
            label: t('mediascan', 'media.status.window'),
            value: translatePlural(locale, 'mediascan', 'media.status.windowValue', overview.undecidedPurgeDays),
          },
        ]}
      />
    </Card.Root>
  );
}
