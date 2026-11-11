import { randomBytes } from 'node:crypto';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { resolveDirectoryQuery } from '../../packages/core/src/directory/input.ts';
import { listCommunities } from '../../packages/core/src/directory/read.ts';
import { auth } from '../../packages/core/src/identity/auth.ts';
import { seedAccount, seedInvite, seedTwoFactor } from '../../packages/core/src/testing/seed-a.ts';
import { seedBidiCommunityOnTop } from '../../packages/core/src/testing/seed-disc.ts';

// What the payload budget's pages need on the lane database (fixtures.ts runs this once per run):
// an admin with two-factor on for the signed-in pages, a multi-use invite for the sign-up and
// invite pages, a person with an unverified address whose verification mail is sent here, and a
// listed community whose name carries a right-to-left override at the head of /communities, so
// the font budget there always measures the mark its handle is drawn with.
// New accounts every run, so nothing collides with lane A's e2e admin (its TOTP steps are
// single-use per account) or with an earlier run.
const suffix = () => randomBytes(3).toString('hex');

try {
  const admin = await seedAccount(`pa_${suffix()}`, { role: 'admin' });
  const { secret } = await seedTwoFactor(admin.userId, 'peblish-payload-totp-secret-0123');
  const invite = await seedInvite(admin.actorId, { maxUses: 1000, label: 'payload budget' });
  const person = await seedAccount(`pu_${suffix()}`, { emailVerified: false });
  await (await auth()).api.sendVerificationEmail({ body: { email: person.email } });
  await seedBidiCommunityOnTop();
  // The head of /communities as a signed-out visitor gets it, by the page's own defaults and query.
  const [head] = (await listCommunities(resolveDirectoryQuery({}), null)).rows;
  if (!head) throw new Error('/communities lists no community after seedBidiCommunityOnTop');
  console.log(
    JSON.stringify({
      admin: { name: admin.name, password: admin.password, totpSecret: secret },
      inviteCode: invite.code,
      person: { email: person.email },
      bidiCommunity: head.actor.handle,
    }),
  );
} finally {
  await closePools();
}
