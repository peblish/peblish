import { closePools } from '../../packages/core/src/db/pools.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';

// Two signed-in-capable people for the shell specs that change who a browser is signed in as, on
// the lane database (DATABASE_URL from scripts/lane.sh). `node e2e/shell/seed.ts` prints them as
// JSON; every run uses fresh names, so the lane database can keep earlier runs.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [first, second] = await Promise.all([seedAccount(`shella_${suffix}`), seedAccount(`shellb_${suffix}`)]);
  console.log(JSON.stringify({ password: PASSWORD, people: [first.name, second.name] }));
} finally {
  await closePools();
}
