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

export function publicOrigin(): string {
  const origin = env().PUBLIC_ORIGIN;
  if (!origin) throw new Error('PUBLIC_ORIGIN is not set');
  return new URL(origin).origin;
}
