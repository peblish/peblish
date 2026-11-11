import { closePools } from '../../packages/core/src/db/pools.ts';
import { PASSWORD, seedAccount, seedTwoFactor } from '../../packages/core/src/testing/seed-a.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';
import { seedFollow } from '../../packages/core/src/testing/seed-c1.ts';

// Two signed-in-capable people for the shell specs that change who a browser is signed in as, on
// the lane database (DATABASE_URL from scripts/lane.sh). `node e2e/shell/seed.ts` prints them as
// JSON; every run uses fresh names, so the lane database can keep earlier runs. With `admin`, it
// also prints a fresh admin with two-factor on (`admin.name`, `admin.totpSecret`), the spec's own,
// so no other spec resets its secret mid-run. With `remote`, the first person also follows a
// remote community whose name starts with a right-to-left override
// (`remote`, its name). Escapes only: this file holds no control character.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [first, second] = await Promise.all([seedAccount(`shella_${suffix}`), seedAccount(`shellb_${suffix}`)]);
  let admin: { name: string; totpSecret: string } | undefined;
  if (process.argv[2] === 'admin') {
    const account = await seedAccount(`shelladmin_${suffix}`, { role: 'admin' });
    const { secret } = await seedTwoFactor(account.userId, `peblish-shell-admin-totp-${suffix}`);
    admin = { name: account.name, totpSecret: secret };
  }
  let remote: string | undefined;
  if (process.argv[2] === 'remote') {
    const far = await seedInstance(`bidi-${suffix}.example`, false);
    const community = await seedActor(far, 'Group', `\u202Eshell_${suffix}`, { displayName: `\u202E\u2066Shell ${suffix}` });
    await seedFollow({ id: first.actorId }, community);
    remote = community.name;
  }
  console.log(
    JSON.stringify({ password: PASSWORD, people: [first.name, second.name], ...(admin && { admin }), ...(remote && { remote }) }),
  );
} finally {
  await closePools();
}
