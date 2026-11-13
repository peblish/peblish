import { type } from 'arktype';
import { logLine } from '../log-line.ts';

// Cloudflare's edge cache for public remote images (step one of "Remote images and storage").
// Edge caching is on only when the purge path is configured: without both variables every proxy
// answer is `private`, as before, so development, tests and staging behave as they always did.
// The token is operator configuration (like the S3 adapter's keys): it is read here, sent only
// to api.cloudflare.com (cloudflare.ts), and never logged.

/**
 * How long Cloudflare may hold a public proxy answer: the backstop if a purge is lost. One hour
 * keeps a taken-down image at most an hour at the edge in that case, while each image is
 * fetched from its host at most once an hour per Cloudflare cache (deploy/edge-cache.md).
 */
export const EDGE_MAX_AGE_SECONDS = 3600;

const Config = type({
  /** The zone's id: 32 hexadecimal characters (Cloudflare dashboard, the zone's Overview). */
  CLOUDFLARE_ZONE_ID: /^[0-9a-f]{32}$/,
  /** An API token with Zone, Cache Purge, Purge on that zone only. Printable, no spaces. */
  CLOUDFLARE_PURGE_TOKEN: /^[\x21-\x7e]{20,200}$/,
});

export type EdgeConfig = { zoneId: string; token: string };

const variables = ['CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_PURGE_TOKEN'] as const;

let reported = false;

/**
 * The purge configuration, or null when edge caching is off: neither variable set (the normal
 * case outside production), or a half-set or malformed pair, which is reported once per process
 * by name and never by value, and keeps edge caching off rather than caching without a purge.
 */
export function edgeConfig(env: Record<string, string | undefined> = process.env): EdgeConfig | null {
  if (variables.every((name) => !env[name])) return null;
  const result = Config({ CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID, CLOUDFLARE_PURGE_TOKEN: env.CLOUDFLARE_PURGE_TOKEN });
  if (result instanceof type.errors) {
    if (!reported) {
      reported = true;
      // Names only: an ArkType summary would quote the value it refused.
      const wrong = variables.filter((name) => !Config.get(name).allows(env[name]));
      console.error(logLine([`edge cache: ${wrong.join(' and ')} missing or malformed; edge caching stays off`]));
    }
    return null;
  }
  return { zoneId: result.CLOUDFLARE_ZONE_ID, token: result.CLOUDFLARE_PURGE_TOKEN };
}
