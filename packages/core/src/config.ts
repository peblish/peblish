import { type } from 'arktype';

// Process configuration from the environment, validated on first use (not at import, so
// building or type-checking never needs a database).

const Env = type({
  DATABASE_URL: 'string > 0',
  /** The instance origin that local ap_ids are minted under, such as https://feddit.com. */
  'PUBLIC_ORIGIN?': 'string.url',
});

function env() {
  const result = Env(process.env);
  if (result instanceof type.errors) throw new Error(`invalid environment: ${result.summary}`);
  return result;
}

export function databaseUrl(): string {
  return env().DATABASE_URL;
}

/**
 * The canonical form of an instance origin (scheme, lowercase host, port only when not the
 * default; no path). HTTPS only: plain HTTP is accepted solely for local development, with
 * PEBLISH_ALLOW_HTTP_ORIGIN=1 and a localhost or *.test host.
 */
export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`origin ${value} must be scheme and host only`);
  }
  if (url.protocol === 'http:') {
    const devHost = url.hostname === 'localhost' || url.hostname.endsWith('.test');
    if (process.env.PEBLISH_ALLOW_HTTP_ORIGIN !== '1' || !devHost) {
      throw new Error(`origin ${value} is not HTTPS (HTTP needs PEBLISH_ALLOW_HTTP_ORIGIN=1 and a localhost or .test host)`);
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(`origin ${value} is not HTTPS`);
  }
  return url.origin;
}

/** The configured instance origin, canonical, if any (migrate creates the local instance from it). */
export function publicOrigin(): string | undefined {
  const origin = env().PUBLIC_ORIGIN;
  return origin && canonicalOrigin(origin);
}
