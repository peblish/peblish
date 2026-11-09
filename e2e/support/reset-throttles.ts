import { closePools } from '../../packages/core/src/db/pools.ts';
import { writer } from '../../packages/core/src/db/write.ts';
import { throttles } from '../../packages/core/src/identity/tables.ts';

// Empties the lane database's throttle counters (DATABASE_URL from scripts/lane.sh); run by
// e2e/global-setup.ts.
try {
  await writer().delete(throttles);
} finally {
  await closePools();
}
