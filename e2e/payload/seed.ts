import { randomBytes } from 'node:crypto';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { auth } from '../../packages/core/src/identity/auth.ts';
import { seedAccount, seedInvite, seedTwoFactor } from '../../packages/core/src/testing/seed-a.ts';

// What the payload budget's pages need on the lane database (fixtures.ts runs this once per run):
// an admin with two-factor on for the signed-in pages, a multi-use invite for the sign-up and
// invite pages, and a person with an unverified address whose verification mail is sent here.
// New accounts every run, so nothing collides with lane A's e2e admin (its TOTP steps are
// single-use per account) or with an earlier run.
const suffix = () => randomBytes(3).toString('hex');

try {
  const admin = await seedAccount(`pa_${suffix()}`, { role: 'admin' });
  const { secret } = await seedTwoFactor(admin.userId, 'peblish-payload-totp-secret-0123');
  const invite = await seedInvite(admin.actorId, { maxUses: 1000, label: 'payload budget' });
  const person = await seedAccount(`pu_${suffix()}`, { emailVerified: false });
  await (await auth()).api.sendVerificationEmail({ body: { email: person.email } });
  console.log(
    JSON.stringify({
      admin: { name: admin.name, password: admin.password, totpSecret: secret },
      inviteCode: invite.code,
      person: { email: person.email },
    }),
  );
} finally {
  await closePools();
}
