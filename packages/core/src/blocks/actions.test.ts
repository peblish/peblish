import { beforeEach, describe, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { blockCounts, listBlocks, listInstanceBlocks, resolveBlockTarget } from './actions.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  return {
    local,
    lemmy,
    alice: await seedPerson(local, 'alice'),
    bob: await seedActor(local, 'Person', 'Bob'),
    remoteBob: await seedActor(lemmy, 'Person', 'bob'),
    bot: await seedActor(lemmy, 'Service', 'helper'),
    news: await seedActor(local, 'Group', 'news'),
    tech: await seedActor(lemmy, 'Group', 'tech'),
    gone: await seedActor(lemmy, 'Group', 'gone', { deletedAt: new Date() }),
  };
}

describe('the block lists', () => {
  test('newest first, with counts and what an instance block hides', async () => {
    const w = await world();
    await seedBlock(w.alice, w.bob);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedBlock(w.alice, w.remoteBob);
    await seedBlock(w.alice, w.tech);
    await seedBlock(w.alice, { instance: w.lemmy });

    expect((await listBlocks(w.alice.id, 'person')).map((row) => row.actor.handle)).toEqual(['bob@lemmy.test', 'Bob']);
    expect((await listBlocks(w.alice.id, 'community')).map((row) => row.actor.handle)).toEqual(['tech@lemmy.test']);
    expect(await listInstanceBlocks(w.alice.id)).toMatchObject([{ domain: 'lemmy.test', people: 2, communities: 1 }]);
    expect(await blockCounts(w.alice.id)).toEqual({ person: 2, community: 1, instance: 1 });
    expect(await blockCounts(w.bob.id)).toEqual({ person: 0, community: 0, instance: 0 });
    expect(await listBlocks(w.bob.id, 'person')).toEqual([]);
  });
});

describe('resolveBlockTarget', () => {
  test('people: local and remote handles, with or without the @', async () => {
    const w = await world();
    const resolve = (input: string) => resolveBlockTarget('person', input);
    expect(await resolve('@Bob')).toEqual({ ok: true, target: { kind: 'person', actorId: w.bob.id }, label: '@Bob' });
    expect(await resolve('bob')).toMatchObject({ target: { actorId: w.bob.id } });
    expect(await resolve('@bob@feddit.test')).toMatchObject({ target: { actorId: w.bob.id } });
    expect(await resolve(' @bob@LEMMY.test ')).toEqual({
      ok: true,
      target: { kind: 'person', actorId: w.remoteBob.id },
      label: '@bob@lemmy.test',
    });
    expect(await resolve('@helper@lemmy.test')).toMatchObject({ target: { actorId: w.bot.id } });
    expect(await resolve('@nobody@lemmy.test')).toEqual({ ok: false, reason: 'handle.not_found' });
    expect(await resolve('@bob@unknown.test')).toEqual({ ok: false, reason: 'handle.not_found' });
    expect(await resolve('@news')).toEqual({ ok: false, reason: 'handle.not_found' });
    for (const bad of ['', '   ', '@', 'a b', '@a@b@c', '@bob@', '@bob@not a host'])
      expect(await resolve(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'handle.invalid' });
  });

  test('communities and instances', async () => {
    const w = await world();
    expect(await resolveBlockTarget('community', '!tech@lemmy.test')).toEqual({
      ok: true,
      target: { kind: 'community', actorId: w.tech.id },
      label: '!tech@lemmy.test',
    });
    expect(await resolveBlockTarget('community', 'news')).toMatchObject({ target: { actorId: w.news.id } });
    expect(await resolveBlockTarget('community', '!bob@lemmy.test')).toEqual({ ok: false, reason: 'handle.not_found' });
    for (const input of ['lemmy.test', 'LEMMY.test', 'https://lemmy.test/c/tech', 'lemmy.test/path'])
      expect(await resolveBlockTarget('instance', input), input).toEqual({
        ok: true,
        target: { kind: 'instance', instanceId: w.lemmy.id },
        label: 'lemmy.test',
      });
    expect(await resolveBlockTarget('instance', 'other.test')).toEqual({ ok: false, reason: 'handle.not_found' });
    expect(await resolveBlockTarget('instance', 'http://')).toEqual({ ok: false, reason: 'handle.invalid' });
    expect(await resolveBlockTarget('instance', 'not a host')).toEqual({ ok: false, reason: 'handle.invalid' });
  });
});
