import { createFileRoute } from '@tanstack/react-router';
import { privateResponses } from '../../server/auth.ts';
import { noGroupPage } from '../auth/-route.ts';

// Every response under /invite is carries the invite code, a bearer secret: never from a shared cache (server/auth.ts).
export const Route = createFileRoute('/invite')({
  beforeLoad: noGroupPage('/invite'),
  server: { middleware: [privateResponses] },
});
