import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Uuid } from '@peblish/schema/ids';
import { uuidv7 } from 'uuidv7';
import { media } from '../db/tables/media.ts';
import { writer } from '../db/write.ts';
import type { ScanState } from '../mediascan/state.ts';
import type { ObjectStore } from '../storage/store.ts';

// Lane SAFE's test support: a loopback stand-in for the Arachnid Shield API, and media rows in
// any scan state. The adapter is tested against this stub and nothing else; the real API,
// NCMEC and Cloudflare are never called. Test code only.

export type StubRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
};

export type StubAnswer = { status?: number; json?: unknown; text?: string; delayMs?: number };

export type ArachnidStub = {
  baseUrl: string;
  username: string;
  password: string;
  requests: StubRequest[];
  /** What `POST /v1/media` answers; the default says no-known-match. */
  onMedia: (answer: (request: StubRequest) => StubAnswer) => void;
  /** What `GET /v1/version` answers. */
  onVersion: (answer: StubAnswer) => void;
  close: () => Promise<void>;
};

/** A stub provider on 127.0.0.1 that wants Basic auth (the adapter's scheme) and records every request it sees. */
export async function startArachnidStub(options: { username?: string; password?: string } = {}): Promise<ArachnidStub> {
  const username = options.username ?? 'stub-user';
  const password = options.password ?? 'stub-password-not-a-secret';
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const requests: StubRequest[] = [];
  let media: (request: StubRequest) => StubAnswer = () => ({ json: { classification: 'no-known-match' } });
  let version: StubAnswer = { json: { version: 'stub-list-1' } };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: StubRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks),
      };
      requests.push(request);
      const answer: StubAnswer =
        request.authorization !== expected
          ? { status: 401, json: { error: 'unauthorized' } }
          : request.method === 'POST' && request.path === '/v1/media'
            ? media(request)
            : request.method === 'GET' && request.path === '/v1/version'
              ? version
              : { status: 404, json: { error: 'not found' } };
      setTimeout(() => {
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    username,
    password,
    requests,
    onMedia: (answer) => {
      media = answer;
    },
    onVersion: (answer) => {
      version = answer;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A media row of an upload in `state`, with its object in `store` unless `stored: false`.
 * Written directly, so no scan runs: tests arrange the state they need. `bytes` are whatever
 * the test wants hashed (they need not be a decodable image).
 */
export async function seedMedia(
  store: ObjectStore,
  options: {
    ownerId?: Uuid | null;
    state?: ScanState;
    bytes?: Uint8Array;
    mimeType?: string;
    createdAt?: Date;
    stored?: boolean;
    deleted?: boolean;
  } = {},
) {
  const id = uuidv7();
  const bytes = options.bytes ?? Buffer.from(`image ${id}`);
  const mimeType = options.mimeType ?? 'image/png';
  const storageKey = `media/${id}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
  if (options.stored !== false) await store.put(storageKey, bytes, mimeType);
  const [row] = await writer()
    .insert(media)
    .values({
      id,
      ownerId: options.ownerId ?? null,
      kind: 'upload',
      storageKey: options.stored === false ? null : storageKey,
      mimeType,
      byteSize: bytes.byteLength,
      width: 24,
      height: 16,
      sha256: sha256Of(bytes),
      scanState: options.state ?? 'pending',
      deletedAt: options.deleted ? new Date() : null,
      ...(options.createdAt && { createdAt: options.createdAt }),
    })
    .returning();
  if (!row) throw new Error('media row not written');
  return { ...row, bytes };
}
