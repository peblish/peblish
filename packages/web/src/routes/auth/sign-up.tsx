import { auth } from '@peblish/core/identity/auth';
import { localHandles } from '@peblish/core/identity/handles';
import { attempt } from '@peblish/core/identity/throttle';
import { register } from '@peblish/core/registration/register';
import { ageOn, dateOfBirth, SignUpBody } from '@peblish/schema/identity';
import { Button } from '@peblish/ui/components/button';
import { Checkbox } from '@peblish/ui/components/checkbox';
import { Group } from '@peblish/ui/components/group';
import { Link } from '@peblish/ui/components/link';
import { Notice } from '@peblish/ui/components/notice';
import { Select } from '@peblish/ui/components/select';
import { Separator } from '@peblish/ui/components/separator';
import { Text } from '@peblish/ui/components/text';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { type } from 'arktype';
import { useId } from 'react';
import { useTranslate } from '../../i18n/use-translate.ts';
import {
  ageGateCookie,
  ageGated,
  clientIp,
  forbidden,
  forwardedHeaders,
  lookupInviteFor,
  PRIVATE_NO_STORE,
  readForm,
  respond,
  sameOrigin,
} from '../../server/auth.ts';
import { useRouteHydrated } from '../../shell/hydration.ts';
import { asFormError } from './-ui/errors.ts';
import { AuthForm, Field, rich } from './-ui/form.tsx';
import { authHead, SearchText } from './-route.ts';
import { AuthCard } from './-ui/page.tsx';
import { input } from '../../server/input.ts';
import { errorLine } from '@peblish/core/error-line';

const Search = type({ 'error?': SearchText, 'invite?': SearchText, 'username?': SearchText });

const loadSignUp = createServerFn({ method: 'GET' })
  .validator(input(type({ 'invite?': 'string' })))
  .handler(async ({ data }) => {
    // Per browser (the age gate): the server function's own reply, on a client-side navigation, too.
    setResponseHeader('cache-control', PRIVATE_NO_STORE);
    const { host } = await localHandles();
    // An under-16 answer blocks this browser for 24 hours (server/auth.ts).
    if (ageGated(getRequest())) return { host, blocked: true, invite: null };
    // Over the budget of unknown codes, the hint is left out; the POST says why.
    return { host, blocked: false, invite: data.invite ? await lookupInviteFor(getRequest(), data.invite) : null };
  });

export const Route = createFileRoute('/auth/sign-up')({
  validateSearch: Search,
  loaderDeps: ({ search }) => ({ invite: search.invite }),
  loader: ({ deps }) => loadSignUp({ data: deps.invite ? { invite: deps.invite } : {} }),
  head: authHead,
  component: SignUp,
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return forbidden();
        if (ageGated(request)) return respond(request, { redirect: '/auth/sign-up' });
        const body = SignUpBody(await readForm(request));
        if (body instanceof type.errors) return respond(request, { error: 'form.invalid', back: '/auth/sign-up' });
        const back = { back: '/auth/sign-up', keep: { invite: body.invite, username: body.username } };
        if (body.terms !== 'on') return respond(request, { error: 'terms.required', ...back });
        // Guessing invite codes: a code that matches no invite counts against the address.
        const counted = await attempt('invite-code', { ip: clientIp(request) });
        if (!counted.allowed) return respond(request, { error: 'rate.limited', ...back });
        const dob = dateOfBirth(body.day, body.month, body.year);
        const result = await register({
          inviteCode: body.invite,
          name: body.username.trim(),
          email: body.email,
          password: body.password,
          age: dob ? ageOn(dob) : null,
        });
        if (result.ok || result.reason !== 'invite.unknown') await counted.refund();
        if (!result.ok) {
          if (result.reason === 'age.under_16') return respond(request, { redirect: '/auth/sign-up', cookies: [await ageGateCookie()] });
          return respond(request, { error: asFormError(result.reason) ?? 'generic', ...back });
        }
        const api = (await auth()).api;
        const { headers } = await api.signInEmail({
          body: { email: result.email, password: body.password, rememberMe: true },
          headers: forwardedHeaders(request),
          returnHeaders: true,
        });
        try {
          await api.sendVerificationEmail({ body: { email: result.email } });
        } catch (error) {
          // The account exists; the verify page offers to send the link again.
          console.error(`sign-up: the verification email failed: ${errorLine(error)}`);
        }
        return respond(request, { redirect: '/auth/verify', cookies: headers.getSetCookie() });
      },
    },
  },
});

function SignUp() {
  const data = Route.useLoaderData();
  useRouteHydrated();
  return <AuthCard>{data.blocked ? <UnderSixteen host={data.host} /> : <SignUpForm />}</AuthCard>;
}

function UnderSixteen({ host }: { host: string }) {
  const { t } = useTranslate();
  return (
    <div className="auth-form">
      <Text as="h1" variant="heading" size="sm">
        {t('auth', 'under16.title')}
      </Text>
      <Notice tone="warning" role="alert">
        {t('auth', 'under16.body', { host })}
      </Notice>
      <Text as="p" size="sm" color="muted">
        {t('auth', 'under16.retry')}
      </Text>
      <Text as="p">
        <Link href="/">{t('auth', 'under16.back', { host })}</Link>
      </Text>
    </div>
  );
}

function SignUpForm() {
  const { locale, t } = useTranslate();
  const search = Route.useSearch();
  const { host, invite } = Route.useLoaderData();
  const dob = useId();
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const months = Array.from({ length: 12 }, (_, month) => ({ id: String(month + 1), label: monthName.format(Date.UTC(2000, month, 1)) }));
  return (
    <AuthForm action="/auth/sign-up" label={t('auth', 'signUp.title')} error={asFormError(search.error)} className="auth-form">
      <Text as="h1" variant="heading" size="sm">
        {t('auth', 'signUp.title')}
      </Text>
      <Field
        label={t('auth', 'signUp.invite')}
        name="invite"
        required
        defaultValue={search.invite}
        autoComplete="off"
        hint={
          invite?.status === 'valid' && invite.inviter ? (
            <Text size="sm" className="auth-tone--ok">
              {t('auth', 'signUp.inviteValid', { inviter: invite.inviter.handle, left: invite.usesLeft, max: invite.maxUses })}
            </Text>
          ) : invite && invite.status !== 'valid' ? (
            <Text size="sm" className="auth-tone--error">
              {t('auth', `error.invite.${invite.status}`)}
            </Text>
          ) : undefined
        }
      />
      <Field
        label={t('auth', 'signUp.username')}
        name="username"
        required
        defaultValue={search.username}
        autoComplete="username"
        placeholder={t('auth', 'signUp.usernamePlaceholder')}
        hint={t('auth', 'signUp.usernameHint', { host })}
      />
      <Field label={t('auth', 'signUp.email')} name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
      <Field
        label={t('auth', 'signUp.password')}
        name="password"
        type="password"
        required
        minLength={12}
        autoComplete="new-password"
        hint={t('auth', 'signUp.passwordHint')}
      />
      <div className="auth-dob">
        <Text as="span" variant="label" size="md" id={`${dob}-label`}>
          {t('auth', 'signUp.dob')}
        </Text>
        <Group aria-labelledby={`${dob}-label`} aria-describedby={`${dob}-hint`} className="auth-dob__parts">
          <Field
            label={t('auth', 'signUp.day')}
            name="day"
            inputMode="numeric"
            maxLength={2}
            required
            placeholder={t('auth', 'signUp.dayPlaceholder')}
          />
          <Select label={t('auth', 'signUp.month')} name="month" required defaultValue="" placeholder="" items={months} />
          <Field
            label={t('auth', 'signUp.year')}
            name="year"
            inputMode="numeric"
            maxLength={4}
            required
            placeholder={t('auth', 'signUp.yearPlaceholder')}
          />
        </Group>
        <Text as="span" size="sm" color="muted" id={`${dob}-hint`}>
          {t('auth', 'signUp.dobHint')}
        </Text>
      </div>
      <Checkbox name="terms" required>
        {/* One span: the label lays its children out as flex items. */}
        <span>
          {rich(t('auth', 'signUp.terms'), {
            terms: <Link href="/terms">{t('auth', 'signUp.termsLink')}</Link>,
            privacy: <Link href="/privacy">{t('auth', 'signUp.privacyLink')}</Link>,
            rules: <Link href="/rules">{t('auth', 'signUp.rulesLink')}</Link>,
          })}
        </span>
      </Checkbox>
      <Button type="submit" variant="primary" className="auth-submit">
        {t('auth', 'signUp.submit')}
      </Button>
      <Separator />
      <Text as="p" size="sm" color="muted">
        {t('auth', 'signUp.haveAccount')} <Link href="/auth/sign-in">{t('auth', 'signUp.signIn')}</Link>
      </Text>
    </AuthForm>
  );
}
