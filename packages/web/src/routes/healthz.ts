import { createFileRoute } from '@tanstack/react-router';

// Liveness: the process serves requests. It does not touch the database, so a database
// outage never restarts the app (readiness is /readyz).
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () => new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }),
    },
  },
});
