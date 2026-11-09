import type { QueueGroup, QueueSubject } from '@peblish/core/reports/read';
import type { QueueTab } from '@peblish/core/reports/scope';
import { Button } from '@peblish/ui/components/button';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { rich } from '../../../auth/-ui/form.tsx';
import { useDate } from '../../../auth/-ui/page.tsx';
import { communityPath, commentPath, postPath, userPath } from '../../../../shell/paths.ts';
import { asReportError, errorKey, type ReportError } from '../../../report/-ui/errors.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

/** The queue's own address with the tab, community and sort the viewer chose, for links and for where a form returns. */
export type QueueView = { tab: QueueTab; community: string | null; sort: string; cursor?: string | null; show?: string | null };

export const queueHref = (view: QueueView, change: Partial<QueueView> = {}) => {
  const next = { ...view, ...change };
  const params = new URLSearchParams();
  if (next.tab !== 'open') params.set('tab', next.tab);
  if (next.community) params.set('community', next.community);
  params.set('sort', next.sort);
  if (next.cursor) params.set('cursor', next.cursor);
  if (next.show) params.set('show', next.show);
  return `/admin/reports?${params}`;
};

const subjectKind = (subject: QueueSubject) =>
  subject.kind === 'actor' ? (subject.person.kind === 'Group' ? 'community' : 'person') : subject.kind === 'gone' ? 'post' : subject.kind;

const targetValue = (group: QueueGroup) => `${group.target.kind}:${group.target.id}`;

/** Age as the biggest whole unit, counted from when the page's data was read. */
function Age({ iso, now }: { iso: string; now: number }) {
  const { t } = useTranslate();
  const date = useDate();
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  const text =
    minutes < 60
      ? t('reports', 'queue.age.minutes', { count: minutes })
      : minutes < 1440
        ? t('reports', 'queue.age.hours', { count: Math.floor(minutes / 60) })
        : t('reports', 'queue.age.days', { count: Math.floor(minutes / 1440) });
  return (
    <time dateTime={iso} title={date(iso)}>
      {text}
    </time>
  );
}

/**
 * A form that posts to the queue and works without JavaScript (303 back to `back`, or back
 * with ?error=<code>). Once hydrated it posts by fetch, shows a refusal in place and reloads the
 * queue's data on success.
 */
function QueueForm({ group, back, children, className }: { group: QueueGroup; back: string; children: ReactNode; className?: string }) {
  const router = useRouter();
  const { t } = useTranslate();
  const [error, setError] = useState<ReportError>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget, submitter)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch('/admin/reports', { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.redirect) {
        setError(undefined);
        await router.invalidate();
      } else setError(asReportError(answer.error) ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" action="/admin/reports" className={className} aria-busy={busy} onSubmit={submit}>
      <input type="hidden" name="target" value={targetValue(group)} />
      <input type="hidden" name="audience" value={group.audience} />
      <input type="hidden" name="back" value={back} />
      {error && (
        <p className="rq-error" role="alert">
          {t('reports', errorKey(error))}
        </p>
      )}
      {children}
    </form>
  );
}

function Content({ group, view }: { group: QueueGroup; view: QueueView }) {
  const { t } = useTranslate();
  const { subject } = group;
  // Without JavaScript the shown state is the ?show= link; hydrated, a press toggles it in the browser and nothing is stored.
  const [shown, setShown] = useState(view.show === group.key);
  const open =
    subject.kind === 'post' || subject.kind === 'comment'
      ? subject.kind === 'post'
        ? postPath(subject.postId)
        : commentPath(subject.postId, subject.id)
      : null;
  const kind = subjectKind(subject);
  return (
    <div className="rq-content">
      <p className="rq-meta">
        <b>{t('reports', `queue.type.${kind}`)}</b>
        {subject.kind === 'post' || subject.kind === 'comment' ? (
          <>
            {' '}
            {rich(t('reports', 'queue.where'), {
              community: <a href={communityPath(subject.community)}>!{subject.community.handle}</a>,
              author: <a href={userPath(subject.author)}>@{subject.author.handle}</a>,
            })}
          </>
        ) : subject.kind === 'actor' ? (
          <>
            {' '}
            <a href={subject.person.kind === 'Group' ? communityPath(subject.person) : userPath(subject.person)}>
              {subject.person.kind === 'Group' ? '!' : '@'}
              {subject.person.handle}
            </a>
          </>
        ) : null}
      </p>
      {(subject.kind === 'post' || subject.kind === 'comment') && subject.quote && (
        <div className="rq-quote">
          <blockquote aria-hidden={shown ? undefined : 'true'} data-hidden={shown ? undefined : 'true'}>
            {subject.quote}
          </blockquote>
          <a
            className="pb-linkbutton"
            href={queueHref(view, { show: shown ? null : group.key })}
            aria-expanded={shown}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              setShown(!shown);
            }}
          >
            {shown ? t('reports', 'queue.hide') : t('reports', 'queue.show')}
          </a>
          {!shown && <span className="rq-hint">{t('reports', 'queue.hidden')}</span>}
        </div>
      )}
      {(subject.kind === 'post' || subject.kind === 'comment') && !subject.quote && subject.withheld && (
        <p className="rq-hint">{t('reports', `queue.withheld.${subject.withheld}`)}</p>
      )}
      {subject.kind === 'gone' && <p className="rq-hint">{t('reports', 'queue.gone')}</p>}
      {open && (
        <a className="rq-open" href={open}>
          {t('reports', 'queue.open')}
        </a>
      )}
    </div>
  );
}

function Reports({ group }: { group: QueueGroup }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  const count = new Intl.PluralRules(locale).select(group.count) === 'one' ? 'queue.reports.one' : 'queue.reports.other';
  return (
    <div>
      <p className="rq-count">
        {t('reports', count, { count: group.count })}
        {group.escalatedBy && (
          <span className="rq-hint"> {t('reports', 'queue.escalatedBy', { handle: `@${group.escalatedBy.handle}` })}</span>
        )}
      </p>
      <p className="rq-hint">{group.categories.map((category) => t('reports', `category.${category}`)).join(', ')}</p>
      <details>
        <summary>{t('reports', 'queue.details')}</summary>
        <ul className="rq-reporters">
          {group.reports.map((report) => (
            <li key={report.id}>
              <b>#{report.number}</b> {t('reports', `category.${report.category}`)}
              {report.reporter && <> @{report.reporter.handle}</>}
              {report.remote && <span className="rq-hint"> ({t('reports', 'queue.remote')})</span>}
              <span className="rq-hint"> {date(report.createdAt)}</span>
              <br />
              {report.details ?? <span className="rq-hint">{t('reports', 'queue.noDetails')}</span>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const rules = [1, 2, 3, 4, 5, 6, 7] as const;

function Actions({ group, tab, admin, view }: { group: QueueGroup; tab: QueueTab; admin: boolean; view: QueueView }) {
  const { t } = useTranslate();
  const back = queueHref(view, { show: null });
  const isContent = group.subject.kind === 'post' || group.subject.kind === 'comment';
  if (tab === 'resolved' || tab === 'dismissed') {
    const closed = group.closed;
    return closed ? (
      <p className="rq-hint">
        {t('reports', 'queue.closed', {
          resolution: t(
            'reports',
            `queue.closed.${closed.resolution === 'dismissed' ? 'dismissed' : closed.resolution === 'removed' ? 'removed' : 'resolved'}`,
          ),
          handle: closed.by ? `@${closed.by.handle}` : '',
        })}
        {closed.note && <> {closed.note}</>}
      </p>
    ) : null;
  }
  if (group.audience === 'admins' && !admin) return <p className="rq-hint">{t('reports', 'queue.readOnly')}</p>;
  return (
    <div className="rq-actions">
      <QueueForm group={group} back={back} className="rq-act">
        <label className="rq-note">
          <span>{t('reports', 'queue.note')}</span>
          <input type="text" name="note" maxLength={2000} aria-describedby={`note-${group.key}`} />
          <span id={`note-${group.key}`} className="rq-hint">
            {t('reports', 'queue.note.hint')}
          </span>
        </label>
        <div className="rq-buttons">
          <Button type="submit" name="intent" value="resolve" variant="primary">
            {t('reports', 'queue.resolve')}
          </Button>
          <Button type="submit" name="intent" value="dismiss">
            {t('reports', 'queue.dismiss')}
          </Button>
        </div>
      </QueueForm>
      {isContent && (
        <details className="rq-remove">
          <summary>{t('reports', 'queue.remove')}</summary>
          <QueueForm group={group} back={back} className="rq-act">
            <input type="hidden" name="intent" value="remove" />
            <p className="rq-hint">{t('reports', 'queue.remove.title')}</p>
            <label className="rq-note">
              <span>{t('reports', 'queue.remove.rule')}</span>
              <select name="rule" required defaultValue="">
                <option value="" disabled />
                {rules.map((rule) => (
                  <option key={rule} value={rule}>
                    {t('reports', `queue.rule.${rule}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="rq-note">
              <span>{t('reports', 'queue.remove.explanation')}</span>
              <textarea name="explanation" rows={3} maxLength={2000} required aria-describedby={`explain-${group.key}`} />
              <span id={`explain-${group.key}`} className="rq-hint">
                {t('reports', 'queue.remove.hint')}
              </span>
            </label>
            <p className="rq-hint">{t('reports', 'queue.remove.ban')}</p>
            <Button type="submit" variant="primary">
              {t('reports', 'queue.remove.submit')}
            </Button>
          </QueueForm>
        </details>
      )}
      {group.audience === 'moderators' && (
        <QueueForm group={group} back={back} className="rq-act">
          <input type="hidden" name="intent" value="escalate" />
          <Button type="submit">{t('reports', 'queue.escalate')}</Button>
        </QueueForm>
      )}
      {group.audience === 'admins' && tab === 'escalated' && admin && (
        <QueueForm group={group} back={back} className="rq-act">
          <input type="hidden" name="intent" value="back" />
          <Button type="submit">{t('reports', 'queue.sendBack')}</Button>
        </QueueForm>
      )}
    </div>
  );
}

/** One row per group: content, reports, age and the actions the viewer has here. */
export function QueueTable({
  groups,
  tab,
  admin,
  view,
  now,
}: {
  groups: QueueGroup[];
  tab: QueueTab;
  admin: boolean;
  view: QueueView;
  now: number;
}) {
  const { t } = useTranslate();
  return (
    <table className="rq-table">
      <thead>
        <tr>
          <th scope="col">{t('reports', 'queue.col.content')}</th>
          <th scope="col">{t('reports', 'queue.col.reports')}</th>
          <th scope="col">{t('reports', 'queue.col.age')}</th>
          <th scope="col">{t('reports', 'queue.col.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={group.key} id={`g-${group.key}`}>
            <td>
              <Content group={group} view={view} />
            </td>
            <td>
              <Reports group={group} />
            </td>
            <td>
              <Age iso={group.oldestAt} now={now} />
            </td>
            <td>
              <Actions group={group} tab={tab} admin={admin} view={view} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
