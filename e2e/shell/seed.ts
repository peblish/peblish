import { closePools } from '../../packages/core/src/db/pools.ts';
import { PASSWORD, seedAccount, seedTwoFactor } from '../../packages/core/src/testing/seed-a.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';
import { seedFollow } from '../../packages/core/src/testing/seed-c1.ts';
import { seedNotice } from '../../packages/core/src/testing/seed-e2.ts';

// Two signed-in-capable people for the shell specs that change who a browser is signed in as, on
// the lane database (DATABASE_URL from scripts/lane.sh). `node e2e/shell/seed.ts` prints them as
// JSON; every run uses fresh names, so the lane database can keep earlier runs. With `admin`, it
// also prints a fresh admin with two-factor on (`admin.name`, `admin.totpSecret`), the spec's own,
// so no other spec resets its secret mid-run. With `remote`, the first person also follows a
// remote community whose name starts with a right-to-left override
// (`remote`, its name). With `unread`, the first person has two unread mentions. With `initials`, the
// first person follows two remote communities whose display names begin where runtimes disagree on the
// initial: a Hangul syllable sent as its three letters, and a letter with U+0897 (`initials`, their names).
// Escapes only: this file holds no control character.
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
  let initials: { hangul: string; pepet: string } | undefined;
  if (process.argv[2] === 'initials') {
    const far = await seedInstance(`initials-${suffix}.example`, false);
    const hangul = await seedActor(far, 'Group', `hangul_${suffix}`, { displayName: `\u1100\u1161\u11A8 Hangul ${suffix}` });
    const pepet = await seedActor(far, 'Group', `pepet_${suffix}`, { displayName: `a\u0897 Pepet ${suffix}` });
    await seedFollow({ id: first.actorId }, hangul);
    await seedFollow({ id: first.actorId }, pepet);
    initials = { hangul: `hangul_${suffix}`, pepet: `pepet_${suffix}` };
  }
  if (process.argv[2] === 'unread') {
    for (let i = 0; i < 2; i++) await seedNotice({ recipientId: first.actorId, kind: 'mention', refId: crypto.randomUUID() });
  }
  console.log(
    JSON.stringify({
      password: PASSWORD,
      people: [first.name, second.name],
      ...(admin && { admin }),
      ...(remote && { remote }),
      ...(initials && { initials }),
    }),
  );
} finally {
  await closePools();
}
