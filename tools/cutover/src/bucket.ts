import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { type } from 'arktype';
import { AwsClient } from 'aws4fetch';
import { openPrivate } from './bundle.ts';
import { CutoverError, formatProblems } from './errors.ts';

// The backup bucket (deploy/backups.md): an S3-compatible bucket of its own, never the media
// bucket, with a key limited to it. Cloudflare R2 in production, MinIO on staging and in tests.
// Uploads are multipart from a file on disk, one part in memory at a time, each part signed with
// its SHA-256 and sent with its MD5 so the bucket refuses a damaged part. The object only exists
// once the upload completes, and a run then checks it from the bucket (size, and the multipart
// ETag where the bucket uses S3's form) before calling it good. Errors name the call, the HTTP
// status and S3's error code, never the endpoint, a key or a response body.

const Config = type({
  BACKUP_S3_ENDPOINT: 'string.url',
  BACKUP_S3_BUCKET: 'string > 0',
  BACKUP_S3_REGION: 'string > 0',
  BACKUP_S3_ACCESS_KEY_ID: 'string > 0',
  BACKUP_S3_SECRET_ACCESS_KEY: 'string > 0',
  /** The media bucket, required so the run can refuse to write backups into it. */
  S3_BUCKET: 'string > 0',
  'S3_ACCESS_KEY_ID?': 'string',
});
export type BucketConfig = typeof Config.infer;

/**
 * The BACKUP_S3_* variables, checked: refused when the backup bucket is the media bucket, when it
 * would use the media key, or when the endpoint carries credentials (it would be logged nowhere,
 * but a URL with a password in it should not exist at all).
 */
export function bucketConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BucketConfig {
  const checked = Config(env);
  if (checked instanceof type.errors) throw new CutoverError(`invalid backup bucket environment: ${formatProblems(checked)}`);
  if (checked.BACKUP_S3_BUCKET === checked.S3_BUCKET) {
    throw new CutoverError('BACKUP_S3_BUCKET is the media bucket (S3_BUCKET); backups need a bucket of their own');
  }
  if (checked.S3_ACCESS_KEY_ID && checked.BACKUP_S3_ACCESS_KEY_ID === checked.S3_ACCESS_KEY_ID) {
    throw new CutoverError('BACKUP_S3_ACCESS_KEY_ID is the media key (S3_ACCESS_KEY_ID); backups need a key limited to their bucket');
  }
  const endpoint = new URL(checked.BACKUP_S3_ENDPOINT);
  if (endpoint.username || endpoint.password) throw new CutoverError('BACKUP_S3_ENDPOINT must not carry credentials');
  if (endpoint.search || endpoint.hash) throw new CutoverError('BACKUP_S3_ENDPOINT must not have a query or fragment');
  return checked;
}

/**
 * 16 MiB parts: the memory a run holds (about three times this while a part is in flight). S3,
 * R2 and MinIO allow 10,000 parts, so an object can reach 156.25 GiB; every part but the last
 * must be 5 MiB or more and, for R2, all the same size, which a fixed size gives.
 */
export const PART_BYTES = 16 * 1024 * 1024;
export const MAX_PARTS = 10_000;

/** A call still running after this long is abandoned, so a stalled bucket cannot hold a run open. */
const CALL_TIMEOUT_MS = 120_000;

const hex = (algorithm: string, body: Uint8Array) => createHash(algorithm).update(body).digest('hex');
const EMPTY_SHA256 = hex('sha256', new Uint8Array());

/** The upload completed but the object in the bucket does not match the file. */
export class UnverifiedObject extends CutoverError {}

export type ObjectHead = { size: number; etag: string | null; sha256: string | null };
export type ListedObject = { key: string; size: number };

/** S3 answers keys and tokens XML-escaped. */
const unescapeXml = (text: string) =>
  text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name] ?? '');
const tag = (xml: string, name: string) => {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
  return match === undefined ? undefined : unescapeXml(match);
};

/** Object names this tool writes: letters, digits, dot, dash and underscore segments. */
function assertName(key: string): string {
  if (!/^[a-z]+\/[A-Za-z0-9._-]+$/.test(key)) throw new CutoverError(`object name ${key} is not one this tool writes`);
  return key;
}

/** S3's own multipart ETag: the MD5 of the parts' MD5s, a dash and the part count. */
export function multipartEtag(partMd5s: readonly Buffer[]): string {
  return `${createHash('md5').update(Buffer.concat(partMd5s)).digest('hex')}-${partMd5s.length}`;
}

export type Bucket = ReturnType<typeof backupBucket>;

export function backupBucket(config: BucketConfig, { partBytes = PART_BYTES }: { partBytes?: number } = {}) {
  const client = new AwsClient({
    accessKeyId: config.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: config.BACKUP_S3_SECRET_ACCESS_KEY,
    region: config.BACKUP_S3_REGION,
    service: 's3',
    retries: 2,
  });
  const base = `${config.BACKUP_S3_ENDPOINT.replace(/\/+$/, '')}/${encodeURIComponent(config.BACKUP_S3_BUCKET)}`;

  /** One signed call. A network failure or timeout becomes a CutoverError naming only `what`. */
  async function call(
    what: string,
    method: string,
    path: string,
    init: { body?: Buffer<ArrayBuffer>; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ) {
    const signals = [AbortSignal.timeout(CALL_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])];
    try {
      return await client.fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.any(signals),
        ...(init.body && { body: init.body }),
        headers: { 'x-amz-content-sha256': init.body ? hex('sha256', init.body) : EMPTY_SHA256, ...init.headers },
      });
    } catch (error) {
      if (init.signal?.aborted) throw new CutoverError(`${what}: stopped`);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
      const name = cause instanceof Error ? cause.name : 'unknown';
      throw new CutoverError(`${what}: the bucket did not answer (${code ?? name})`);
    }
  }

  /** The call's failure: status and S3's error code (a fixed vocabulary), never the body's message. */
  async function refuse(what: string, response: Response): Promise<CutoverError> {
    const code = tag(await response.text().catch(() => ''), 'Code');
    return new CutoverError(`${what}: ${response.status}${code && /^[A-Za-z]+$/.test(code) ? ` ${code}` : ''}`);
  }

  async function ok(what: string, response: Response): Promise<string> {
    if (!response.ok) throw await refuse(what, response);
    const text = await response.text();
    // CompleteMultipartUpload can answer 200 and report its failure in the body.
    if (/<Error>/.test(text)) throw new CutoverError(`${what}: ${response.status} ${tag(text, 'Code') ?? 'Error'}`);
    return text;
  }

  async function head(key: string): Promise<ObjectHead | null> {
    const response = await call(`head ${assertName(key)}`, 'HEAD', `/${key}`);
    await response.arrayBuffer();
    if (response.status === 404) return null;
    if (!response.ok) throw new CutoverError(`head ${key}: ${response.status}`);
    return {
      size: Number(response.headers.get('content-length')),
      etag: response.headers.get('etag')?.replaceAll('"', '') ?? null,
      sha256: response.headers.get('x-amz-meta-sha256'),
    };
  }

  return {
    head,

    /**
     * Uploads `file` as `key`: multipart, `partBytes` at a time, the whole file's SHA-256 stored as
     * the object's metadata (from a first read of the file) for a fetch to check. An upload that
     * fails is aborted, so no object appears. Then checks the object from the bucket; a mismatch
     * fails the run (deploy/backups.md says what is left behind). Returns the checked head.
     */
    async uploadFile(key: string, file: string, contentType: string, signal?: AbortSignal): Promise<ObjectHead & { sha256: string }> {
      assertName(key);
      const fd = openSync(file, 'r');
      try {
        const size = fstatSync(fd).size;
        const parts = Math.max(1, Math.ceil(size / partBytes));
        if (parts > MAX_PARTS) throw new CutoverError(`${key}: ${size} bytes needs more than ${MAX_PARTS} parts of ${partBytes} bytes`);
        const sha256 = await fileSha256(file);
        const created = await ok(
          `start upload ${key}`,
          await call(`start upload ${key}`, 'POST', `/${key}?uploads=`, {
            headers: { 'content-type': contentType, 'x-amz-meta-sha256': sha256 },
            ...(signal && { signal }),
          }),
        );
        const uploadId = tag(created, 'UploadId');
        if (!uploadId) throw new CutoverError(`start upload ${key}: no upload id in the answer`);
        const query = (extra = '') => `?${extra}uploadId=${encodeURIComponent(uploadId)}`;
        try {
          const done: { etag: string; md5: Buffer }[] = [];
          for (let n = 1; n <= parts; n++) {
            if (signal?.aborted) throw new CutoverError(`upload ${key}: stopped`);
            const body = Buffer.alloc(Math.min(partBytes, size - (n - 1) * partBytes));
            if (readSync(fd, body, 0, body.length, (n - 1) * partBytes) !== body.length)
              throw new CutoverError(`upload ${key}: the file shrank`);
            const md5 = createHash('md5').update(body).digest();
            const what = `upload ${key} part ${n} of ${parts}`;
            const response = await call(what, 'PUT', `/${key}${query(`partNumber=${n}&`)}`, {
              body,
              headers: { 'content-md5': md5.toString('base64') },
              ...(signal && { signal }),
            });
            await ok(what, response);
            const etag = response.headers.get('etag');
            if (!etag) throw new CutoverError(`${what}: no ETag in the answer`);
            done.push({ etag, md5 });
          }
          const manifest = `<CompleteMultipartUpload>${done
            .map((part, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${part.etag}</ETag></Part>`)
            .join('')}</CompleteMultipartUpload>`;
          await ok(
            `complete upload ${key}`,
            await call(`complete upload ${key}`, 'POST', `/${key}${query()}`, {
              body: Buffer.from(manifest),
              headers: { 'content-type': 'application/xml' },
              ...(signal && { signal }),
            }),
          );
          const found = await head(key);
          if (!found) throw new UnverifiedObject(`check ${key}: the bucket has no such object after the upload`);
          if (found.size !== size) throw new UnverifiedObject(`check ${key}: the bucket holds ${found.size} bytes, the file has ${size}`);
          const expected = multipartEtag(done.map((part) => part.md5));
          // R2 and MinIO give S3's multipart ETag; a bucket that answers another form is checked by size only.
          if (found.etag && /^[0-9a-f]{32}-\d+$/.test(found.etag) && found.etag !== expected) {
            throw new UnverifiedObject(`check ${key}: the bucket's checksum differs from the file's`);
          }
          return { ...found, sha256 };
        } catch (error) {
          // Best effort: an upload that never completes holds no object; the lifecycle rule clears its parts too.
          await call(`abort upload ${key}`, 'DELETE', `/${key}${query()}`)
            .then((r) => r.arrayBuffer())
            .catch(() => undefined);
          throw error;
        }
      } finally {
        closeSync(fd);
      }
    },

    /** A small object written whole (the status records). */
    async putSmall(key: string, text: string, contentType: string): Promise<void> {
      await ok(
        `put ${assertName(key)}`,
        await call(`put ${key}`, 'PUT', `/${key}`, { body: Buffer.from(text), headers: { 'content-type': contentType } }),
      );
    },

    async getSmall(key: string): Promise<string | null> {
      const response = await call(`get ${assertName(key)}`, 'GET', `/${key}`);
      if (response.status === 404) {
        await response.arrayBuffer();
        return null;
      }
      return ok(`get ${key}`, response);
    },

    /** Every object under `prefix`, in name order (the names are UTC times, so oldest first). */
    async list(prefix: string): Promise<ListedObject[]> {
      const found: ListedObject[] = [];
      let token: string | undefined;
      do {
        const query = `?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
        const xml = await ok(`list ${prefix}`, await call(`list ${prefix}`, 'GET', `/${query}`));
        for (const [, entry = ''] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = tag(entry, 'Key');
          if (key) found.push({ key, size: Number(tag(entry, 'Size')) });
        }
        token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
      } while (token);
      return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },

    /**
     * Downloads `key` to `file` (mode 600, refused if it exists), streaming, and checks its size and
     * SHA-256 against the object's metadata. A file that does not match is removed. Returns its size.
     */
    async fetchFile(key: string, file: string): Promise<number> {
      const found = await head(key);
      if (!found) throw new CutoverError(`fetch ${key}: no such object`);
      if (!found.sha256) throw new CutoverError(`fetch ${key}: the object has no sha256 record, so it is not one this tool wrote`);
      const fd = openPrivate(file);
      let complete = false;
      try {
        const response = await call(`fetch ${key}`, 'GET', `/${key}`);
        if (!response.ok || !response.body) throw await refuse(`fetch ${key}`, response);
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of response.body) {
          hash.update(chunk);
          size += chunk.byteLength;
          for (let at = 0; at < chunk.byteLength;) at += writeSync(fd, chunk, at);
        }
        if (size !== found.size || hash.digest('hex') !== found.sha256) {
          throw new CutoverError(`fetch ${key}: the download does not match the object's size and sha256 record; it was removed`);
        }
        complete = true;
        return size;
      } finally {
        closeSync(fd);
        if (!complete) rmSync(file, { force: true });
      }
    },

    /** Best effort, for an object a run made and could not verify; the key may lack delete permission. */
    async remove(key: string): Promise<boolean> {
      const response = await call(`delete ${assertName(key)}`, 'DELETE', `/${key}`).catch(() => null);
      await response?.arrayBuffer();
      return response?.ok === true;
    },
  };
}

/** The SHA-256 of a file, read as a stream. */
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
