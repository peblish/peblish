// Type-level tests, checked by tsc (pnpm typecheck), never run. Each @ts-expect-error must
// be an error, or typecheck fails: an unauthorized write does not compile.
import type { Authorized } from '../authz/brand.ts';
import { createPost } from '../posts/create.ts';
import { defineMutation } from './mutation.ts';

declare const postGrant: Authorized<'post.create'>;
declare const voteGrant: Authorized<'vote.cast'>;
const input = { title: 'Hello' };

createPost(postGrant, input);

// @ts-expect-error: no grant at all
createPost(input);

// @ts-expect-error: a grant for another action
createPost(voteGrant, input);

const lookAlike = {
  action: 'post.create',
  actorId: 'x',
  principal: { kind: 'local', actorId: 'x', siteRole: 'user' },
  subject: { communityId: 'c' },
  authority: { kind: 'site-admin', actorId: 'x' },
} as const;

// @ts-expect-error: a look-alike object is not a grant (the brand is a private field)
createPost(lookAlike, input);

defineMutation({
  // @ts-expect-error: an action no policy registers
  action: 'post.obliterate',
  emits: ['post.created'],
  run: async () => {},
});

defineMutation({
  action: 'post.create',
  recheck: true,
  // @ts-expect-error: a mutation must emit at least one event
  emits: [],
  run: async () => {},
});

defineMutation({
  action: 'post.create',
  emits: ['post.created'],
  recheck: true,
  run: async (t) => {
    // @ts-expect-error: emitting an event the mutation did not declare
    await t.emit({ type: 'vote.cast', v: 1, voterId: 'x', target: { kind: 'post', id: 'y' }, value: 1, previous: 0, local: true });
  },
});

// @ts-expect-error: post.create can be revoked, so recheck: true is required
defineMutation({ action: 'post.create', emits: ['post.created'], run: async () => {} });

// @ts-expect-error: recheck must be true, not false, for a mod.* action
defineMutation({ action: 'mod.site_ban', emits: ['mod.ban'], recheck: false, run: async () => {} });
