// The image's Docker HEALTHCHECK. Only the web process has an HTTP liveness probe
// (/healthz); a container running worker or migrate has no web process and reports
// healthy, since it stops when its process exits. Detection reads /proc, so it needs no
// writable filesystem and works behind an init process (docker run --init).
import { readdirSync, readFileSync } from 'node:fs';

const runsWeb = readdirSync('/proc')
  .filter((entry) => /^\d+$/.test(entry))
  .some((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/app/.output/server/index.mjs');
    } catch {
      return false;
    }
  });
if (!runsWeb) process.exit(0);

const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`, { signal: AbortSignal.timeout(4_000) }).catch(
  () => undefined,
);
process.exit(response?.ok ? 0 : 1);
