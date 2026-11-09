import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedInboxWorld } from '../testing/seed-e2.ts';
import { seedActor } from '../testing/seed.ts';
import { findMentioned } from './scan.ts';

beforeEach(truncateAll);

const scan = (input: { bodyMd?: string | null; raw?: unknown; authorId: string }) =>
  findMentioned(db(), { bodyMd: input.bodyMd ?? null, raw: input.raw ?? null, authorId: input.authorId });

describe('findMentioned', () => {
  test('finds a person of this instance named in full, whatever the case, and nobody else', async () => {
    const w = await seedInboxWorld();
    const { author, reader, moderator } = w.people;
    expect(await scan({ bodyMd: 'hi @reader@feddit.test and @MODERATOR@Feddit.test', authorId: author.id })).toEqual(
      expect.arrayContaining([reader.id, moderator.id]),
    );
    // A bare name is text at launch, a remote host is not our person, and a code span is not a mention.
    expect(await scan({ bodyMd: 'hi @reader and @reader@lemmy.test', authorId: author.id })).toEqual([]);
    expect(await scan({ bodyMd: 'say `@reader@feddit.test` or\n\n```\n@reader@feddit.test\n```', authorId: author.id })).toEqual([]);
    expect(await scan({ bodyMd: '[@reader@feddit.test](https://x.test)', authorId: author.id })).toEqual([]);
  });

  test('never the author, and not a deleted person or a community', async () => {
    const w = await seedInboxWorld();
    const { author, reader } = w.people;
    expect(await scan({ bodyMd: '@author@feddit.test', authorId: author.id })).toEqual([]);
    expect(await scan({ bodyMd: '@open@feddit.test', authorId: author.id })).toEqual([]);
    await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, reader.id));
    expect(await scan({ bodyMd: '@reader@feddit.test', authorId: author.id })).toEqual([]);
  });

  test('reads a peer’s Mention tags, as one object or an array, from https hrefs of our people only', async () => {
    const w = await seedInboxWorld();
    const { author, reader, moderator, remoteAuthor } = w.people;
    const tag = (href: string) => ({ type: 'Mention', href, name: '@x@feddit.test' });
    expect(await scan({ raw: { tag: tag(reader.apId) }, authorId: remoteAuthor.id })).toEqual([reader.id]);
    const many = { tag: [{ type: 'Hashtag', href: 'https://lemmy.test/t/x', name: '#x' }, tag(reader.apId), tag(moderator.apId), 'junk'] };
    expect(await scan({ raw: many, authorId: remoteAuthor.id })).toEqual(expect.arrayContaining([reader.id, moderator.id]));
    // A remote person's href, a made-up one, a non-Mention tag and a tag naming the author itself do nothing.
    expect(await scan({ raw: { tag: tag(author.apId) }, authorId: author.id })).toEqual([]);
    expect(await scan({ raw: { tag: tag(remoteAuthor.apId) }, authorId: author.id })).toEqual([]);
    expect(await scan({ raw: { tag: tag('https://feddit.test/ap/u.nobody') }, authorId: author.id })).toEqual([]);
    expect(await scan({ raw: { tag: { type: 'Hashtag', href: reader.apId } }, authorId: author.id })).toEqual([]);
    expect(await scan({ raw: { tag: 'Mention' }, authorId: author.id })).toEqual([]);
    expect(await scan({ raw: 'not a document', authorId: author.id })).toEqual([]);
  });

  test('an http href is ignored even when it names a stored actor', async () => {
    const w = await seedInboxWorld();
    const insecure = await seedActor(w.instances.local, 'Person', 'insecure', { apId: 'http://feddit.test/ap/u.insecure' });
    expect(await scan({ raw: { tag: { type: 'Mention', href: insecure.apId } }, authorId: w.people.author.id })).toEqual([]);
  });

  test('stops at 50 people', async () => {
    const w = await seedInboxWorld();
    const names = Array.from({ length: 55 }, (_, n) => `person${n}`);
    for (const name of names) await seedActor(w.instances.local, 'Person', name);
    const found = await scan({ bodyMd: names.map((name) => `@${name}@feddit.test`).join(' '), authorId: w.people.author.id });
    expect(found).toHaveLength(50);
    const tags = names.map((name) => ({ type: 'Mention', href: `https://feddit.test/ap/u.${name}` }));
    expect(await scan({ raw: { tag: tags }, authorId: w.people.author.id })).toHaveLength(50);
  });
});
