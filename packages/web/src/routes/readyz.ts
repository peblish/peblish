import { createFileRoute } from '@tanstack/react-router';
import { databaseReady } from '@peblish/core/health';

// Readiness: the database answers.
export const Route = createFileRoute('/readyz')({
  server: {
    handlers: {
      GET: async () => {
        const ready = await databaseReady();
        return new Response(ready ? 'ready\n' : 'database unavailable\n', {
          status: ready ? 200 : 503,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...(ready ? {} : { 'retry-after': '5' }) },
        });
      },
    },
  },
});
