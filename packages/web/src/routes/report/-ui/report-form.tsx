import type { ReportForm } from '@peblish/core/reports/form';
import { Button } from '@peblish/ui/components/button';
import { type } from 'arktype';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asReportError, errorKey, type ReportError } from './errors.ts';
import { hostList } from './hosts.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

const kindOf = (form: ReportForm) => (form.target.kind === 'actor' ? form.about.kind : form.target.kind);

/**
 * The report form: what is reported, the quote, a category (native radios, each with one help
 * line), details, and, when it can go to another instance, a checkbox for that. A plain POST
 * to /report that works without JavaScript; once hydrated it posts by fetch and follows the
 * redirect, keeping what was typed on an error. The routing line under the categories follows
 * the chosen radio in CSS, so it is right in both modes.
 */
export function ReportFormView({
  form,
  back,
  initialError,
  initialCategory,
  onCancel,
}: {
  form: ReportForm;
  back: string;
  initialError?: ReportError | undefined;
  initialCategory?: string | undefined;
  /** In the dialog, closes it; on the page the Cancel link goes back. */
  onCancel?: () => void;
}) {
  const { t, locale } = useTranslate();
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const canForward = form.hosts.length > 0 && form.categories.some((option) => option.forwardable);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === 'string') body.append(name, value);
    setBusy(true);
    try {
      const response = await fetch('/report', { method: 'POST', body, headers: { accept: 'application/json' } });
      const answer = Answer(await response.json());
      if (answer instanceof type.errors) return setError('generic');
      if (answer.redirect) return window.location.assign(answer.redirect);
      setError(asReportError(answer.error) ?? 'generic');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" action="/report" className="rp-form" aria-busy={busy} onSubmit={submit}>
      <p className="rp-about">
        <b>{t('reports', `queue.type.${kindOf(form)}`)}</b>{' '}
        {form.about.community
          ? t('reports', 'form.aboutBy', { handle: `@${form.about.handle}`, community: `!${form.about.community}` })
          : t('reports', 'form.aboutPerson', {
              handle: form.about.kind === 'community' ? `!${form.about.handle}` : `@${form.about.handle}`,
            })}
      </p>
      {form.quote && (
        <blockquote className="rp-quote">
          <span className="rp-quote__label">{t('reports', 'form.quote')}</span>
          {form.quote}
        </blockquote>
      )}
      {error && (
        <p className="rp-error" role="alert">
          {t('reports', errorKey(error))}
        </p>
      )}
      <input type="hidden" name="kind" value={form.target.kind} />
      <input type="hidden" name="id" value={form.target.id} />
      <input type="hidden" name="back" value={back} />
      <fieldset className="rp-categories">
        <legend>{t('reports', 'form.category')}</legend>
        {form.categories.map((option) => (
          <label key={option.key} className="rp-cat">
            <input
              type="radio"
              name="category"
              value={option.key}
              required
              defaultChecked={initialCategory === option.key}
              data-audience={option.audience}
              data-forwardable={option.forwardable}
            />
            <span>
              <span className="rp-cat__name">{t('reports', `category.${option.key}`)}</span>
              <span className="rp-help">{t('reports', `category.${option.key}.help`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="rp-field">
        <label htmlFor="report-details">{t('reports', 'form.details')}</label>
        <textarea id="report-details" name="details" rows={4} maxLength={2000} aria-describedby="report-details-hint" />
        <span id="report-details-hint" className="rp-help">
          {t('reports', 'form.details.hint')} {t('reports', 'form.details.limit')}
        </span>
      </div>
      {canForward && (
        <label className="rp-forward">
          <input type="checkbox" name="forward" value="yes" />
          {/* The hosts named here; the report is sent on to no other. */}
          <input type="hidden" name="hosts" value={form.hosts.join(' ')} />
          <span>{t('reports', 'form.forward', { hosts: hostList(locale, form.hosts) })}</span>
        </label>
      )}
      <div className="rp-routes" aria-live="polite">
        <p className="rp-route" data-for="none">
          {t('reports', 'route.none')}
        </p>
        <p className="rp-route" data-for="moderators">
          {t('reports', 'route.moderators')}
        </p>
        <p className="rp-route" data-for="admins">
          {t('reports', 'route.admins')}
        </p>
        <p className="rp-route rp-warning" data-for="admins">
          {t('reports', 'route.warning')}
        </p>
      </div>
      <div className="rp-buttons">
        <Button type="submit" variant="primary">
          {t('reports', 'form.submit')}
        </Button>
        {onCancel ? (
          <button type="button" className="pb-linkbutton" onClick={onCancel}>
            {t('reports', 'form.cancel')}
          </button>
        ) : (
          <a href={back}>{t('reports', 'form.cancel')}</a>
        )}
      </div>
    </form>
  );
}
