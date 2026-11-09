import { Button } from '@peblish/ui/components/button';
import { Select } from '@peblish/ui/components/select';
import { TextField } from '@peblish/ui/components/text-field';
import type { MouseEvent } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath } from '../../../shell/paths.ts';

// The NSFW gate (R2 pick nsfw-gate-page): one notice that stands for the whole community page,
// post page or comment permalink. It hides everything: the data behind it is only the community's
// handle (where its forms post), the page to come back to and where the gate stands. Server rules
// are in c/-gate.ts; the intents these forms post are handled by c/-intents.ts.

export type GateData = {
  kind: 'gate';
  subject: 'community' | 'post';
  /** sign-in: signed out. age: no 16+ declaration yet. under-16: declared too young, nothing saved. hidden: Hide NSFW is on. */
  state: 'sign-in' | 'age' | 'under-16' | 'hidden';
  /** The community's handle: the forms post to its page and Show once is per community. */
  handle: string;
  /** The page the viewer came for, a path on this site; every form sends them back to it. */
  back: string;
};

const months = Array.from({ length: 12 }, (_, index) => index + 1);

/** Back one step in the browser's history, else the front page. */
function goBack(event: MouseEvent<HTMLAnchorElement>) {
  if (window.history.length > 1) {
    event.preventDefault();
    window.history.back();
  }
}

export function GateNotice({ data, error }: { data: GateData; error?: string | undefined }) {
  const { t } = useTranslate();
  useRouteHydrated();
  const { subject, state, handle, back } = data;
  const action = communityPath({ handle });
  const shown = `!${handle}`;
  const message =
    error === 'age.declaration_required' || error === 'auth.site_banned'
      ? t('communities', `gate.error.${error}`)
      : error && t('communities', 'gate.error.generic');
  const intentForm = (intent: string, label: string, primary = false) => (
    <form method="post" action={action}>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="redirect" value={back} />
      <Button type="submit" variant={primary ? 'primary' : 'neutral'}>
        {label}
      </Button>
    </form>
  );
  const goBackLink = (
    <a href="/" onClick={goBack}>
      {t('communities', 'gate.back')}
    </a>
  );

  return (
    <main className="gate" data-state={state} data-subject={subject}>
      {state === 'under-16' ? (
        <>
          <h1>{t('communities', 'gate.under16.title')}</h1>
          <p>{t('communities', 'gate.under16.body')}</p>
          <p className="gate-links">{goBackLink}</p>
        </>
      ) : state === 'age' ? (
        <>
          <h1>{t('communities', 'gate.declare.title')}</h1>
          <p>{t('communities', 'gate.declare.body')}</p>
          {message && (
            <p role="alert" className="gate-error">
              {message}
            </p>
          )}
          <form method="post" action={action} className="gate-declare">
            <input type="hidden" name="intent" value="declare" />
            <input type="hidden" name="redirect" value={back} />
            <fieldset>
              <legend>{t('communities', 'gate.declare.legend')}</legend>
              <TextField
                label={t('communities', 'gate.declare.day')}
                name="day"
                inputMode="numeric"
                maxLength={2}
                autoComplete="bday-day"
                required
              />
              <Select
                label={t('communities', 'gate.declare.month')}
                name="month"
                placeholder={t('communities', 'gate.declare.month')}
                items={months.map((month) => ({ id: String(month), label: t('communities', `gate.month.${month}` as 'gate.month.1') }))}
                required
              />
              <TextField
                label={t('communities', 'gate.declare.year')}
                name="year"
                inputMode="numeric"
                maxLength={4}
                autoComplete="bday-year"
                required
              />
            </fieldset>
            <p className="gate-note">{t('communities', 'gate.declare.note')}</p>
            <Button type="submit" variant="primary">
              {t('communities', 'gate.declare.submit')}
            </Button>
          </form>
          <p className="gate-links">{goBackLink}</p>
        </>
      ) : state === 'hidden' ? (
        <>
          <p className="gate-flag">{t('communities', 'gate.flag')}</p>
          <h1>{t('communities', 'gate.hidden.title')}</h1>
          <p>{t('communities', subject === 'community' ? 'gate.hidden.community' : 'gate.hidden.post', { handle: shown })}</p>
          <div className="gate-actions">
            {intentForm('nsfw-once', t('communities', 'gate.once'), true)}
            {intentForm('nsfw-always', t('communities', 'gate.always'))}
            {goBackLink}
          </div>
          <p className="gate-note">{t('communities', 'gate.hidden.note', { handle: shown })}</p>
        </>
      ) : (
        <>
          <p className="gate-flag">{t('communities', 'gate.flag')}</p>
          <h1>{t('communities', subject === 'community' ? 'gate.community.title' : 'gate.post.title')}</h1>
          <p>{t('communities', subject === 'community' ? 'gate.community.about' : 'gate.post.about', { handle: shown })}</p>
          <p>{t('communities', 'gate.signedOut')}</p>
          <div className="gate-actions">
            <a className="gate-primary" href={`/auth/sign-in?redirect=${encodeURIComponent(back)}`}>
              {t('communities', 'gate.signIn')}
            </a>
            <a href="/auth/sign-up">{t('communities', 'gate.signUp')}</a>
            {goBackLink}
          </div>
        </>
      )}
    </main>
  );
}

/** The Hide NSFW button for a flagged community's header or a flagged post's flag line (a declared viewer who is showing NSFW). */
export function HideNsfwForm({ handle, back }: { handle: string; back: string }) {
  const { t } = useTranslate();
  return (
    <form method="post" action={communityPath({ handle })} className="gate-hide">
      <input type="hidden" name="intent" value="nsfw-hide" />
      <input type="hidden" name="redirect" value={back} />
      <Button type="submit" variant="neutral" size="sm">
        {t('communities', 'gate.hide')}
      </Button>
    </form>
  );
}
