import type { EvidenceRow, FailedRow, HashRow, MediaOverview, QuarantineRow } from '@peblish/core/mediascan/overview';
import { Button } from '@peblish/ui/components/button';
import { translatePlural } from '../../../../i18n/translate.ts';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { adminPaths } from '../../../../shell/paths.ts';
import { useDate } from '../../../auth/-ui/page.tsx';

// The sections of the Media tab (R2b media-split). Every one is plain HTML with plain POST forms,
// so the tab works without JavaScript. No image is rendered or linked anywhere in it.

export const sections = ['review', 'failed', 'hashes', 'evidence', 'status'] as const;
export type Section = (typeof sections)[number];

export const blockCategories = ['csam', 'intimate_image', 'violent', 'spam', 'other'] as const;

type HoldAuthority = NonNullable<QuarantineRow['holdAuthority']>;

/** Who may direct a hold (core evidence/tables.ts holdAuthorities); only AFP keeps the image file. */
export const holdAuthorities = ['afp', 'ncmec', 'nca'] as const satisfies readonly HoldAuthority[];

const authorityLabel = (authority: HoldAuthority | null, t: ReturnType<typeof useTranslate>['t']) =>
  authority ? t('mediascan', `media.hold.authority.${authority}`) : '';

/** `2026-11-09 14:05 UTC`: the same text on server and client, whatever the viewer's zone. */
const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const shortHash = (hash: string | null) => (hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : '');

function Who({ person }: { person: { handle: string } | null }) {
  const { t } = useTranslate();
  return person ? <span>{person.handle}</span> : <span className="muted">{t('mediascan', 'media.hash.bySystem')}</span>;
}

export function Warning({ scanner }: { scanner: MediaOverview['scanner'] }) {
  const { t } = useTranslate();
  if (scanner.kind === 'provider') return null;
  const key = scanner.kind === 'none' ? 'none' : 'local';
  return (
    <p className="flash warn" role="alert" data-testid="scanner-warning">
      <b>{t('mediascan', `media.warn.${key}.title`)}</b> {t('mediascan', `media.warn.${key}.text`)}
    </p>
  );
}

export function StatusStrip({ overview }: { overview: MediaOverview }) {
  const { t } = useTranslate();
  const { scanner } = overview;
  const onOff = (on: boolean) => <b className={on ? 'ok-t' : undefined}>{t('mediascan', on ? 'media.on' : 'media.off')}</b>;
  return (
    <div className="strip" data-testid="media-status">
      <span>
        {t('mediascan', 'media.scanner')}{' '}
        {scanner.kind === 'provider' ? (
          <b className="ok-t">{t('mediascan', 'media.scanner.provider', { name: scanner.providers.join(', ') })}</b>
        ) : (
          <b className="warn-t">{t('mediascan', scanner.kind === 'local-only' ? 'media.scanner.local' : 'media.scanner.none')}</b>
        )}
      </span>
      <span>
        {t('mediascan', 'media.uploads')} {onOff(overview.uploadsEnabled)}
      </span>
      <span>
        {t('mediascan', 'media.remote')} {onOff(overview.remoteMediaEnabled)}
      </span>
      <span>
        {t('mediascan', 'media.hashes')} {overview.counts.hashes}
      </span>
      {/* uploads.enabled and remote_media.enabled are changed in the admin settings (lane ADM). */}
      <a href={adminPaths.settings}>{t('mediascan', 'media.settingsLink')}</a>
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
    <nav className="subnav" aria-label={t('mediascan', 'media.sections')}>
      {sections.map((key) => (
        <a key={key} href={`${adminPaths.media}?section=${key}`} aria-current={key === section ? 'page' : undefined}>
          {t('mediascan', `media.nav.${key}`)}
          {n[key] !== undefined && <span className="muted"> {n[key]}</span>}
        </a>
      ))}
    </nav>
  );
}

const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

/** One shared decision control: three exclusive panels, each a plain POST form. */
function Decision({ row }: { row: QuarantineRow }) {
  const { t } = useTranslate();
  const tomorrow = new Date(Date.parse(row.quarantinedAt) + 366 * 86_400_000).toISOString().slice(0, 10);
  return (
    <div aria-label={t('mediascan', 'media.decision')} role="group">
      <details className="decide" name="decision" open>
        <summary>{t('mediascan', 'media.confirm.title')}</summary>
        <form method="post" action={adminPaths.media} aria-label={t('mediascan', 'media.confirm.title')}>
          {hidden('intent', 'confirm')}
          {hidden('item', row.mediaId)}
          <p className="hint">{t('mediascan', 'media.confirm.help')}</p>
          <label className="chk">
            <input type="checkbox" name="removePosts" defaultChecked />
            <span>{t('mediascan', 'media.confirm.removePosts')}</span>
          </label>
          <div className="fld">
            <label htmlFor="confirm-note">
              {t('mediascan', 'media.note')} <span className="hint">{t('mediascan', 'media.optional')}</span>
            </label>
            <input id="confirm-note" type="text" name="note" maxLength={500} />
          </div>
          <div className="btns">
            <Button type="submit" variant="primary">
              {t('mediascan', 'media.confirm.submit')}
            </Button>
          </div>
        </form>
      </details>
      <details className="decide" name="decision">
        <summary>{t('mediascan', 'media.hold.title')}</summary>
        <form method="post" action={adminPaths.media} aria-label={t('mediascan', 'media.hold.heading')}>
          {hidden('intent', 'hold')}
          {hidden('item', row.mediaId)}
          <p className="hint">{t('mediascan', 'media.hold.help')}</p>
          <div className="fld">
            <label htmlFor="hold-authority">{t('mediascan', 'media.hold.authority')}</label>
            <select id="hold-authority" name="authority" required defaultValue="">
              <option value="" disabled>
                {t('mediascan', 'media.hold.authorityChoose')}
              </option>
              {holdAuthorities.map((authority) => (
                <option key={authority} value={authority}>
                  {t('mediascan', `media.hold.authority.${authority}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="hold-ref">{t('mediascan', 'media.hold.reference')}</label>
            <input
              id="hold-ref"
              type="text"
              name="reference"
              maxLength={200}
              required
              placeholder={t('mediascan', 'media.hold.referencePlaceholder')}
            />
          </div>
          <div className="fld">
            <label htmlFor="hold-until">{t('mediascan', 'media.hold.until')}</label>
            <input id="hold-until" type="date" name="until" required defaultValue={tomorrow} />
          </div>
          <div className="btns">
            <Button type="submit" variant="neutral">
              {t('mediascan', 'media.hold.submit')}
            </Button>
          </div>
        </form>
      </details>
      <details className="decide" name="decision">
        <summary>{t('mediascan', 'media.release.title')}</summary>
        <form method="post" action={adminPaths.media} aria-label={t('mediascan', 'media.release.title')}>
          {hidden('intent', 'release')}
          {hidden('item', row.mediaId)}
          <p className="hint">{t('mediascan', 'media.release.help')}</p>
          <div className="fld">
            <label htmlFor="release-note">{t('mediascan', 'media.release.note')}</label>
            <input
              id="release-note"
              type="text"
              name="note"
              maxLength={500}
              required
              placeholder={t('mediascan', 'media.release.notePlaceholder')}
            />
          </div>
          <div className="btns">
            <Button type="submit" variant="neutral">
              {t('mediascan', 'media.release.submit')}
            </Button>
          </div>
        </form>
      </details>
    </div>
  );
}

function verdictOf(row: QuarantineRow, t: ReturnType<typeof useTranslate>['t']) {
  const kind = t('mediascan', row.matchType ? `media.match.${row.matchType}` : 'media.match.none');
  return row.classification === 'test' ? `${kind}, ${t('mediascan', 'media.d.test')}` : `${kind}, ${row.classification}`;
}

function Detail({ row }: { row: QuarantineRow }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  return (
    <div data-testid="media-detail">
      <h2>
        <span className="mono">{shortHash(row.sha256)}</span>
      </h2>
      <dl className="kv">
        <dt>{t('mediascan', 'media.d.verdict')}</dt>
        <dd>{verdictOf(row, t)}</dd>
        <dt>{t('mediascan', 'media.d.provider')}</dt>
        <dd>{row.source}</dd>
        <dt>{t('mediascan', 'media.d.uploader')}</dt>
        <dd>
          <Who person={row.uploader} />
        </dd>
        <dt>{t('mediascan', 'media.d.uploaded')}</dt>
        <dd>{stamp(row.uploadedAt)}</dd>
        <dt>{t('mediascan', 'media.d.quarantined')}</dt>
        <dd>{stamp(row.quarantinedAt)}</dd>
        <dt>{t('mediascan', 'media.d.sha')}</dt>
        <dd className="hx">{row.sha256}</dd>
        <dt>{t('mediascan', 'media.d.type')}</dt>
        <dd>
          {row.mimeType},{' '}
          {row.byteSize === null ? '' : `${new Intl.NumberFormat(locale).format(Math.max(1, Math.round(row.byteSize / 1024)))} kB`}
        </dd>
        <dt>{t('mediascan', 'media.d.posts')}</dt>
        <dd>
          {row.livePosts.length === 0 ? (
            t('mediascan', 'media.d.none')
          ) : (
            <ul className="used-by">
              {row.livePosts.map((post) => (
                <li key={post.id}>
                  <a href={`/post/${post.id}`}>{post.title}</a>
                </li>
              ))}
            </ul>
          )}
        </dd>
        {row.holdReference && row.holdUntil && (
          <>
            <dt>{t('mediascan', 'media.d.hold')}</dt>
            <dd>
              {t('mediascan', 'media.d.holdValue', {
                authority: authorityLabel(row.holdAuthority, t),
                reference: row.holdReference,
                date: date(row.holdUntil),
              })}
            </dd>
          </>
        )}
        {/* Only an AFP hold stops the automatic block; under an NCMEC or NCA hold it still comes. */}
        {!row.bytesHeld && (
          <>
            <dt>{t('mediascan', 'media.d.autoBlock')}</dt>
            <dd>{t('mediascan', 'media.d.autoBlockAt', { date: stamp(row.blocksAt) })}</dd>
          </>
        )}
      </dl>
      <Decision row={row} />
    </div>
  );
}

export function Review({ overview, item }: { overview: MediaOverview; item: string | undefined }) {
  const { t, locale } = useTranslate();
  const rows = overview.quarantine;
  if (rows.length === 0) return <p className="muted">{t('mediascan', 'media.review.empty')}</p>;
  const selected = rows.find((row) => row.mediaId === item) ?? rows[0]!;
  return (
    <>
      <div className="md">
        <ul className="ml" aria-label={t('mediascan', 'media.review.list')}>
          {rows.map((row) => (
            <li key={row.mediaId} data-testid="quarantine-row">
              <a href={`${adminPaths.media}?section=review&item=${row.mediaId}`} aria-current={row === selected ? 'true' : undefined}>
                <span className="row">
                  <b className="mono">{shortHash(row.sha256)}</b>
                  <span className="sp" />
                  <span className="muted">{stamp(row.quarantinedAt).slice(0, 10)}</span>
                </span>
                <span className="muted">
                  <Who person={row.uploader} />, {verdictOf(row, t)}
                </span>
                <br />
                <span className="muted">
                  {row.source},{' '}
                  {row.livePosts.length === 0
                    ? t('mediascan', 'media.review.noPosts')
                    : translatePlural(locale, 'mediascan', 'media.review.posts', row.livePosts.length)}
                </span>
              </a>
            </li>
          ))}
        </ul>
        <Detail row={selected} />
      </div>
      <p className="hint">{t('mediascan', 'media.metadataOnly')}</p>
    </>
  );
}

export function Failed({ rows }: { rows: FailedRow[] }) {
  const { t } = useTranslate();
  return (
    <>
      {rows.length === 0 ? (
        <p className="muted">{t('mediascan', 'media.failed.empty')}</p>
      ) : (
        <table className="invites">
          <thead>
            <tr>
              <th>{t('mediascan', 'media.failed.upload')}</th>
              <th>{t('mediascan', 'media.failed.uploader')}</th>
              <th>{t('mediascan', 'media.failed.time')}</th>
              <th>{t('mediascan', 'media.failed.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.mediaId} data-testid="failed-row">
                <td data-label={t('mediascan', 'media.failed.upload')} className="mono">
                  {row.mediaId.slice(-8)}
                </td>
                <td data-label={t('mediascan', 'media.failed.uploader')}>
                  <Who person={row.uploader} />
                </td>
                <td data-label={t('mediascan', 'media.failed.time')}>{stamp(row.at)}</td>
                <td data-label={t('mediascan', 'media.failed.reason')}>{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">{t('mediascan', 'media.failed.help')}</p>
    </>
  );
}

export function Hashes({ rows, value }: { rows: HashRow[]; value: string | undefined }) {
  const { t } = useTranslate();
  return (
    <>
      <form method="post" action={adminPaths.media} className="add-hash" aria-label={t('mediascan', 'media.hash.add')}>
        {hidden('intent', 'add-hash')}
        <div className="fld">
          <label htmlFor="hash-value">{t('mediascan', 'media.hash.value')}</label>
          <input
            id="hash-value"
            type="text"
            name="value"
            className="mono"
            required
            autoComplete="off"
            spellCheck={false}
            defaultValue={value}
            placeholder={t('mediascan', 'media.hash.valuePlaceholder')}
          />
        </div>
        <div className="fld">
          <label htmlFor="hash-category">{t('mediascan', 'media.hash.category')}</label>
          <select id="hash-category" name="category" defaultValue="csam">
            {blockCategories.map((category) => (
              <option key={category} value={category}>
                {t('mediascan', `media.category.${category}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="hash-reason">{t('mediascan', 'media.hash.reason')}</label>
          <input id="hash-reason" type="text" name="reason" maxLength={500} placeholder={t('mediascan', 'media.hash.reasonPlaceholder')} />
        </div>
        <Button type="submit" variant="primary">
          {t('mediascan', 'media.hash.submit')}
        </Button>
      </form>
      {rows.length === 0 ? (
        <p className="muted">{t('mediascan', 'media.hash.empty')}</p>
      ) : (
        <table className="invites">
          <thead>
            <tr>
              <th>{t('mediascan', 'media.hash.colHash')}</th>
              <th>{t('mediascan', 'media.hash.colCategory')}</th>
              <th>{t('mediascan', 'media.hash.colReason')}</th>
              <th>{t('mediascan', 'media.hash.colAdded')}</th>
              <th>
                <span className="sr">{t('mediascan', 'media.hash.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid="hash-row">
                <td data-label={t('mediascan', 'media.hash.colHash')}>
                  <span className="hx" title={row.sha256}>
                    {shortHash(row.sha256)}
                  </span>
                </td>
                <td data-label={t('mediascan', 'media.hash.colCategory')}>
                  {t('mediascan', `media.category.${row.category as (typeof blockCategories)[number]}`)}
                </td>
                <td data-label={t('mediascan', 'media.hash.colReason')}>{row.reason}</td>
                <td data-label={t('mediascan', 'media.hash.colAdded')}>
                  {stamp(row.addedAt).slice(0, 10)} <Who person={row.addedBy} />
                </td>
                <td data-label="">
                  <form method="post" action={adminPaths.media}>
                    {hidden('intent', 'remove-hash')}
                    {hidden('entry', row.id)}
                    <Button type="submit" variant="neutral" size="sm">
                      {t('mediascan', 'media.hash.remove')}
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">{t('mediascan', 'media.hash.help')}</p>
    </>
  );
}

export function Evidence({ rows }: { rows: EvidenceRow[] }) {
  const { t } = useTranslate();
  const date = useDate();
  if (rows.length === 0) return <p className="muted">{t('mediascan', 'media.evidence.empty')}</p>;
  return (
    <>
      <table className="invites">
        <thead>
          <tr>
            <th>{t('mediascan', 'media.evidence.manifest')}</th>
            <th>{t('mediascan', 'media.evidence.upload')}</th>
            <th>{t('mediascan', 'media.evidence.decision')}</th>
            <th>{t('mediascan', 'media.evidence.bytes')}</th>
            <th>{t('mediascan', 'media.evidence.hold')}</th>
            <th>{t('mediascan', 'media.evidence.retain')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.evidenceId} data-testid="evidence-row">
              <td data-label={t('mediascan', 'media.evidence.manifest')}>
                <span className="hx" title={row.manifestSha256}>
                  {shortHash(row.manifestSha256)}
                </span>
                <details>
                  <summary>{t('mediascan', 'media.evidence.view')}</summary>
                  <pre className="manifest">{row.manifest}</pre>
                </details>
              </td>
              <td data-label={t('mediascan', 'media.evidence.upload')} className="mono">
                {row.mediaId.slice(-8)}
              </td>
              <td data-label={t('mediascan', 'media.evidence.decision')}>
                {row.status === 'open' || !row.decidedAt
                  ? t('mediascan', 'media.evidence.open')
                  : t('mediascan', row.status === 'confirmed' ? 'media.evidence.confirmed' : 'media.evidence.released', {
                      date: date(row.decidedAt),
                    })}
                {row.status !== 'open' && (
                  <>
                    <br />
                    <span className="muted">
                      {row.decidedBy
                        ? t('mediascan', 'media.evidence.by', { who: row.decidedBy.handle })
                        : t('mediascan', 'media.evidence.bySystem')}
                    </span>
                  </>
                )}
              </td>
              <td data-label={t('mediascan', 'media.evidence.bytes')}>{t('mediascan', `media.evidence.bytes.${row.bytes}`)}</td>
              <td data-label={t('mediascan', 'media.evidence.hold')}>
                {row.holdReference && row.holdUntil ? (
                  <>
                    <span className="mono">
                      {authorityLabel(row.holdAuthority, t)} {row.holdReference}
                    </span>
                    <br />
                    <span className="muted">{date(row.holdUntil)}</span>
                  </>
                ) : (
                  <span className="muted">{t('mediascan', 'media.evidence.none')}</span>
                )}
              </td>
              <td data-label={t('mediascan', 'media.evidence.retain')}>{row.retainUntil ? date(row.retainUntil) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{t('mediascan', 'media.evidence.help')}</p>
    </>
  );
}

export function Status({ overview }: { overview: MediaOverview }) {
  const { t, locale } = useTranslate();
  const { scanner, counts } = overview;
  return (
    <dl className="kv" data-testid="media-status-detail">
      <dt>{t('mediascan', 'media.status.scanner')}</dt>
      <dd>
        {scanner.kind === 'provider'
          ? t('mediascan', 'media.scanner.provider', { name: scanner.providers.join(', ') })
          : scanner.kind === 'local-only'
            ? t('mediascan', 'media.scanner.local')
            : `${t('mediascan', 'media.scanner.none')}. ${t('mediascan', 'media.status.noProvider')}`}
      </dd>
      <dt>{t('mediascan', 'media.status.list')}</dt>
      <dd>{translatePlural(locale, 'mediascan', 'media.status.listValue', counts.hashes)}</dd>
      <dt className="mono">uploads.enabled</dt>
      <dd>
        {t('mediascan', overview.uploadsEnabled ? 'media.on' : 'media.off')}{' '}
        <a href={adminPaths.settings}>{t('mediascan', 'media.settingsLink')}</a>
      </dd>
      <dt className="mono">remote_media.enabled</dt>
      <dd>
        {t('mediascan', overview.remoteMediaEnabled ? 'media.on' : 'media.off')}{' '}
        <a href={adminPaths.settings}>{t('mediascan', 'media.settingsLink')}</a>
      </dd>
      <dt>{t('mediascan', 'media.status.quarantined')}</dt>
      <dd>{counts.quarantined}</dd>
      <dt>{t('mediascan', 'media.status.failed')}</dt>
      <dd>{counts.failed24h}</dd>
      <dt>{t('mediascan', 'media.status.blocked')}</dt>
      <dd>{counts.blocked}</dd>
      <dt>{t('mediascan', 'media.status.window')}</dt>
      <dd>{translatePlural(locale, 'mediascan', 'media.status.windowValue', overview.undecidedPurgeDays)}</dd>
    </dl>
  );
}
