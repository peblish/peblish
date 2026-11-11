import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { actors } from '@peblish/core/db/tables/actors';
import { posts } from '@peblish/core/db/tables/content';
import { communityBans } from '@peblish/core/moderation/tables';
import { forgetDeferredMirrors } from '@peblish/core/remote/moderators';
import { truncateAll } from '@peblish/core/testing/db';
import { actorDocument, rsaKeys, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { fetchModerators } from './moderators/refresh.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { activityId, addressedToCommunity, hosts, PUBLIC } from './test-support.ts';

// F1 (B07): an actor document that redirects to another actor does not speak for it. Each case
// is an actor the pipeline resolves (the activity's own actor, the actor inside a community's
// Announce, the person a Block targets) at an address on a hostile host that answers 301 to a
// victim elsewhere. Before the fix the victim was resolved, and deleted with its content or banned.

const { lemmyuser, pfuser, spike, fake, t1 } = hosts;
const alias = 'https://rogue.test/u/alias';
const context = ['https://join-lemmy.org/context.json', 'https://www.w3.org/ns/activitystreams'];

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  forgetDeferredMirrors();
  world = await seedInboundWorld();
});

/** The hostile host's alias answers 301 to `victim`, whose own server serves its real document. */
const redirectTo = (victim: string, host: string, name: string) =>
  stubFetch({
    [alias]: { status: 301, location: victim },
    [victim]: { body: actorDocument(host, name, { publicKeyPem: rsaKeys().publicKeyPem }) },
  });

const deliver = (json: Record<string, unknown>, fetch = redirectTo(lemmyuser, 'lemmy.test', 'lemmyuser').fetch) =>
  deliverRow(json, (row) => processRow(row, { fetch }));

/** Lemmy's account deletion with "delete content" (the actor deleting itself, removeData set), sent as the alias. */
const accountDelete = () => ({
  '@context': context,
  id: activityId('https://rogue.test', 'delete'),
  type: 'Delete',
  actor: alias,
  object: alias,
  to: [PUBLIC],
  removeData: true,
});

const victimState = async () => {
  const [actor] = await db().select({ deletedAt: actors.deletedAt }).from(actors).where(eq(actors.apId, lemmyuser));
  const [post] = await db().select({ deletedAt: posts.deletedAt, removedAt: posts.removedAt }).from(posts).where(eq(posts.apId, t1));
  return { actor: actor?.deletedAt ?? null, post: post?.deletedAt ?? post?.removedAt ?? null };
};

describe('an actor whose document redirects to another actor', () => {
  test('as the actor of a Delete with removeData is refused, and the actor it redirects to keeps its account and posts', async () => {
    const { stored } = await deliver(accountDelete());
    expect(stored).toEqual({ state: 'skipped', error: `actor.id_mismatch ${alias}` });
    expect(await victimState()).toEqual({ actor: null, post: null });
  });

  test('as the actor of a Delete inside a followed community’s Announce is refused the same way', async () => {
    const inner = accountDelete();
    const announce = {
      '@context': context,
      id: activityId('https://rogue.test', 'announce'),
      type: 'Announce',
      actor: fake,
      to: [PUBLIC],
      cc: [`${fake}/followers`],
      object: inner,
    };
    const { stored } = await deliver(announce);
    expect(stored).toEqual({ state: 'skipped', error: `actor.id_mismatch ${alias}` });
    expect(await victimState()).toEqual({ actor: null, post: null });
  });

  test('as the person a moderator’s Block targets is refused, and nobody is banned', async () => {
    // Lemmy's Block shape (inbound-0079-block): a moderator of the spike bans the alias, which redirects to pfuser.
    const block = {
      '@context': context,
      id: activityId('https://lemmy.test', 'block'),
      type: 'Block',
      actor: hosts.lemmyadmin,
      object: alias,
      target: spike,
      ...addressedToCommunity(spike),
      removeData: false,
      summary: 'spam',
    };
    const { stored } = await deliver(block, redirectTo(pfuser, 'piefed.test', 'pfuser').fetch);
    expect(stored).toEqual({ state: 'skipped', error: `actor.id_mismatch ${alias}` });
    const bans = await db()
      .select()
      .from(communityBans)
      .where(and(eq(communityBans.communityId, world.community.id), eq(communityBans.actorId, world.peers.pfuser.id)));
    expect(bans).toEqual([]);
  });

  test('as a member of a remote community’s moderators collection is left out of the mirror', async () => {
    const collection = `${hosts.lab}/moderators`;
    const { fetch } = stubFetch({
      [collection]: { body: { type: 'OrderedCollection', id: collection, orderedItems: [hosts.lemmyadmin, alias] } },
      [alias]: { status: 301, location: pfuser },
      [pfuser]: { body: actorDocument('piefed.test', 'pfuser', { publicKeyPem: rsaKeys().publicKeyPem }) },
    });
    expect(await fetchModerators(world.peers.lab.id, fetch)).toEqual({ collection, moderatorIds: [world.peers.lemmyadmin.id] });
  });
});
