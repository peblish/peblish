import { Button } from '@peblish/ui/components/button';
import { LinkTabs } from '@peblish/ui/components/link-tabs';
import { Link } from '@peblish/ui/components/link';
import { Text } from '@peblish/ui/components/text';
import type { ReactNode } from 'react';
import authCss from '../auth/-ui/auth.css?url';
import { AuthForm, Field } from '../auth/-ui/form.tsx';
import { FormActions } from '../auth/-ui/page.tsx';
import settingsCss from '../settings/-ui/settings.css?url';
import submitCss from '../submit/-ui/submit.css?url';
import { CommunityRules } from '../submit/-ui/community-aside.tsx';
import type { CommunityPanel } from '../submit/-types.ts';
import type { Composition } from './-states.tsx';

// The account pages' compositions (sign in and the other auth pages, settings, Create post), with a state
// page each at /kit/<key>, registered in -states.tsx. Their styles are the routes' own, linked here as the
// routes link them; each sample sits in its page's class, which carries the phone's 44px targets.

function Styled({ page, children }: { page: 'auth-page' | 'settings' | 'cmp-page'; children: ReactNode }) {
  return (
    <div className={page}>
      <link rel="stylesheet" href={authCss} precedence="default" />
      <link rel="stylesheet" href={settingsCss} precedence="default" />
      <link rel="stylesheet" href={submitCss} precedence="default" />
      {children}
    </div>
  );
}

/** A form field, alone or refused by the server (the form's alert links to it and it says so too). */
function SampleField({ disabled, refused }: { disabled?: boolean; refused?: boolean }) {
  const field = (
    <Field label="Username" name="username" autoComplete="username" placeholder="sam" hint="Letters, digits and _." disabled={disabled} />
  );
  return (
    <Styled page="auth-page">
      <AuthForm
        action="/kit/auth-field"
        label={refused ? 'Refused sample form' : 'Sample form'}
        error={refused ? 'name.taken' : undefined}
        className="auth-form"
      >
        {field}
      </AuthForm>
    </Styled>
  );
}

/** The end of a form: another way out at the start, the submit at the end. */
function Actions({ disabled, pending }: { disabled?: boolean; pending?: boolean }) {
  return (
    <Styled page="auth-page">
      <FormActions
        aside={
          <Text as="p" size="sm" color="muted">
            No account? <Link href="/auth/sign-up">Sign up with an invite</Link>
          </Text>
        }
      >
        <Button variant="primary" disabled={disabled} pending={pending}>
          Sign in
        </Button>
      </FormActions>
    </Styled>
  );
}

function Tabs({ current }: { current?: string }) {
  return (
    <Styled page="settings">
      <LinkTabs
        aria-label={current ? `Settings, ${current} current` : 'Settings, none current'}
        className="settings__nav"
        items={['Account', 'Security', 'Blocks'].map((label) => ({ to: `/kit/settings-tabs#${label}`, label, active: label === current }))}
      />
    </Styled>
  );
}

const panel: CommunityPanel = {
  id: 'sample',
  handle: 'bushwalking',
  href: '/c/bushwalking',
  summary: 'Tracks, huts and weather in the ranges.',
  warning: 'Name the track, not your camp.',
  sensitive: false,
  restricted: false,
  canPost: true,
  rules: [
    { title: 'Be civil', html: '<p>Argue the point, not the person.</p>' },
    { title: 'Stay on topic', html: null },
  ],
};

function Rules({ loading }: { loading?: boolean }) {
  return (
    <Styled page="cmp-page">
      <aside aria-label={`Community rules, ${loading ? 'loading' : 'chosen'}`} aria-busy={loading}>
        <CommunityRules panel={loading ? null : panel} loading={Boolean(loading)} />
      </aside>
    </Styled>
  );
}

export const accountPieces: Readonly<Record<string, Composition>> = {
  'auth-field': {
    name: 'Account form field',
    states: { rest: () => <SampleField />, disabled: () => <SampleField disabled />, invalid: () => <SampleField refused /> },
  },
  'form-actions': {
    name: 'Account form actions',
    states: { rest: () => <Actions />, disabled: () => <Actions disabled />, pending: () => <Actions pending /> },
  },
  'settings-tabs': {
    name: 'Settings tabs',
    states: { rest: () => <Tabs />, selected: () => <Tabs current="Security" /> },
  },
  'community-rules': {
    name: 'Community rules on Create post',
    states: { rest: () => <Rules />, pending: () => <Rules loading /> },
  },
};
