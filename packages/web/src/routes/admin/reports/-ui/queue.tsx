import type { QueueGroup, QueueSubject } from '@peblish/core/reports/read';
import type { QueueTab } from '@peblish/core/reports/scope';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Handle } from '@peblish/ui/components/handle';
import { Link } from '@peblish/ui/components/link';
import { LinkedDisclosure } from '@peblish/ui/components/linked-disclosure';
import { Notice } from '@peblish/ui/components/notice';
import { Quote } from '@peblish/ui/components/quote';
import { Select } from '@peblish/ui/components/select';
import { Table } from '@peblish/ui/components/table';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { TextField } from '@peblish/ui/components/text-field';
import { Time } from '@peblish/ui/components/time';
import { useRouter } from '@tanstack/react-router';
import { type } from 'arktype';
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslate } from '../../../../i18n/use-translate.ts';
import { rich } from '../../../auth/-ui/form.tsx';
import { useDate } from '../../../auth/-ui/page.tsx';
import { communityPath, commentPath, postPath, userPath } from '../../../../shell/paths.ts';
import { asReportError, errorKey, type ReportError } from '../../../report/-ui/errors.ts';
import { queueHref, type QueueView } from '../-href.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

const subjectKind = (subject: QueueSubject) =>
  subject.kind === 'actor' ? (subject.person.kind === 'Group' ? 'community' : 'person') : subject.kind === 'gone' ? 'post' : subject.kind;

const targetValue = (group: QueueGroup) => `${group.target.kind}:${group.target.id}`;

/**
 * Mux Table is a React Aria grid: in a cell it takes the arrow keys, Tab and typed letters to move
 * between cells. The queue's rows hold forms, so while focus is in a text field or select of a
 * row the keys are kept from the grid (a capture listener on window runs before React's) and do
 * what they do in any field. Buttons and links in the rows keep the grid's keys.
 */
function useFieldKeys() {
  useEffect(() => {
    const keep = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches('input, textarea, select') && target.closest('.rq-table .muxui-table__cell'))
        event.stopPropagation();
    };
    window.addEventListener('keydown', keep, true);
    return () => window.removeEventListener('keydown', keep, true);
  }, []);
}

/**
 * A link that shows or hides part of a row. Without JavaScript it is a link to the queue with the
 * part shown; hydrated, a plain click toggles it in the browser and nothing is stored.
 */
function Toggle({ shown, href, onToggle, children }: { shown: boolean; href: string; onToggle: () => void; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-expanded={shown}
      className="rq-toggle"
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onToggle();
      }}
    >
      {children}
    </Link>
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
        <Notice tone="danger" role="alert">
          {t('reports', errorKey(error))}
        </Notice>
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
      <Text as="p" size="sm">
        <Text variant="label" size="sm">
          {t('reports', `queue.type.${kind}`)}
        </Text>
        {subject.kind === 'post' || subject.kind === 'comment' ? (
          <>
            {' '}
            {rich(t('reports', 'queue.where'), {
              community: (
                <Link href={communityPath(subject.community)}>
                  <Handle prefix="!" handle={subject.community.handle} />
                </Link>
              ),
              author: (
                <Link href={userPath(subject.author)}>
                  <Handle prefix="@" handle={subject.author.handle} />
                </Link>
              ),
            })}
          </>
        ) : subject.kind === 'actor' ? (
          <>
            {' '}
            <Link href={subject.person.kind === 'Group' ? communityPath(subject.person) : userPath(subject.person)}>
              <Handle prefix={subject.person.kind === 'Group' ? '!' : '@'} handle={subject.person.handle} />
            </Link>
          </>
        ) : null}
      </Text>
      {(subject.kind === 'post' || subject.kind === 'comment') && subject.quote && (
        <div className="rq-quote">
          {/* Blur by default: in the markup, but blurred, unselectable and hidden from assistive technology until Show. */}
          <Quote edge className="rq-quote__text" aria-hidden={shown ? undefined : 'true'} data-hidden={shown ? undefined : 'true'}>
            {subject.quote}
          </Quote>
          <Toggle shown={shown} href={queueHref(view, { show: shown ? null : group.key })} onToggle={() => setShown(!shown)}>
            {shown ? t('reports', 'queue.hide') : t('reports', 'queue.show')}
          </Toggle>
          {!shown && (
            <Text size="sm" color="muted">
              {t('reports', 'queue.hidden')}
            </Text>
          )}
        </div>
      )}
      {(subject.kind === 'post' || subject.kind === 'comment') && !subject.quote && subject.withheld && (
        <Text as="p" size="sm" color="muted">
          {t('reports', `queue.withheld.${subject.withheld}`)}
        </Text>
      )}
      {subject.kind === 'gone' && (
        <Text as="p" size="sm" color="muted">
          {t('reports', 'queue.gone')}
        </Text>
      )}
      {open && (
        <Link href={open} className="rq-open">
          {t('reports', 'queue.open')}
        </Link>
      )}
    </div>
  );
}

function Reports({ group, view }: { group: QueueGroup; view: QueueView }) {
  const { t, locale } = useTranslate();
  const date = useDate();
  const [shown, setShown] = useState(view.details === group.key);
  const count = new Intl.PluralRules(locale).select(group.count) === 'one' ? 'queue.reports.one' : 'queue.reports.other';
  return (
    <div className="rq-reports">
      <Text as="p" size="sm">
        {t('reports', count, { count: group.count })}
        {group.escalatedBy && (
          <Text size="sm" color="muted">
            {' '}
            {rich(t('reports', 'queue.escalatedBy'), { handle: <Handle prefix="@" handle={group.escalatedBy.handle} /> })}
          </Text>
        )}
      </Text>
      <Text as="p" size="sm" color="muted">
        {group.categories.map((category) => t('reports', `category.${category}`)).join(', ')}
      </Text>
      {/* A link, not a Mux Disclosure: the row stays readable and openable without JavaScript, and a read-only row holds no button. */}
      <Toggle shown={shown} href={queueHref(view, { details: shown ? null : group.key })} onToggle={() => setShown(!shown)}>
        {t('reports', 'queue.details')}
      </Toggle>
      <ul className="rq-reporters" hidden={!shown}>
        {group.reports.map((report) => (
          <li key={report.id}>
            <Text size="sm">
              <Text variant="label" size="sm">
                #{report.number}
              </Text>{' '}
              {t('reports', `category.${report.category}`)}
              {report.reporter && (
                <>
                  {' '}
                  <Handle prefix="@" handle={report.reporter.handle} />
                </>
              )}
              {report.remote && (
                <Text size="sm" color="muted">
                  {' '}
                  ({t('reports', 'queue.remote')})
                </Text>
              )}
              <Text size="sm" color="muted">
                {' '}
                {date(report.createdAt)}
              </Text>
            </Text>
            <Text as="p" size="sm">
              {report.details ?? (
                <Text size="sm" color="muted">
                  {t('reports', 'queue.noDetails')}
                </Text>
              )}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

const rules = [1, 2, 3, 4, 5, 6, 7] as const;

function Actions({ group, tab, admin, view }: { group: QueueGroup; tab: QueueTab; admin: boolean; view: QueueView }) {
  const { t } = useTranslate();
  const back = queueHref(view, { show: null, details: null, remove: null });
  const isContent = group.subject.kind === 'post' || group.subject.kind === 'comment';
  if (tab === 'resolved' || tab === 'dismissed') {
    const closed = group.closed;
    return closed ? (
      <Text as="p" size="sm" color="muted">
        {rich(t('reports', 'queue.closed'), {
          resolution: t(
            'reports',
            `queue.closed.${closed.resolution === 'dismissed' ? 'dismissed' : closed.resolution === 'removed' ? 'removed' : 'resolved'}`,
          ),
          handle: closed.by ? <Handle prefix="@" handle={closed.by.handle} /> : '',
        })}
        {closed.note && <> {closed.note}</>}
      </Text>
    ) : null;
  }
  if (group.audience === 'admins' && !admin)
    return (
      <Text as="p" size="sm" color="muted">
        {t('reports', 'queue.readOnly')}
      </Text>
    );
  return (
    <div className="rq-actions">
      <QueueForm group={group} back={back} className="rq-act">
        <TextField
          name="note"
          size="sm"
          maxLength={2000}
          label={t('reports', 'queue.note')}
          description={t('reports', 'queue.note.hint')}
        />
        <div className="rq-buttons">
          <Button type="submit" name="intent" value="resolve" variant="primary" size="sm">
            {t('reports', 'queue.resolve')}
          </Button>
          <Button type="submit" name="intent" value="dismiss" variant="neutral" size="sm">
            {t('reports', 'queue.dismiss')}
          </Button>
        </div>
      </QueueForm>
      {isContent && (
        <LinkedDisclosure
          id={`rq-remove-${group.key}`}
          title={t('reports', 'queue.remove')}
          className="rq-remove"
          openHref={`${queueHref(view, { remove: group.key })}#rq-remove-${group.key}`}
          defaultExpanded={view.remove === group.key}
        >
          <QueueForm group={group} back={back} className="rq-act">
            <Text as="p" size="sm" color="muted">
              {t('reports', 'queue.remove.title')}
            </Text>
            <Select
              name="rule"
              size="sm"
              required
              placeholder=""
              defaultValue=""
              label={t('reports', 'queue.remove.rule')}
              items={rules.map((rule) => ({ id: String(rule), label: t('reports', `queue.rule.${rule}`) }))}
            />
            <TextAreaField
              name="explanation"
              size="sm"
              rows={3}
              maxLength={2000}
              required
              label={t('reports', 'queue.remove.explanation')}
              description={t('reports', 'queue.remove.hint')}
            />
            <Text as="p" size="sm" color="muted">
              {t('reports', 'queue.remove.ban')}
            </Text>
            <div>
              <Button type="submit" name="intent" value="remove" variant="danger" size="sm">
                {t('reports', 'queue.remove.submit')}
              </Button>
            </div>
          </QueueForm>
        </LinkedDisclosure>
      )}
      {group.audience === 'moderators' && (
        <QueueForm group={group} back={back}>
          <Button type="submit" name="intent" value="escalate" variant="neutral" size="sm">
            {t('reports', 'queue.escalate')}
          </Button>
        </QueueForm>
      )}
      {group.audience === 'admins' && tab === 'escalated' && admin && (
        <QueueForm group={group} back={back}>
          <Button type="submit" name="intent" value="back" variant="neutral" size="sm">
            {t('reports', 'queue.sendBack')}
          </Button>
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
  const { t, locale } = useTranslate();
  useFieldKeys();
  return (
    <Card.Root variant="outlined" padding="sm" className="rq-table">
      <Table
        aria-label={t('reports', 'queue.title')}
        columns={[
          { id: 'content', label: t('reports', 'queue.col.content'), isRowHeader: true },
          { id: 'reports', label: t('reports', 'queue.col.reports') },
          { id: 'age', label: t('reports', 'queue.col.age') },
          { id: 'actions', label: t('reports', 'queue.col.actions') },
        ]}
        rows={groups.map((group) => ({
          id: group.key,
          values: {
            content: <Content group={group} view={view} />,
            reports: <Reports group={group} view={view} />,
            age: <Time iso={group.oldestAt} locale={locale} now={new Date(now)} />,
            actions: <Actions group={group} tab={tab} admin={admin} view={view} />,
          },
        }))}
      />
    </Card.Root>
  );
}
