import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { pageSession, privateResponses } from '../../server/auth.ts';
import { headTitle } from '../../shell/title.ts';
import { YouPage } from './-ui/you-page.tsx';
import youCss from './-ui/you.css?url';

/** Signed in only: a visitor goes to sign in and comes back. The page itself reads the root's data. */
const loadYou = createServerFn({ method: 'GET' }).handler(async () => {
  if (!(await pageSession())) throw redirect({ to: '/auth/sign-in', search: { redirect: '/you' } });
  return null;
});

// /you: the phone's You destination (Commons), reached from the bottom bar and by its address; nothing
// else links to it, as a computer has the header's account menu and the sidebar instead. Personal, so
// never from a shared cache (server/auth.ts).
export const Route = createFileRoute('/you/')({
  loader: () => loadYou(),
  head: (context) => ({ meta: headTitle(context, 'shell', 'nav.you'), links: [{ rel: 'stylesheet', href: youCss }] }),
  staticData: { viewHeader: 'own' },
  component: YouPage,
  server: { middleware: [privateResponses] },
});
