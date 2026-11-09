import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { AwsClient } from 'aws4fetch';
import { assertKey, type ObjectStore } from './store.ts';

// The S3 adapter: MinIO in development, Cloudflare R2 in production. The names are reserved
// in deploy/README.md. Path-style addressing (endpoint/bucket/key), which both accept.
// aws4fetch signs the requests (SigV4); the endpoint is operator configuration, never a
// person's URL, so this is the one outbound client that does not go through safeFetch.

const Config = type({
  S3_ENDPOINT: 'string.url',
  S3_BUCKET: 'string > 0',
  S3_REGION: 'string > 0',
  S3_ACCESS_KEY_ID: 'string > 0',
  S3_SECRET_ACCESS_KEY: 'string > 0',
});
export type S3Config = typeof Config.infer;

/** The S3_* variables, validated when first used (not at import, so a build needs no bucket). */
export function s3ConfigFromEnv(): S3Config {
  const result = Config(process.env);
  if (result instanceof type.errors) throw new Error(`invalid storage environment: ${result.summary}`);
  return result;
}

const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const EMPTY_SHA256 = sha256(new Uint8Array());

export class StorageError extends Error {}

/**
 * A call (connecting, any retry, and reading the answer) still running after this long is
 * abandoned with a TimeoutError, so a stalled bucket cannot hold an upload or a request open.
 */
export const S3_TIMEOUT_MS = 30_000;

export type S3Store = ObjectStore & {
  /** Creates the bucket when it is missing (development and tests; production buckets exist). */
  ensureBucket(): Promise<void>;
};

export function s3Store(config: S3Config = s3ConfigFromEnv(), { timeoutMs = S3_TIMEOUT_MS }: { timeoutMs?: number } = {}): S3Store {
  const client = new AwsClient({
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    region: config.S3_REGION,
    service: 's3',
    retries: 2,
  });
  const base = `${config.S3_ENDPOINT.replace(/\/+$/, '')}/${encodeURIComponent(config.S3_BUCKET)}`;
  const call = (method: string, path: string, body?: Uint8Array, contentType?: string) =>
    client.fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body && { body: Buffer.from(body) }),
      headers: { 'x-amz-content-sha256': body ? sha256(body) : EMPTY_SHA256, ...(contentType && { 'content-type': contentType }) },
    });
  const fail = async (what: string, response: Response) =>
    new StorageError(`${what}: ${response.status} ${(await response.text()).slice(0, 200)}`);

  return {
    async put(key, body, contentType) {
      assertKey(key);
      const response = await call('PUT', `/${key}`, body, contentType);
      if (!response.ok) throw await fail(`put ${key}`, response);
      await response.arrayBuffer();
    },
    async get(key) {
      assertKey(key);
      const response = await call('GET', `/${key}`);
      if (response.status === 404) {
        await response.arrayBuffer();
        return null;
      }
      if (!response.ok) throw await fail(`get ${key}`, response);
      return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
    },
    async delete(key) {
      assertKey(key);
      const response = await call('DELETE', `/${key}`);
      if (!response.ok && response.status !== 404) throw await fail(`delete ${key}`, response);
      await response.arrayBuffer();
    },
    async ensureBucket() {
      const response = await call('PUT', '');
      // 409 BucketAlreadyOwnedByYou is what S3 answers to a second create.
      if (!response.ok && response.status !== 409) throw await fail(`create bucket ${config.S3_BUCKET}`, response);
      await response.arrayBuffer();
    },
  };
}
