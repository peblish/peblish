import { Badge } from '@peblish/ui/components/badge';
import { Button } from '@peblish/ui/components/button';
import { ButtonLink } from '@peblish/ui/components/button-link';
import { Card } from '@peblish/ui/components/card';
import { Group } from '@peblish/ui/components/group';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Select } from '@peblish/ui/components/select';
import { Text } from '@peblish/ui/components/text';
import { TextField } from '@peblish/ui/components/text-field';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslate } from '../../../i18n/use-translate.ts';
import { useRouteHydrated } from '../../../shell/hydration.ts';
import { communityPath } from '../../../shell/paths.ts';

// The NSFW gate (R2 pick nsfw-gate-page), one Mux Card that stands for the whole community page,
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

/** Back one step in the browser's history, else the front page. Mux's Link runs onClick before it opens its href. */
function goBack(event: MouseEvent<HTMLElement>) {
  if (window.history.length > 1) {
    event.preventDefault();
    window.history.back();
  }
}

/** The gate's page: one outlined Card in a narrow column. */
function Panel({ state, subject, children }: { state: GateData['state']; subject: GateData['subject']; children: ReactNode }) {
  return (
    <main className="gate" data-state={state} data-subject={subject}>
      <Card.Root variant="outlined" padding="lg" className="gate-card">
        {children}
      </Card.Root>
    </main>
  );
}

const Heading = ({ children }: { children: ReactNode }) => (
  <Text as="h1" variant="heading" size="sm">
    {children}
  </Text>
);
const Body = ({ children }: { children: ReactNode }) => <Text as="p">{children}</Text>;

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
    <Link href="/" onClick={goBack}>
      {t('communities', 'gate.back')}
    </Link>
  );
  const flag = <Badge kind="nsfw">{t('communities', 'gate.flag')}</Badge>;

  if (state === 'under-16')
    return (
      <Panel state={state} subject={subject}>
        <Heading>{t('communities', 'gate.under16.title')}</Heading>
        <Body>{t('communities', 'gate.under16.body')}</Body>
        <div className="gate-actions">{goBackLink}</div>
      </Panel>
    );

  if (state === 'age')
    return (
      <Panel state={state} subject={subject}>
        <Heading>{t('communities', 'gate.declare.title')}</Heading>
        <Body>{t('communities', 'gate.declare.body')}</Body>
        {message && (
          <Notice tone="danger" role="alert">
            {message}
          </Notice>
        )}
        <form method="post" action={action} className="gate-declare">
          <input type="hidden" name="intent" value="declare" />
          <input type="hidden" name="redirect" value={back} />
          {/* A Mux Group named by its label, as sign-up's date of birth. */}
          <div className="gate-birth">
            <Text as="span" variant="label" id="gate-birth-label">
              {t('communities', 'gate.declare.legend')}
            </Text>
            <Group aria-labelledby="gate-birth-label" className="gate-date">
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
            </Group>
          </div>
          <Text as="p" size="sm" color="muted">
            {t('communities', 'gate.declare.note')}
          </Text>
          <Button type="submit" variant="primary">
            {t('communities', 'gate.declare.submit')}
          </Button>
        </form>
        <div className="gate-actions">{goBackLink}</div>
      </Panel>
    );

  if (state === 'hidden')
    return (
      <Panel state={state} subject={subject}>
        <div>{flag}</div>
        <Heading>{t('communities', 'gate.hidden.title')}</Heading>
        <Body>{t('communities', subject === 'community' ? 'gate.hidden.community' : 'gate.hidden.post', { handle: shown })}</Body>
        <div className="gate-actions">
          {intentForm('nsfw-once', t('communities', 'gate.once'), true)}
          {intentForm('nsfw-always', t('communities', 'gate.always'))}
          {goBackLink}
        </div>
        <Text as="p" size="sm" color="muted">
          {t('communities', 'gate.hidden.note', { handle: shown })}
        </Text>
      </Panel>
    );

  return (
    <Panel state={state} subject={subject}>
      <div>{flag}</div>
      <Heading>{t('communities', subject === 'community' ? 'gate.community.title' : 'gate.post.title')}</Heading>
      <Body>{t('communities', subject === 'community' ? 'gate.community.about' : 'gate.post.about', { handle: shown })}</Body>
      <Body>{t('communities', 'gate.signedOut')}</Body>
      <div className="gate-actions">
        <ButtonLink href={`/auth/sign-in?redirect=${encodeURIComponent(back)}`}>{t('communities', 'gate.signIn')}</ButtonLink>
        <Link href="/auth/sign-up">{t('communities', 'gate.signUp')}</Link>
        {goBackLink}
      </div>
    </Panel>
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
