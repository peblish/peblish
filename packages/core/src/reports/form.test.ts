import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { hideNsfw, showNsfw } from '../communities/gate.ts';
import { db } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedComment, seedModerationWorld, seedPost } from '../testing/seed-az.ts';
import { localUser } from '../testing/seed.ts';
import { readReportForm } from './form.ts';
import type { ReportTarget } from './types.ts';

beforeEach(truncateAll);

describe('the report form quotes only what the post page would show this viewer', () => {
  test('a post and a comment in an NSFW community, for an undeclared and a declared viewer', async () => {
    const w = await seedModerationWorld();
    const community = w.communities.local.live;
    await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, community.id));
    const post = await seedPost(w.instances.local, community, w.people.author, { title: 'Plain title' });
    const comment = await seedComment(w.instances.local, post, w.people.author, { bodyMd: 'Plain words' });
    const quote = async (target: ReportTarget, nsfw = hideNsfw) => {
      const form = await readReportForm(localUser(w.people.user.id), target, db(), nsfw);
      if (!form.ok) throw new Error(form.reason);
      return form.quote;
    };
    const onPost: ReportTarget = { kind: 'post', id: post.id };
    const onComment: ReportTarget = { kind: 'comment', id: comment.id };
    // undeclared: the age gate, whatever the browser chose
    expect(await quote(onPost, showNsfw)).toBeNull();
    expect(await quote(onComment, showNsfw)).toBeNull();
    await writer().insert(ageDeclarations).values({ actorId: w.people.user.id });
    // declared with Hide NSFW on: still withheld
    expect(await quote(onPost)).toBeNull();
    expect(await quote(onComment)).toBeNull();
    // declared and showing NSFW: quoted
    expect(await quote(onPost, showNsfw)).toBe('Plain title');
    expect(await quote(onComment, showNsfw)).toBe('Plain words');
    // the NSFL flag gates the same way
    await writer().update(actors).set({ sensitive: false, nsfl: true }).where(eq(actors.id, community.id));
    expect(await quote(onPost)).toBeNull();
  });
});
