import { createFileRoute } from '@tanstack/react-router';
import { privateResponses } from '../../server/auth.ts';
import { noGroupPage } from './-route.ts';

// Every response under /auth is personal, or carries a bearer secret (a reset token in the reset page): never from a shared cache (server/auth.ts).
export const Route = createFileRoute('/auth')({
  beforeLoad: noGroupPage('/auth'),
  server: { middleware: [privateResponses] },
});
