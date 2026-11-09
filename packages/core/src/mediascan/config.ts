import { type } from 'arktype';

// Scanner configuration from the environment, validated on first use (not at import). Root
// documents the variables in deploy/README.md.

const defaultBaseUrl = 'https://shield.projectarachnid.com';

const Env = type({
  'ARACHNID_USERNAME?': 'string > 0',
  'ARACHNID_PASSWORD?': 'string > 0',
  'ARACHNID_BASE_URL?': 'string.url',
  /** `1` scans against the local list only (development and tests). */
  'MEDIASCAN_LOCAL_ONLY?': "'0' | '1' | ''",
  'MEDIASCAN_TIMEOUT_MS?': 'string.integer.parse',
  'MEDIASCAN_UNDECIDED_PURGE_DAYS?': 'string.integer.parse',
});

export type ScanConfig = {
  /** Both or neither of the Arachnid credentials. */
  arachnid: { username: string; password: string; baseUrl: string } | null;
  localOnly: boolean;
  timeoutMs: number;
  undecidedPurgeDays: number;
};

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The operator-set host of the Shield API: https, or http on a loopback address only (the test stub). Never with a login inside it. */
function baseUrl(value: string | undefined): string {
  const url = new URL(value ?? defaultBaseUrl);
  if (url.username || url.password) throw new Error('invalid ARACHNID_BASE_URL: it must not carry credentials');
  if (url.protocol === 'http:' ? !loopback.has(url.hostname) : url.protocol !== 'https:')
    throw new Error('invalid ARACHNID_BASE_URL: https only (http is accepted on a loopback address)');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function positive(name: string, value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid ${name}: a whole number of at least 1`);
  return result;
}

/** The scanner settings of `env` (the process environment unless a test passes its own). Throws a message that names the variable, never a value. */
export function scanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  const parsed = Env(env);
  if (parsed instanceof type.errors) throw new Error(`invalid scanner environment: ${parsed.summary}`);
  if ((parsed.ARACHNID_USERNAME === undefined) !== (parsed.ARACHNID_PASSWORD === undefined))
    throw new Error('invalid scanner environment: set both ARACHNID_USERNAME and ARACHNID_PASSWORD, or neither');
  return {
    arachnid:
      parsed.ARACHNID_USERNAME !== undefined && parsed.ARACHNID_PASSWORD !== undefined
        ? { username: parsed.ARACHNID_USERNAME, password: parsed.ARACHNID_PASSWORD, baseUrl: baseUrl(parsed.ARACHNID_BASE_URL) }
        : null,
    localOnly: parsed.MEDIASCAN_LOCAL_ONLY === '1',
    timeoutMs: positive('MEDIASCAN_TIMEOUT_MS', parsed.MEDIASCAN_TIMEOUT_MS, 8000),
    undecidedPurgeDays: positive('MEDIASCAN_UNDECIDED_PURGE_DAYS', parsed.MEDIASCAN_UNDECIDED_PURGE_DAYS, 7),
  };
}
