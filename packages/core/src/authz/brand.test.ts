import { describe, expect, test } from 'vitest';
import { createPost } from '../posts/create.ts';
import { Authorized, issueGrant } from './brand.ts';

// Runtime forgery attempts against a genuine grant. None may pass verify(), and a mutation
// must refuse each before it writes.

const actorId = '0192f5a0-0000-7000-8000-0000000000a1';
const communityId = '0192f5a0-0000-7000-8000-0000000000c1';
const principal = { kind: 'local', actorId, siteRole: 'user' } as const;
const subject = { communityId };
const authority = { kind: 'local-role', actorId, role: 'user', communityId } as const;
const args = ['post.create', principal, subject, authority];

const genuine = issueGrant('post.create', principal, subject, authority);

describe('grant forgery', () => {
  test('a genuine grant verifies for its own action only', () => {
    expect(Authorized.verify(genuine, 'post.create')).toBe(true);
    expect(Authorized.verify(genuine, 'vote.cast')).toBe(false);
  });

  test('Reflect.construct on a grant constructor throws, with or without a guessed token', () => {
    expect(() => Reflect.construct(genuine.constructor, args)).toThrow(/issued by authorize/);
    expect(() => Reflect.construct(genuine.constructor, [Symbol('peblish.grant-issuance'), ...args])).toThrow(/issued by authorize/);
    expect(() => Reflect.construct(genuine.constructor, args, function Forged() {})).toThrow(/issued by authorize/);
  });

  test('a subclass cannot construct a grant', () => {
    // @ts-expect-error: the constructor is private, so subclassing does not compile either
    class Forged extends Authorized<'post.create'> {}
    expect(() => Reflect.construct(Forged, args)).toThrow(/issued by authorize/);
  });

  const lookAlikes: Record<string, () => unknown> = {
    'Object.create on the prototype': () => Object.assign(Object.create(Object.getPrototypeOf(genuine)), { ...genuine }),
    structuredClone: () => structuredClone(genuine),
    'a JSON round trip': () => JSON.parse(JSON.stringify(genuine)),
    'a spread copy': () => ({ ...genuine }),
  };
  for (const [name, forge] of Object.entries(lookAlikes)) {
    test(`${name} does not verify, and a mutation refuses it`, async () => {
      const forged = forge();
      expect(Authorized.verify(forged, 'post.create')).toBe(false);
      await expect(Reflect.apply(createPost, undefined, [forged, { title: 'Forged' }])).rejects.toThrow(/needs a grant from authorize/);
    });
  }

  test('a real grant for one action is refused by a mutation for another', async () => {
    const voteGrant = issueGrant('vote.cast', principal, { target: { kind: 'post', id: communityId } }, authority);
    expect(Authorized.verify(voteGrant, 'vote.cast')).toBe(true);
    expect(Authorized.verify(voteGrant, 'post.create')).toBe(false);
    const smuggled = voteGrant as unknown as Authorized<'post.create'>;
    await expect(createPost(smuggled, { title: 'Wrong action' })).rejects.toThrow(/needs a grant from authorize/);
  });
});
