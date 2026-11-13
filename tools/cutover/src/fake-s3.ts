import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A small path-style S3 for the backup tests, with no network beyond loopback: multipart
// uploads (checking each part's Content-MD5 as S3 does), whole PUTs, HEAD, GET, ListObjectsV2
// and a refused DELETE (the backup key has no delete permission). It does not check signatures.
// Like R2 (measured 2026-11-14, deploy/backups.md), it gzips a GET or HEAD of a JSON object of
// R2_GZIP_BYTES or more when the request accepts gzip: no content-length, a weak ETag.
// `faults` changes its behaviour mid-test to reproduce what a real store can do.

type Stored = { body: Buffer; contentType: string; meta: Record<string, string>; etag: string };

export type Faults = {
  /** Answer this part number with 500 (after the client's own retries, the upload fails). */
  failPart?: number;
  /** HEAD and GET answer this ETag instead of the stored one (a store with another ETag form). */
  etag?: string;
  /** Complete stores the object with its last byte flipped: same size, same ETag, other bytes. */
  corrupt?: boolean;
  /** GET sends this many bytes, then nothing more (a stalled download). */
  stallAfter?: number;
  /** Runs when the client closes the connection of a stalled GET. */
  stalledClosed?: () => void;
  /** GET sends its body in chunks of this size, one every `slowMs` milliseconds. */
  slowChunk?: number;
  slowMs?: number;
  /** Every request answers 403 AccessDenied. */
  deny?: boolean;
  /** Only PUTs of whole objects answer 403 AccessDenied (reads still work). */
  denyPut?: boolean;
  /** Each part and whole PUT waits this long before answering. */
  slowPutMs?: number;
  /** Runs just before a completion is applied, as if another writer got there first. */
  beforeComplete?: () => void;
  /** Runs just before a whole PUT is applied (once), as if another writer got there first. */
  beforePut?: (key: string) => void;
  /** Completion answers 200 with this error code in its body. */
  completeError?: string;
  /** The store ignores If-Match and If-None-Match, as one without conditional writes would. */
  ignoreConditions?: boolean;
  /** The store ignores If-Match only (honours If-None-Match). */
  ignoreIfMatch?: boolean;
  /** GET and HEAD answer without an ETag header. */
  noEtagOnGet?: boolean;
  /** JSON answers are gzipped as R2 does even when the request asks for identity. */
  compressAlways?: boolean;
  /** GET and HEAD answer a weak ETag (W/"...") on an uncompressed answer, as a proxy might. */
  weakEtag?: boolean;
};

/** The smallest JSON body R2 was seen to gzip (40 bytes was not; 63 was). */
export const R2_GZIP_BYTES = 63;

export type FakeS3 = {
  endpoint: string;
  objects: Map<string, Stored>;
  faults: Faults;
  /** Each request as `METHOD path?query`, oldest first. */
  requests: string[];
  /** Each request's accept-encoding header (undefined when none was sent), in the same order. */
  acceptEncodings: (string | undefined)[];
  /** Puts an object as the tool would have (with its sha256 metadata). */
  seed(key: string, body: Buffer | string, meta?: Record<string, string>): void;
  close(): Promise<void>;
};

const md5 = (body: Buffer) => createHash('md5').update(body).digest();
const xmlError = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>no</Message></Error>`;

export async function fakeS3(bucket: string): Promise<FakeS3> {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; contentType: string; meta: Record<string, string>; parts: Map<number, Buffer> }>();
  const faults: Faults = {};
  const requests: string[] = [];
  const acceptEncodings: (string | undefined)[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => (req.method === 'PUT' && faults.slowPutMs ? setTimeout(handle, faults.slowPutMs) : handle()));
    const handle = () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://fake');
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      acceptEncodings.push(req.headers['accept-encoding']);
      const send = (status: number, text = '', headers: Record<string, string> = {}) => {
        res.writeHead(status, headers);
        res.end(text);
      };
      if (faults.deny) return send(403, xmlError('AccessDenied'));
      const [, name, ...rest] = url.pathname.split('/');
      if (name !== bucket) return send(404, xmlError('NoSuchBucket'));
      const key = rest.map(decodeURIComponent).join('/');
      const q = url.searchParams;
      const meta = Object.fromEntries(
        Object.entries(req.headers)
          .filter(([h]) => h.startsWith('x-amz-meta-'))
          .map(([h, v]) => [h, String(v)]),
      );

      // S3's conditional writes: If-None-Match: * needs no object, If-Match its current ETag.
      const refused = (): boolean => {
        if (faults.ignoreConditions) return false;
        const current = objects.get(key);
        const none = req.headers['if-none-match'];
        const match = req.headers['if-match'];
        const fail = (status: number, code: string) => (send(status, xmlError(code)), true);
        if (none === '*' && current) return fail(412, 'PreconditionFailed');
        if (faults.ignoreIfMatch) return false;
        if (match !== undefined && !current) return fail(404, 'NoSuchKey');
        if (match !== undefined && current && match.replaceAll('"', '') !== current.etag) return fail(412, 'PreconditionFailed');
        return false;
      };

      if (req.method === 'GET' && key === '' && q.get('list-type') === '2') {
        const prefix = q.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = Number(q.get('continuation-token') ?? 0);
        const page = keys.slice(start, start + 2);
        const more = start + 2 < keys.length;
        const contents = page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('');
        return send(
          200,
          `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`,
        );
      }
      if (req.method === 'POST' && q.has('uploads')) {
        const id = randomUUID();
        uploads.set(id, { key, contentType: req.headers['content-type'] ?? '', meta, parts: new Map() });
        return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        const upload = uploads.get(q.get('uploadId')!);
        if (!upload) return send(404, xmlError('NoSuchUpload'));
        const n = Number(q.get('partNumber'));
        if (faults.failPart === n) return send(500, xmlError('InternalError'));
        if (req.headers['content-md5'] !== md5(body).toString('base64')) return send(400, xmlError('BadDigest'));
        upload.parts.set(n, body);
        return send(200, '', { etag: `"${md5(body).toString('hex')}"` });
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const id = q.get('uploadId')!;
        const upload = uploads.get(id);
        if (!upload) return send(404, xmlError('NoSuchUpload'));
        if (faults.completeError) return send(200, xmlError(faults.completeError));
        faults.beforeComplete?.();
        if (refused()) return;
        // The manifest decides the object: its parts, in its order, each with the ETag it was given.
        const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"?([0-9a-f]+)"?<\/ETag>/g)];
        if (listed.length === 0) return send(400, xmlError('MalformedXML'));
        const parts: Buffer[] = [];
        for (const [, n, tagged] of listed) {
          const part = upload.parts.get(Number(n));
          if (!part || md5(part).toString('hex') !== tagged) return send(400, xmlError('InvalidPart'));
          parts.push(part);
        }
        const whole = Buffer.concat(parts);
        if (faults.corrupt && whole.length > 0) whole[whole.length - 1] = whole[whole.length - 1]! ^ 0xff;
        const etag = `${createHash('md5')
          .update(Buffer.concat(parts.map((p) => md5(p))))
          .digest('hex')}-${parts.length}`;
        objects.set(upload.key, { body: whole, contentType: upload.contentType, meta: upload.meta, etag });
        uploads.delete(id);
        return send(200, `<CompleteMultipartUploadResult><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId')!);
        return send(204);
      }
      if (req.method === 'DELETE') return send(403, xmlError('AccessDenied'));
      if (req.method === 'PUT') {
        if (faults.denyPut) return send(403, xmlError('AccessDenied'));
        const before = faults.beforePut;
        delete faults.beforePut;
        before?.(key);
        if (refused()) return;
        objects.set(key, { body, contentType: req.headers['content-type'] ?? '', meta, etag: md5(body).toString('hex') });
        return send(200, '', { etag: `"${md5(body).toString('hex')}"` });
      }
      const found = objects.get(key);
      if (req.method === 'HEAD' || req.method === 'GET') {
        if (!found) return send(404, req.method === 'GET' ? xmlError('NoSuchKey') : '');
        const gzip =
          found.contentType === 'application/json' &&
          found.body.length >= R2_GZIP_BYTES &&
          (faults.compressAlways || /\bgzip\b/.test(req.headers['accept-encoding'] ?? ''));
        if (gzip) {
          const headers = {
            'content-type': found.contentType,
            'content-encoding': 'gzip',
            ...(!faults.noEtagOnGet && { etag: `W/"${faults.etag ?? found.etag}"` }),
            ...found.meta,
          };
          if (req.method === 'HEAD') return send(200, '', headers);
          res.writeHead(200, headers);
          return res.end(gzipSync(found.body));
        }
        const etag = `${faults.weakEtag ? 'W/' : ''}"${faults.etag ?? found.etag}"`;
        const headers = {
          'content-length': String(found.body.length),
          'content-type': found.contentType,
          ...(!faults.noEtagOnGet && { etag }),
          ...found.meta,
        };
        if (req.method === 'HEAD') return send(200, '', headers);
        res.writeHead(200, headers);
        if (faults.stallAfter !== undefined) {
          res.write(found.body.subarray(0, faults.stallAfter));
          const closed = faults.stalledClosed;
          if (closed) res.on('close', closed);
          return; // never ends
        }
        if (faults.slowChunk) {
          let at = 0;
          const step = () => {
            if (res.destroyed) return;
            res.write(found.body.subarray(at, at + faults.slowChunk!));
            at += faults.slowChunk!;
            if (at >= found.body.length) res.end();
            else setTimeout(step, faults.slowMs ?? 10);
          };
          return step();
        }
        return res.end(found.body);
      }
      send(400, xmlError('NotImplemented'));
    };
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    faults,
    requests,
    acceptEncodings,
    seed(key, body, meta = {}) {
      const bytes = Buffer.from(body);
      objects.set(key, { body: bytes, contentType: 'application/octet-stream', meta, etag: md5(bytes).toString('hex') });
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
