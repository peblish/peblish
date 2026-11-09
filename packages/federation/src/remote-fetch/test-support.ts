import { readFileSync } from 'node:fs';
import { PUBLIC } from '../mapping/vocabulary.ts';

// Test support for the remote-fetch and backfill tests (never imported by product code): Lemmy-
// shaped documents on the `lemmy.test` host of the inbound world (core/testing/seed-fed-b.ts).

export const lemmy = 'https://lemmy.test';
export const lab = `${lemmy}/c/lab`;
export const lemmyuser = `${lemmy}/u/lemmyuser`;

type Doc = Record<string, unknown>;

// A real Lemmy 0.19.21 Page (the corpus' fetched document), rehosted per post below.
const template = JSON.parse(
  readFileSync(new URL('../test/fixtures/wire/lemmy-0.19.21/fetched/fetched-0026-page.json', import.meta.url), 'utf8'),
) as Doc;

/** The Page of post `n` in `lab` by `lemmyuser`, as Lemmy serves it; `extra` overrides fields. */
export function lemmyPage(n: number, extra: Doc = {}): Doc {
  return {
    ...template,
    id: `${lemmy}/post/${n}`,
    name: `Post ${n}`,
    attributedTo: lemmyuser,
    audience: lab,
    to: [lab, PUBLIC],
    cc: [],
    tag: [],
    published: '2026-11-01T10:00:00Z',
    ...extra,
  };
}

/** A comment on `inReplyTo` by `lemmyuser`, as Lemmy serves a Note. */
export function lemmyNote(n: number, inReplyTo: string, extra: Doc = {}): Doc {
  return {
    type: 'Note',
    id: `${lemmy}/comment/${n}`,
    attributedTo: lemmyuser,
    inReplyTo,
    to: [PUBLIC],
    cc: [],
    audience: lab,
    content: `<p>Comment ${n}</p>`,
    mediaType: 'text/html',
    source: { content: `Comment ${n}`, mediaType: 'text/markdown' },
    published: '2026-11-01T11:00:00Z',
    ...extra,
  };
}

/** Lemmy's Create(Page), as its community outbox lists it. */
export const createOf = (page: Doc): Doc => ({
  id: `${lemmy}/activities/create/${String(page.id).split('/').pop()}`,
  type: 'Create',
  actor: page.attributedTo,
  object: page,
  to: [PUBLIC],
  cc: [lab],
  audience: lab,
});

/** An OrderedCollection with its items inline, as Lemmy serves its outbox and featured. */
export const collection = (id: string, orderedItems: unknown[]): Doc => ({
  '@context': ['https://join-lemmy.org/context.json', 'https://www.w3.org/ns/activitystreams'],
  type: 'OrderedCollection',
  id,
  totalItems: orderedItems.length,
  orderedItems,
});

/** An Announce by `community` carrying `inner`, as Lemmy relays what its community accepts. */
export const announceOf = (community: string, id: string, inner: Doc): Doc => ({
  id,
  type: 'Announce',
  actor: community,
  to: [PUBLIC],
  cc: [`${community}/followers`],
  object: inner,
});
