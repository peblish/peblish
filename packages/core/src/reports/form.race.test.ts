import { eq } from 'drizzle-orm';
import { beforeEach, expect, test, vi } from 'vitest';
import { comments } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedModerationWorld, seedPost } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';

// The policy allowed the report a moment before the comment was deleted: authorize stands in
// for that moment (it answers as it did then); everything after it reads the database as it is.
vi.mock('../authz/authorize.ts', () => ({ authorize: async () => ({ ok: true }) }));
const { readReportForm } = await import('./form.ts');

beforeEach(truncateAll);

test('a comment deleted between the policy and the read is neither quoted nor named', async () => {
  const w = await seedModerationWorld();
  const post = await seedPost(w.instances.local, w.communities.local.live, w.people.author, { title: 'Plain title' });
  const comment = await seedComment(w.instances.local, post, w.people.author, { bodyMd: 'Retained words' });
  await writer().update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment.id));
  const form = await readReportForm(localUser(w.people.user.id), { kind: 'comment', id: comment.id });
  expect(form.ok && [form.quote, form.about.handle]).toEqual([null, null]);
});
