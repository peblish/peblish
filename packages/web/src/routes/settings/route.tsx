import { createFileRoute } from '@tanstack/react-router';
import { privateResponses } from '../../server/auth.ts';
import { noGroupPage } from '../auth/-ui/page.tsx';

// Every response under /settings is personal: never from a shared cache (server/auth.ts).
export const Route = createFileRoute('/settings')({
  beforeLoad: noGroupPage('/settings'),
  server: { middleware: [privateResponses] },
});
