import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Uuid } from '@peblish/schema/ids';
import { newObjectApId } from '@peblish/schema/actor-urls';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { posts } from '../db/tables/content.ts';
import { media } from '../db/tables/media.ts';
import { siteSettings } from '../db/tables/site.ts';
import { writer } from '../db/write.ts';
import { scanConfig } from '../mediascan/config.ts';
import { scanUpload } from '../mediascan/scan.ts';
import type { ScanState } from '../mediascan/state.ts';
import { mediaBlocklist } from '../mediascan/tables.ts';
import { mediaUrl } from '../mediascan/usage.ts';
import { s3Store } from '../storage/s3.ts';
import type { ObjectStore } from '../storage/store.ts';
import { seedAccount, seedTwoFactor } from './seed-a.ts';
import { seedActor } from './seed.ts';

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

export type StubAnswer = { status?: number; json?: unknown; text?: string; delayMs?: number; headers?: Record<string, string> };

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
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers });
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

// The e2e seeds, on the lane database and its bucket (DATABASE_URL and S3_* from scripts/lane.sh):
//   node packages/core/src/testing/seed-safe.ts admin
//   node packages/core/src/testing/seed-safe.ts quarantined
//   node packages/core/src/testing/seed-safe.ts states
//   node packages/core/src/testing/seed-safe.ts object <media id>
//   node packages/core/src/testing/seed-safe.ts remote-media <on|off>
// Each prints one JSON value. Names are fresh per call, so the lane database keeps earlier runs.

const suffix = () => Math.random().toString(36).slice(2, 8);

async function localPeople(name: string) {
  const row = await localInstance(db());
  return { instance: { ...row, domain: new URL(row.origin).host, local: true }, name: `${name}_${suffix()}` };
}

/** An admin with two-factor on, as the payload budget and the auth flows seed one. */
async function admin() {
  const account = await seedAccount(`sa_${suffix()}`, { role: 'admin' });
  const { secret } = await seedTwoFactor(account.userId, 'peblish-safe-totp-secret-01234567');
  return { name: account.name, password: account.password, totpSecret: secret };
}

/** A real quarantine, made the way the product makes one: an upload whose hash is on the list, scanned by the inline path. Its image post is live. */
async function quarantined() {
  const store = s3Store();
  await store.ensureBucket();
  const { instance, name } = await localPeople('uploader');
  const uploader = await seedActor(instance, 'Person', name);
  const row = await seedMedia(store, { ownerId: uploader.id });
  await writer()
    .insert(mediaBlocklist)
    .values({ kind: 'sha256', value: row.sha256!, category: 'spam', reason: 'e2e' })
    .onConflictDoNothing();
  const state = await scanUpload(row.id, { store, config: scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' }) });
  const community = await seedActor(instance, 'Group', `pics_${suffix()}`);
  const id = uuidv7();
  const title = `Quarantined image ${suffix()}`;
  await writer()
    .insert(posts)
    .values({
      id,
      apId: newObjectApId(instance.origin, 'post', id),
      local: true,
      instanceId: instance.id,
      authorId: uploader.id,
      communityId: community.id,
      title,
      url: mediaUrl(instance.origin, row.id),
      publishedAt: new Date(),
    });
  return { mediaId: row.id, state, uploader: `@${uploader.name}@${instance.domain}`, postId: id, postTitle: title, sha256: row.sha256 };
}

/** One media row in each state, a deleted clean one, and an id that never existed: what /media/<id> must answer alike. */
async function states() {
  const store = s3Store();
  await store.ensureBucket();
  const rows = {} as Record<string, string>;
  for (const state of ['pending', 'clean', 'quarantined', 'blocked', 'failed'] as const)
    rows[state] = (await seedMedia(store, { state })).id;
  rows.deleted = (await seedMedia(store, { state: 'clean', deleted: true })).id;
  rows.unknown = uuidv7();
  return rows;
}

async function object(mediaId: string) {
  const [row] = await db().select({ key: media.storageKey, state: media.scanState }).from(media).where(eq(media.id, mediaId));
  const exists = row?.key ? (await s3Store().get(row.key)) !== null : false;
  return { state: row?.state ?? null, storageKey: row?.key ?? null, exists };
}

/** The remote_media.enabled switch is lane ADM's to write in the product; the pause-switch check flips the row directly. */
export async function remoteMedia(on: boolean) {
  await writer()
    .insert(siteSettings)
    .values({ key: 'remote_media.enabled', value: on })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: on } });
  return { remoteMedia: on };
}

if (import.meta.main) {
  try {
    const [command, argument] = process.argv.slice(2);
    if (command === 'admin') console.log(JSON.stringify(await admin()));
    else if (command === 'quarantined') console.log(JSON.stringify(await quarantined()));
    else if (command === 'states') console.log(JSON.stringify(await states()));
    else if (command === 'object' && argument) console.log(JSON.stringify(await object(argument)));
    else if (command === 'remote-media' && (argument === 'on' || argument === 'off'))
      console.log(JSON.stringify(await remoteMedia(argument === 'on')));
    else
      throw new Error(
        'usage: node packages/core/src/testing/seed-safe.ts admin | quarantined | states | object <id> | remote-media <on|off>',
      );
  } finally {
    await closePools();
  }
}
