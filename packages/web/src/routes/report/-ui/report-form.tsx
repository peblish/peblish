import type { ReportForm } from '@peblish/core/reports/form';
import { Button } from '@peblish/ui/components/button';
import { Card } from '@peblish/ui/components/card';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { Input } from '@peblish/ui/components/input';
import { Link } from '@peblish/ui/components/link';
import { RadioField } from '@peblish/ui/components/radio-field';
import { RadioGroup } from '@peblish/ui/components/radio-group';
import { Text } from '@peblish/ui/components/text';
import { TextAreaField } from '@peblish/ui/components/text-area';
import { type } from 'arktype';
import { useState, type FormEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { asReportError, errorKey, type ReportError } from './errors.ts';
import { hostList } from './hosts.ts';

const Answer = type({ 'redirect?': 'string', 'error?': 'string' });

const kindOf = (form: ReportForm) => (form.target.kind === 'actor' ? form.about.kind : form.target.kind);

/**
 * The report form: what is reported, the quote, a category (a Mux RadioGroup, each option with
 * one help line), details, and, when it can go to another instance, a checkbox naming every host
 * it would go to. A plain POST to /report that works without JavaScript (Mux renders real radios,
 * textarea and checkbox); once hydrated it posts by fetch and follows the redirect, keeping what
 * was typed on an error. The routing line under the categories, and the forward checkbox, follow
 * the chosen radio in CSS, so they are right in both modes.
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
      <Text as="p">
        <Text variant="label">{t('reports', `queue.type.${kindOf(form)}`)}</Text>{' '}
        {form.about.community
          ? t('reports', 'form.aboutBy', { handle: `@${form.about.handle}`, community: `!${form.about.community}` })
          : t('reports', 'form.aboutPerson', {
              handle: form.about.kind === 'community' ? `!${form.about.handle}` : `@${form.about.handle}`,
            })}
      </Text>
      {form.quote && (
        <Card.Root variant="filled" padding="sm" className="rp-quote">
          <Text as="div" variant="label" size="sm" color="muted">
            {t('reports', 'form.quote')}
          </Text>
          <blockquote>{form.quote}</blockquote>
        </Card.Root>
      )}
      {error && (
        <Text as="p" className="rp-error" role="alert">
          {t('reports', errorKey(error))}
        </Text>
      )}
      <Input.Input type="hidden" name="kind" value={form.target.kind} />
      <Input.Input type="hidden" name="id" value={form.target.id} />
      <Input.Input type="hidden" name="back" value={back} />
      <RadioGroup label={t('reports', 'form.category')} name="category" required defaultValue={initialCategory}>
        {form.categories.map((option) => (
          // The data attributes let the CSS below show the routing line and the forward checkbox.
          <RadioField.Root
            key={option.key}
            value={option.key}
            className="rp-cat"
            data-audience={option.audience}
            data-forwardable={option.forwardable}
          >
            <RadioField.Button>
              <RadioField.Indicator>
                <RadioField.Dot />
              </RadioField.Indicator>
              {t('reports', `category.${option.key}`)}
            </RadioField.Button>
            <RadioField.Description>{t('reports', `category.${option.key}.help`)}</RadioField.Description>
          </RadioField.Root>
        ))}
      </RadioGroup>
      <TextAreaField
        label={t('reports', 'form.details')}
        description={`${t('reports', 'form.details.hint')} ${t('reports', 'form.details.limit')}`}
        name="details"
        rows={4}
        maxLength={2000}
      />
      {canForward && (
        <div className="rp-forward">
          <Checkbox name="forward" value="yes">
            {t('reports', 'form.forward', { hosts: hostList(locale, form.hosts) })}
          </Checkbox>
          {/* The hosts named here; the report is sent on to no other. */}
          <Input.Input type="hidden" name="hosts" value={form.hosts.join(' ')} />
        </div>
      )}
      <div className="rp-routes" aria-live="polite">
        <Text as="p" className="rp-route" data-for="none">
          {t('reports', 'route.none')}
        </Text>
        <Text as="p" className="rp-route" data-for="moderators">
          {t('reports', 'route.moderators')}
        </Text>
        <Text as="p" className="rp-route" data-for="admins">
          {t('reports', 'route.admins')}
        </Text>
        <Text as="p" variant="label" className="rp-route" data-for="admins">
          {t('reports', 'route.warning')}
        </Text>
      </div>
      <div className="rp-buttons">
        <Button type="submit" variant="primary">
          {t('reports', 'form.submit')}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onActivate={onCancel}>
            {t('reports', 'form.cancel')}
          </Button>
        ) : (
          <Link href={back}>{t('reports', 'form.cancel')}</Link>
        )}
      </div>
    </form>
  );
}
