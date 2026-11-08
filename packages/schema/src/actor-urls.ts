// Actor and object id policy (frozen G0 contract 6).
// New local actors get ActivityPub ids /ap/u.<name> and /ap/c.<name>, with human pages at
// /u/<name> and /c/<name>. The ap_id stored on each row is what federation uses, so imported
// feddit.com actors keep the URLs peers already know; never rebuild an id from a name.

export const ACTOR_NAME = /^[A-Za-z0-9_]{1,50}$/;

type LocalActorKind = 'Person' | 'Group';

const prefix = { Person: 'u', Group: 'c' } as const satisfies Record<LocalActorKind, string>;

/** ActivityPub id for a new local actor; `origin` is the instance origin, such as https://feddit.com. */
export function newActorApId(origin: string, kind: LocalActorKind, name: string): string {
  if (!ACTOR_NAME.test(name)) throw new RangeError(`actor name ${JSON.stringify(name)} must match ${ACTOR_NAME}`);
  return new URL(`/ap/${prefix[kind]}.${name}`, origin).href;
}

/** Human page path of a local actor. */
export function actorPagePath(kind: LocalActorKind, name: string): string {
  return `/${prefix[kind]}/${encodeURIComponent(name)}`;
}

/** ActivityPub ids for local objects and activities, keyed by the row's uuid. */
export function newObjectApId(origin: string, kind: 'post' | 'comment' | 'activity', id: string): string {
  return new URL(`/ap/${kind}/${id}`, origin).href;
}

/** Endpoints of the instance actor, which lives at the origin's root. */
export function instanceActorUrls(origin: string) {
  const root = new URL(origin).origin;
  return { apId: `${root}/`, inbox: `${root}/inbox`, outbox: `${root}/outbox`, sharedInbox: `${root}/inbox`, keyId: `${root}/#main-key` };
}

/** Endpoints of a new local Person or Group, below its ap_id; every actor shares /inbox. */
export function localActorUrls(origin: string, kind: LocalActorKind, name: string) {
  const apId = newActorApId(origin, kind, name);
  return {
    apId,
    inbox: `${apId}/inbox`,
    outbox: `${apId}/outbox`,
    followers: `${apId}/followers`,
    sharedInbox: new URL('/inbox', origin).href,
    keyId: `${apId}#main-key`,
  };
}
