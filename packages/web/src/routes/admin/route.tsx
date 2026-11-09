import { createFileRoute } from '@tanstack/react-router';
import { privateResponses } from '../../server/auth.ts';
import { noGroupPage } from '../auth/-ui/page.tsx';

// Every response under /admin is personal: never from a shared cache (server/auth.ts).
export const Route = createFileRoute('/admin')({
  beforeLoad: noGroupPage('/admin'),
  server: { middleware: [privateResponses] },
});
