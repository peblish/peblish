import { generateKeyPairSync } from 'node:crypto';
import { systemPrincipal } from '../authz/system.ts';
import { db } from '../db/read.ts';
import { actorKeys } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane FED-A's test support: the local instance with its instance actor, a peer that answers
// fetches from a table, and peer documents. Test code only; never imported by product code (lint).

/** A new RSA-2048 keypair as PEM (SPKI public, PKCS#8 private), for a peer or an actor under test. */
export function rsaKeys(modulusLength = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** The local instance row and its instance actor (the actor the system principal acts as). */
export async function seedLocalInstance(domain = 'fed-a.test') {
  const instance = await seedInstance(domain, true);
  const instanceActor = await seedActor(instance, 'Application', domain, { apId: `https://${domain}/` });
  return { instance, instanceActor, importer: () => systemPrincipal(db(), 'import') };
}

type Answer = { status?: number; type?: string; body?: unknown; location?: string };
type StubInit = { method?: 'GET' | 'POST'; headers?: HeadersInit; body?: string | Uint8Array };

/**
 * A stand-in for safeFetch that answers from `routes` (URL to answer) and records every request.
 * An unlisted URL answers 404. The shape matches safeFetch's, so it is passed as the `fetch`
 * option of the code under test.
 */
export function stubFetch(routes: Record<string, Answer | ((init: StubInit) => Answer)>) {
  const requests: { url: string; method: string; headers: Headers; body: string | Uint8Array | undefined; init: unknown }[] = [];
  const fetch = async (url: string | URL, init: StubInit) => {
    const href = String(url);
    requests.push({ url: href, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, init });
    const route = routes[href];
    const answer = typeof route === 'function' ? route(init) : (route ?? { status: 404 });
    const headers = new Headers({ 'content-type': answer.type ?? 'application/activity+json' });
    if (answer.location) headers.set('location', answer.location);
    const text = answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status ?? 200, headers, body: new TextEncoder().encode(text), url: href };
  };
  return { fetch, requests };
}

/** A WebFinger answer naming `links` (rel self, ActivityPub type) the way Lemmy and peblish write it. */
export function webfingerAnswer(subject: string, links: { href: string; type: 'Person' | 'Group' }[]) {
  return {
    subject,
    links: links.map(({ href, type }) => ({
      rel: 'self',
      type: 'application/activity+json',
      href,
      properties: { 'https://www.w3.org/ns/activitystreams#type': type },
    })),
  };
}

/** A Lemmy-shaped actor document for `https://<host>/u/<name>` (or /c/ for a Group) carrying `publicKeyPem`. */
export function actorDocument(
  host: string,
  name: string,
  { kind = 'Person', publicKeyPem, extra = {} }: { kind?: 'Person' | 'Group'; publicKeyPem: string; extra?: Record<string, unknown> },
) {
  const apId = `https://${host}/${kind === 'Group' ? 'c' : 'u'}/${name}`;
  return {
    '@context': ['https://join-lemmy.org/context.json', 'https://www.w3.org/ns/activitystreams'],
    type: kind,
    id: apId,
    preferredUsername: name,
    inbox: `${apId}/inbox`,
    outbox: `${apId}/outbox`,
    followers: `${apId}/followers`,
    endpoints: { sharedInbox: `https://${host}/inbox` },
    publicKey: { id: `${apId}#main-key`, owner: apId, publicKeyPem },
    published: '2026-11-08T02:25:31.775836Z',
    ...extra,
  };
}

/** NodeInfo discovery and document answers for `host`, for stubFetch routes. */
export function nodeInfoRoutes(host: string, software: string, version = '1.0.0'): Record<string, Answer> {
  const document = `https://${host}/nodeinfo/2.1`;
  return {
    [`https://${host}/.well-known/nodeinfo`]: {
      type: 'application/json',
      body: { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: document }] },
    },
    [document]: { type: 'application/json', body: { version: '2.1', software: { name: software, version } } },
  };
}

/** A local actor's signing key as actor_keys holds it (private half included), at `<ap_id>#main-key`. */
export async function seedSigningKey(actor: { id: string; apId: string }) {
  const keys = rsaKeys();
  await writer()
    .insert(actorKeys)
    .values({
      actorId: actor.id,
      keyId: `${actor.apId}#main-key`,
      algorithm: 'rsa',
      publicKeyPem: keys.publicKeyPem,
      privateKeyPem: keys.privateKeyPem,
    });
  return { keyId: `${actor.apId}#main-key`, ...keys };
}
