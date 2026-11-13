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
// once the upload completes; the run then reads it back from the bucket and compares its SHA-256
// with the file's before calling it good. This client never deletes or overwrites an object (the
// production bucket locks backups/ and ledger/): a name that exists is refused. Every request asks
// for uncompressed answers (accept-encoding: identity): R2 otherwise gzips JSON answers of about
// 63 bytes or more, dropping their content-length and weakening their ETag (W/"..."), and Node's
// fetch asks for gzip by default. An answer that comes back encoded anyway, or a weak ETag the
// tool would compare or send back, fails the call. Errors name the call, the HTTP status and S3's
// error code, never the endpoint, a key or a response body.

const Config = type({
  BACKUP_S3_ENDPOINT: 'string > 0',
  BACKUP_S3_BUCKET: 'string > 0',
  BACKUP_S3_REGION: 'string > 0',
  BACKUP_S3_ACCESS_KEY_ID: 'string > 0',
  BACKUP_S3_SECRET_ACCESS_KEY: 'string > 0',
  /** The media bucket, required so the run can refuse to write backups into it. */
  S3_BUCKET: 'string > 0',
  'S3_ACCESS_KEY_ID?': 'string',
  /** `1` lets the endpoint be plain http: an internal development or staging store only, never production. */
  'BACKUP_S3_ALLOW_PLAIN_HTTP?': 'string',
});
export type BucketConfig = typeof Config.infer;

/** S3's bucket name rules: 3 to 63 lowercase letters, digits, dots and dashes, not like an IP address. */
const isBucketName = (name: string) =>
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) && !name.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(name);

/**
 * The BACKUP_S3_* variables, checked. Refused: a backup bucket that is the media bucket, the media
 * key as the backup key, a bucket name S3 would not accept, and an endpoint that is not a bare
 * origin (a path would put path-style requests under another bucket; credentials, a query or a
 * fragment have no place there) or not https, unless BACKUP_S3_ALLOW_PLAIN_HTTP is `1`.
 */
export function bucketConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BucketConfig {
  const checked = Config(env);
  if (checked instanceof type.errors) throw new CutoverError(`invalid backup bucket environment: ${formatProblems(checked)}`);
  for (const name of ['BACKUP_S3_BUCKET', 'S3_BUCKET'] as const) {
    if (!isBucketName(checked[name])) throw new CutoverError(`${name} is not a valid bucket name`);
  }
  if (checked.BACKUP_S3_BUCKET === checked.S3_BUCKET) {
    throw new CutoverError('BACKUP_S3_BUCKET is the media bucket (S3_BUCKET); backups need a bucket of their own');
  }
  if (checked.S3_ACCESS_KEY_ID && checked.BACKUP_S3_ACCESS_KEY_ID === checked.S3_ACCESS_KEY_ID) {
    throw new CutoverError('BACKUP_S3_ACCESS_KEY_ID is the media key (S3_ACCESS_KEY_ID); backups need a key limited to their bucket');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(checked.BACKUP_S3_ENDPOINT);
  } catch {
    throw new CutoverError('BACKUP_S3_ENDPOINT is not a URL');
  }
  if (endpoint.username || endpoint.password) throw new CutoverError('BACKUP_S3_ENDPOINT must not carry credentials');
  if (endpoint.search || endpoint.hash || !/^\/?$/.test(endpoint.pathname) || /[?#]/.test(checked.BACKUP_S3_ENDPOINT)) {
    throw new CutoverError('BACKUP_S3_ENDPOINT must be an origin only (scheme, host, port): no path, query or fragment');
  }
  const plain = checked.BACKUP_S3_ALLOW_PLAIN_HTTP;
  if (plain !== undefined && plain !== '' && plain !== '1') throw new CutoverError('BACKUP_S3_ALLOW_PLAIN_HTTP must be 1 or unset');
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && plain === '1')) {
    throw new CutoverError(
      'BACKUP_S3_ENDPOINT must be https (BACKUP_S3_ALLOW_PLAIN_HTTP=1 allows http for an internal store, never production)',
    );
  }
  return { ...checked, BACKUP_S3_ENDPOINT: endpoint.origin };
}

/**
 * 16 MiB parts: the memory a run holds (about three times this while a part is in flight). S3,
 * R2 and MinIO allow 10,000 parts, so an object can reach 156.25 GiB; every part but the last
 * must be 5 MiB or more and, for R2, all the same size, which a fixed size gives.
 */
export const PART_BYTES = 16 * 1024 * 1024;
export const MAX_PARTS = 10_000;

export type Timeouts = {
  /** One request and its answer (a part, a HEAD, a small object). */
  callMs: number;
  /** A streamed download that receives nothing for this long is abandoned. */
  idleMs: number;
  /** The whole transfer of an object of `size` bytes: a fixed allowance plus 1 MiB/s. */
  transferMs(size: number): number;
};
export const TIMEOUTS: Timeouts = {
  callMs: 120_000,
  idleMs: 60_000,
  transferMs: (size) => 10 * 60_000 + Math.ceil(size / (1024 * 1024)) * 1000,
};

/** Aborting an unfinished upload is best effort and must fit inside the process's shutdown. */
const ABORT_TIMEOUT_MS = 5_000;

const hex = (algorithm: string, body: Uint8Array) => createHash(algorithm).update(body).digest('hex');
const EMPTY_SHA256 = hex('sha256', new Uint8Array());

/** The upload completed but the object in the bucket does not match the file. */
export class UnverifiedObject extends CutoverError {}

export type ObjectHead = { size: number; etag: string | null; sha256: string | null };
export type ListedObject = { key: string; size: number };
export type Checked = { size: number; etag: string | null; sha256: string };

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

const anySignal = (...signals: (AbortSignal | undefined)[]) => AbortSignal.any(signals.filter((s) => s !== undefined));

export type Bucket = ReturnType<typeof backupBucket>;

export function backupBucket(config: BucketConfig, options: { partBytes?: number; timeouts?: Partial<Timeouts> } = {}) {
  const partBytes = options.partBytes ?? PART_BYTES;
  const timeouts = { ...TIMEOUTS, ...options.timeouts };
  const client = new AwsClient({
    accessKeyId: config.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: config.BACKUP_S3_SECRET_ACCESS_KEY,
    region: config.BACKUP_S3_REGION,
    service: 's3',
    retries: 2,
  });
  const base = `${config.BACKUP_S3_ENDPOINT}/${encodeURIComponent(config.BACKUP_S3_BUCKET)}`;

  /**
   * One signed call, abandoned after `callMs` unless `streaming` (the caller bounds the body then).
   * A network failure, timeout or stop becomes a CutoverError naming only `what`.
   */
  async function call(
    what: string,
    method: string,
    path: string,
    init: {
      body?: Buffer<ArrayBuffer>;
      headers?: Record<string, string>;
      signal?: AbortSignal | undefined;
      streaming?: boolean;
      timeoutMs?: number;
    } = {},
  ) {
    const signal = init.streaming ? init.signal : anySignal(AbortSignal.timeout(init.timeoutMs ?? timeouts.callMs), init.signal);
    let response: Response;
    try {
      response = await client.fetch(`${base}${path}`, {
        method,
        ...(signal && { signal }),
        ...(init.body && { body: init.body }),
        // Signed with the rest; fetch sends a caller's accept-encoding as it is instead of its own.
        headers: {
          'x-amz-content-sha256': init.body ? hex('sha256', init.body) : EMPTY_SHA256,
          ...init.headers,
          'accept-encoding': 'identity',
        },
      });
    } catch (error) {
      throw failure(what, error, init.signal);
    }
    // fetch would decode the body silently, but the length, ETag and checks would not be the object's.
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      await response.body?.cancel().catch(() => undefined);
      const named = /^[A-Za-z0-9-]{1,20}$/.test(encoding) ? ` (${encoding})` : '';
      throw new CutoverError(`${what}: the bucket answered compressed${named} although asked not to; its answer is not trusted`);
    }
    return response;
  }

  /** An answer's ETag without quotes, or null when it has none; a weak one (W/"...") is never compared or sent back. */
  function etagOf(what: string, response: Response): string | null {
    const etag = response.headers.get('etag');
    if (etag === null) return null;
    if (/^W\//i.test(etag)) throw new CutoverError(`${what}: the bucket answered with a weak ETag, which cannot be compared or sent back`);
    return etag.replaceAll('"', '');
  }

  /** S3's error code from a body, kept only when it is one word of letters (S3's own vocabulary). */
  const codeOf = (text: string) => {
    const code = tag(text, 'Code');
    return code && /^[A-Za-z]+$/.test(code) ? code : undefined;
  };

  async function refuse(what: string, response: Response): Promise<CutoverError> {
    const code = codeOf(await response.text().catch(() => ''));
    return new CutoverError(`${what}: ${response.status}${code ? ` ${code}` : ''}`);
  }

  async function ok(what: string, response: Response): Promise<string> {
    if (!response.ok) throw await refuse(what, response);
    const text = await response.text();
    // CompleteMultipartUpload can answer 200 and report its failure in the body.
    if (/<Error>/.test(text)) throw new CutoverError(`${what}: ${response.status} ${codeOf(text) ?? 'Error'}`);
    return text;
  }

  /** A conditional write the store refused: 412, or 404 for If-Match on a key that is gone. */
  const preconditionFailed = (response: Response) => response.status === 412 || response.status === 404;

  async function head(key: string, signal?: AbortSignal): Promise<ObjectHead | null> {
    const response = await call(`head ${assertName(key)}`, 'HEAD', `/${key}`, { signal });
    await response.arrayBuffer();
    if (response.status === 404) return null;
    if (!response.ok) throw new CutoverError(`head ${key}: ${response.status}`);
    const length = response.headers.get('content-length');
    if (length === null || !/^\d+$/.test(length)) throw new CutoverError(`head ${key}: the answer has no content-length`);
    return { size: Number(length), etag: etagOf(`head ${key}`, response), sha256: response.headers.get('x-amz-meta-sha256') };
  }

  /**
   * Streams `key`'s body to `sink`, chunk by chunk: abandoned when nothing arrives for `idleMs` or
   * the whole transfer outlasts `transferMs(size)`. Returns the SHA-256 and size it received.
   */
  async function stream(key: string, size: number, sink: (chunk: Uint8Array) => void, signal?: AbortSignal) {
    const what = `read ${key}`;
    const idle = new AbortController();
    const bound = anySignal(idle.signal, AbortSignal.timeout(timeouts.transferMs(size)), signal);
    const quiet = () => idle.abort(new CutoverError(`nothing received for ${Math.round(timeouts.idleMs / 1000)} s`));
    let timer = setTimeout(quiet, timeouts.idleMs);
    try {
      const response = await call(what, 'GET', `/${key}`, { signal: bound, streaming: true });
      if (!response.ok || !response.body) throw await refuse(what, response);
      const hash = createHash('sha256');
      let received = 0;
      try {
        for await (const chunk of response.body) {
          clearTimeout(timer);
          timer = setTimeout(quiet, timeouts.idleMs);
          hash.update(chunk);
          received += chunk.byteLength;
          sink(chunk);
        }
      } catch (error) {
        throw failure(what, error, bound);
      }
      return { sha256: hash.digest('hex'), size: received };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    head,

    /**
     * Uploads `file` as `key`: refused if `key` exists (nothing is ever overwritten), multipart,
     * `partBytes` at a time, the whole file's SHA-256 stored as the object's metadata. A failed
     * upload is aborted, so no object appears. Then checks the object: size, S3's multipart ETag
     * where the store gives that form, and its SHA-256 read back from the bucket. A mismatch
     * throws UnverifiedObject and leaves the object (it cannot be deleted); the caller never
     * records it as good.
     */
    async uploadFile(key: string, file: string, contentType: string, signal?: AbortSignal): Promise<Checked> {
      assertName(key);
      const fd = openSync(file, 'r');
      try {
        const size = fstatSync(fd).size;
        const parts = Math.max(1, Math.ceil(size / partBytes));
        if (parts > MAX_PARTS) throw new CutoverError(`${key}: ${size} bytes needs more than ${MAX_PARTS} parts of ${partBytes} bytes`);
        // Hashing, uploading and reading back each get the whole size-scaled budget of their own.
        const budget = () => anySignal(AbortSignal.timeout(timeouts.transferMs(size)), signal);
        // An early refusal only: the completion's If-None-Match is what stops an overwrite.
        if (await head(key, signal)) throw new CutoverError(`upload ${key}: an object of that name exists; it is never overwritten`);
        let bound = budget();
        const sha256 = await fileSha256(file, bound).catch((error: unknown) => {
          throw failure(`hash ${key}`, error, bound);
        });
        bound = budget();
        const created = await ok(
          `start upload ${key}`,
          await call(`start upload ${key}`, 'POST', `/${key}?uploads=`, {
            headers: { 'content-type': contentType, 'x-amz-meta-sha256': sha256 },
            signal: bound,
          }),
        );
        const uploadId = tag(created, 'UploadId');
        if (!uploadId) throw new CutoverError(`start upload ${key}: no upload id in the answer`);
        const query = (extra = '') => `?${extra}uploadId=${encodeURIComponent(uploadId)}`;
        const md5s: Buffer[] = [];
        try {
          const done: string[] = [];
          for (let n = 1; n <= parts; n++) {
            if (bound.aborted) throw failure(`upload ${key}`, bound.reason, bound);
            const body = Buffer.alloc(Math.min(partBytes, size - (n - 1) * partBytes));
            if (readSync(fd, body, 0, body.length, (n - 1) * partBytes) !== body.length)
              throw new CutoverError(`upload ${key}: the file shrank`);
            const md5 = createHash('md5').update(body).digest();
            const what = `upload ${key} part ${n} of ${parts}`;
            const response = await call(what, 'PUT', `/${key}${query(`partNumber=${n}&`)}`, {
              body,
              headers: { 'content-md5': md5.toString('base64') },
              signal: bound,
            });
            await ok(what, response);
            const etag = etagOf(what, response);
            if (!etag) throw new CutoverError(`${what}: no ETag in the answer`);
            done.push(`"${etag}"`);
            md5s.push(md5);
          }
          const manifest = `<CompleteMultipartUpload>${done
            .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
            .join('')}</CompleteMultipartUpload>`;
          // If-None-Match: * makes the store refuse the completion when another writer made the name first.
          const completed = await call(`complete upload ${key}`, 'POST', `/${key}${query()}`, {
            body: Buffer.from(manifest),
            headers: { 'content-type': 'application/xml', 'if-none-match': '*' },
            signal: bound,
          });
          if (completed.status === 412) {
            await completed.arrayBuffer();
            throw new CutoverError(`upload ${key}: an object of that name exists; it is never overwritten`);
          }
          await ok(`complete upload ${key}`, completed);
        } catch (error) {
          // Best effort and short (it also runs while the process stops): parts of an upload that
          // never completes are no object, and the lifecycle rule clears them.
          await call(`abort upload ${key}`, 'DELETE', `/${key}${query()}`, { timeoutMs: ABORT_TIMEOUT_MS })
            .then((r) => r.arrayBuffer())
            .catch(() => undefined);
          throw error;
        }
        bound = budget();
        const found = await head(key, bound);
        if (!found) throw new UnverifiedObject(`check ${key}: the bucket has no such object after the upload`);
        if (found.size !== size) throw new UnverifiedObject(`check ${key}: the bucket holds ${found.size} bytes, the file has ${size}`);
        if (found.etag && /^[0-9a-f]{32}-\d+$/.test(found.etag) && found.etag !== multipartEtag(md5s)) {
          throw new UnverifiedObject(`check ${key}: the bucket's ETag differs from the file's parts`);
        }
        const back = await stream(key, size, () => undefined, bound);
        if (back.size !== size || back.sha256 !== sha256)
          throw new UnverifiedObject(`check ${key}: the bytes read back differ from the file`);
        return { size, etag: found.etag, sha256 };
      } finally {
        closeSync(fd);
      }
    },

    /** A small object written whole: only the status records, under status/, which are rewritten. */
    /**
     * A small object written whole: only the status records, under status/, which are rewritten.
     * `replacing` makes the write conditional: an ETag means "only if the record is still that
     * one" (If-Match), null "only if there is none" (If-None-Match: *). Returns false when the
     * store refused it because another writer changed the record first.
     */
    async putSmall(
      key: string,
      text: string,
      contentType: string,
      options: { signal?: AbortSignal | undefined; replacing?: string | null } = {},
    ): Promise<boolean> {
      if (!assertName(key).startsWith('status/')) throw new CutoverError(`${key}: only status records are written whole`);
      const condition: Record<string, string> =
        options.replacing === undefined
          ? {}
          : options.replacing === null
            ? { 'if-none-match': '*' }
            : { 'if-match': `"${options.replacing}"` };
      const response = await call(`put ${key}`, 'PUT', `/${key}`, {
        body: Buffer.from(text),
        headers: { 'content-type': contentType, ...condition },
        signal: options.signal,
      });
      if (options.replacing !== undefined && preconditionFailed(response)) {
        await response.arrayBuffer();
        return false;
      }
      await ok(`put ${key}`, response);
      return true;
    },

    /** A small object and its ETag (for a conditional rewrite), or null when there is none; any other failure throws. */
    async getSmall(key: string, signal?: AbortSignal): Promise<{ text: string; etag: string | null } | null> {
      const response = await call(`get ${assertName(key)}`, 'GET', `/${key}`, { signal });
      if (response.status === 404) {
        await response.arrayBuffer();
        return null;
      }
      if (!response.ok) throw await refuse(`get ${key}`, response);
      const etag = etagOf(`get ${key}`, response);
      return { text: await ok(`get ${key}`, response), etag };
    },

    /**
     * Whether the store honours conditional PUTs, tested on status/conditional-probe.json: a second
     * If-None-Match: * write must be refused, an If-Match with a wrong ETag refused, and one with
     * the current ETag taken. R2 and MinIO do (R2 tested 2026-11-14, with the uncompressed answers
     * every call asks for); a store that does not weakens the status records' fencing
     * (deploy/backups.md).
     */
    async honoursConditions(signal?: AbortSignal): Promise<boolean> {
      const key = 'status/conditional-probe.json';
      const text = `${JSON.stringify({ probe: 'conditional writes', at: new Date().toISOString() })}\n`;
      await this.putSmall(key, text, 'application/json', { signal, replacing: null });
      // If-None-Match: * over an existing object must be refused...
      if (await this.putSmall(key, text, 'application/json', { signal, replacing: null })) return false;
      // ...and If-Match must take the current ETag and refuse any other.
      const etag = (await this.getSmall(key, signal))?.etag;
      if (!etag) return false;
      if (await this.putSmall(key, text, 'application/json', { signal, replacing: '0'.repeat(32) })) return false;
      return this.putSmall(key, text, 'application/json', { signal, replacing: etag });
    },

    /** Every object under `prefix`, in name order (the names are UTC times, so oldest first). */
    async list(prefix: string, signal?: AbortSignal): Promise<ListedObject[]> {
      const found: ListedObject[] = [];
      let token: string | undefined;
      do {
        const query = `?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
        const xml = await ok(`list ${prefix}`, await call(`list ${prefix}`, 'GET', `/${query}`, { signal }));
        for (const [, entry = ''] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = tag(entry, 'Key');
          if (key) found.push({ key, size: Number(tag(entry, 'Size')) });
        }
        token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
      } while (token);
      return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },

    /**
     * Downloads `key` to `file` (mode 600, refused if it exists) and checks its size and SHA-256
     * against `expected` (the status record) and the object's own metadata. A file that does not
     * match, or a download that fails or stops, is removed. Returns its size.
     */
    async fetchFile(key: string, file: string, expected: { size: number; sha256: string }, signal?: AbortSignal): Promise<number> {
      const found = await head(key, signal);
      if (!found) throw new CutoverError(`fetch ${key}: no such object`);
      if (found.size !== expected.size || found.sha256 !== expected.sha256) {
        throw new CutoverError(`fetch ${key}: the object does not match its status record`);
      }
      const fd = openPrivate(file);
      let complete = false;
      try {
        const got = await stream(
          key,
          found.size,
          (chunk) => {
            for (let at = 0; at < chunk.byteLength;) at += writeSync(fd, chunk, at);
          },
          signal,
        );
        if (got.size !== expected.size || got.sha256 !== expected.sha256) {
          throw new CutoverError(`fetch ${key}: the download does not match its status record; it was removed`);
        }
        complete = true;
        return got.size;
      } finally {
        closeSync(fd);
        if (!complete) rmSync(file, { force: true });
      }
    },
  };
}

/** A call's failure as a CutoverError: stopped, timed out, or the network's code, never its text. */
function failure(what: string, error: unknown, signal?: AbortSignal): CutoverError {
  if (error instanceof CutoverError) return error;
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof CutoverError) return new CutoverError(`${what}: ${reason.message}`);
    return new CutoverError(`${what}: ${reason instanceof Error && reason.name === 'TimeoutError' ? 'timed out' : 'stopped'}`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (cause instanceof Error && cause.name === 'TimeoutError') return new CutoverError(`${what}: timed out`);
  const code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  return new CutoverError(`${what}: the bucket did not answer (${code ?? (cause instanceof Error ? cause.name : 'unknown')})`);
}

/** The SHA-256 of a file, read as a stream; `signal` stops it. */
export async function fileSha256(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, signal ? { signal } : {})) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
