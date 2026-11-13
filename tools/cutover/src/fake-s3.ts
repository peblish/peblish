import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A small path-style S3 for the backup tests, with no network beyond loopback: multipart
// uploads (checking each part's Content-MD5 as S3 does), whole PUTs, HEAD, GET, ListObjectsV2
// and a refused DELETE (the backup key has no delete permission). It does not check signatures.
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
  /** GET sends its body in chunks of this size, one every `slowMs` milliseconds. */
  slowChunk?: number;
  slowMs?: number;
  /** Every request answers 403 AccessDenied. */
  deny?: boolean;
};

export type FakeS3 = {
  endpoint: string;
  objects: Map<string, Stored>;
  faults: Faults;
  /** Each request as `METHOD path?query`, oldest first. */
  requests: string[];
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

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://fake');
      requests.push(`${req.method} ${url.pathname}${url.search}`);
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
        const numbers = [...upload.parts.keys()].sort((a, b) => a - b);
        const parts = numbers.map((n) => upload.parts.get(n)!);
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
        objects.set(key, { body, contentType: req.headers['content-type'] ?? '', meta, etag: md5(body).toString('hex') });
        return send(200, '', { etag: `"${md5(body).toString('hex')}"` });
      }
      const found = objects.get(key);
      if (req.method === 'HEAD' || req.method === 'GET') {
        if (!found) return send(404, req.method === 'GET' ? xmlError('NoSuchKey') : '');
        const headers = {
          'content-length': String(found.body.length),
          'content-type': found.contentType,
          etag: `"${faults.etag ?? found.etag}"`,
          ...found.meta,
        };
        if (req.method === 'HEAD') return send(200, '', headers);
        res.writeHead(200, headers);
        if (faults.stallAfter !== undefined) {
          res.write(found.body.subarray(0, faults.stallAfter));
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
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    faults,
    requests,
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
