import { beforeEach, describe, expect, test } from 'vitest';
import { truncateAll } from '@peblish/core/testing/db';
import { stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, seedLabWorld } from '@peblish/core/testing/seed-fed-b';
import { shapeOf } from '../test/corpus.ts';
import { readFixture, readManifest } from '../test/manifest.ts';
import { processRow } from './pipeline.ts';
import { resetKeyFetchBudget } from './throttle.ts';
import { useCommentDouble } from './test-support.ts';

// Every activity Lemmy 0.19.21 and PieFed 1.8.11 sent in the Phase 0 captures (the manifest's
// inbound and peer-log entries, in the order they were captured), run through the pipeline in
// a world built from the same captures (lab-live, with the spike's instance as ours). Each is
// applied or skipped with a recorded reason; none fails, none is left pending. The test prints
// the table the lane notes quote when CORPUS_REPORT=1.

const sequence = (id: string) => Number(/-(\d{4})-/.exec(id)?.[1] ?? 0);

beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  useCommentDouble();
});

describe('the captured inbound corpus', () => {
  const entries = readManifest()
    .entries.filter((entry) => (entry.direction === 'inbound' || entry.direction === 'peer-log') && entry.software.name !== 'feddit-spike')
    .sort((a, b) => a.software.name.localeCompare(b.software.name) || sequence(a.id) - sequence(b.id));

  test('every received activity is applied or skipped with a reason', async () => {
    await seedLabWorld();
    const { fetch } = stubFetch({});
    const tally = new Map<string, { applied: number; skipped: Map<string, number>; failed: number }>();
    const problems: string[] = [];
    for (const entry of entries) {
      const json = readFixture(entry.fixture);
      if (typeof json !== 'object' || json === null) continue;
      const { stored } = await deliverRow(json as Record<string, unknown>, (row) => processRow(row, { fetch }));
      const key = `${entry.software.name} ${shapeOf(json)}`;
      const line = tally.get(key) ?? { applied: 0, skipped: new Map(), failed: 0 };
      tally.set(key, line);
      if (stored?.state === 'applied') line.applied += 1;
      else if (stored?.state === 'skipped' && stored.error) {
        const reason = stored.error.split(' ')[0]!;
        line.skipped.set(reason, (line.skipped.get(reason) ?? 0) + 1);
      } else {
        line.failed += 1;
        problems.push(`${entry.id}: ${stored?.state} ${stored?.error}`);
      }
    }
    if (process.env.CORPUS_REPORT === '1') {
      for (const [key, line] of [...tally].sort()) {
        console.log(`${key}\tapplied ${line.applied}\t${[...line.skipped].map(([reason, count]) => `${reason} x${count}`).join(', ')}`);
      }
    }
    expect(problems).toEqual([]);
    expect(entries.length).toBeGreaterThan(100 - 5);
  }, 60_000);
});
