import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { PASSWORD, seedAccount, seedTwoFactor } from '../../packages/core/src/testing/seed-a.ts';
import { seedModerator, seedPost } from '../../packages/core/src/testing/seed-az.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// The profile review cases, on the lane database (DATABASE_URL from scripts/lane.sh):
// `node e2e/profiles/seed.ts` prints the cast as JSON, on fresh names every run.
// - `long`: a remote person with a long name, on a long host, a long display name and no activity;
// - `prolific`: a local person with more posts than one page holds;
// - `visitor`, `moderator` (of the community `prolific` posts in) and `admin` (two-factor on), who
//   open `prolific`'s profile.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const host = new URL((await localInstance(db())).origin).host;
  const local = { ...(await localInstance(db())), domain: host, local: true };
  const far = await seedInstance(`a-very-long-subdomain-${suffix}.some-instance.example`, false);
  const long = await seedActor(far, 'Person', `a_very_long_account_name_${suffix}`, {
    displayName: 'Maximiliane Konstantinopolitanische-Donaudampfschifffahrtsgesellschaft',
    fetchedAt: new Date(Date.now() - 3_600_000),
  });
  const [prolific, visitor, moderator, admin] = await Promise.all(
    ['prolific', 'visitor', 'moderator', 'admin'].map((role) =>
      seedAccount(`e2p${role}_${suffix}`, role === 'admin' ? { role: 'admin' } : {}),
    ),
  );
  const totpSecret = `e2-profile-totp-secret-${suffix}`.padEnd(32, '0');
  await seedTwoFactor(admin!.userId, totpSecret);
  const community = await seedActor(local, 'Group', `e2pc_${suffix}`);
  await seedModerator(community, { id: moderator!.actorId });
  const posts: string[] = [];
  // Newest first: one more than a page (20) and a few, so the second page is short.
  for (let n = 0; n < 23; n++) {
    const title = `Prolific post ${String(n).padStart(2, '0')} ${suffix}`;
    await seedPost(local, community, { id: prolific!.actorId }, { title, bodyMd: title, publishedAt: new Date(Date.now() - n * 60_000) });
    posts.push(title);
  }
  console.log(
    JSON.stringify({
      suffix,
      password: PASSWORD,
      long: { handle: `${long.name}@${far.domain}`, name: long.name, host: far.domain, displayName: long.displayName },
      prolific: { name: prolific!.name, posts },
      visitor: { name: visitor!.name },
      moderator: { name: moderator!.name },
      admin: { name: admin!.name, email: admin!.email, password: PASSWORD, totpSecret, backupCodes: [] },
      community: { handle: `${community.name}@${host}`, name: community.name },
    }),
  );
} finally {
  await closePools();
}
