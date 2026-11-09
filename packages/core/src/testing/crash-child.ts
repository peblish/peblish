// Child process for the crash test (tx/tx.test.ts): opens the dedupe, apply, enqueue unit of
// work, applies the state change, then dies with SIGKILL before enqueueing.
// argv: authorId communityId postId activityId
import { writeSync } from 'node:fs';
import { authorize } from '../authz/authorize.ts';
import { tx } from '../tx/tx.ts';
import { postWithFault } from './fault-mutation.ts';
import { localUser } from './seed.ts';

const [authorId, communityId, postId, activityId] = process.argv.slice(2);
if (!authorId || !communityId || !postId || !activityId) throw new Error('usage: crash-child authorId communityId postId activityId');

const decision = await authorize('post.create', localUser(authorId), { communityId });
if (!decision.ok) throw new Error(decision.reason);
const mutation = postWithFault(async () => {
  // The insert has returned inside the open transaction; say so synchronously, then die.
  writeSync(1, 'applied\n');
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
});
await tx(async (t) => {
  await t.dedupe(activityId);
  await mutation.within(t, decision.grant, { id: postId });
});
