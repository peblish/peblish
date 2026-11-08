import { describe, expect, it } from 'vitest';
import { archiveFailures, runArchive } from './archive.ts';

// The archive of feddit.com never leaves the maintainer's machine, so CI has no
// FEDDIT_ARCHIVE_DB_URL and skips this. Locally: restore piefed-db.dump into its own
// database (the steps are in lane FIT's wave 1 notes) and point the variable at it.
const url = process.env.FEDDIT_ARCHIVE_DB_URL;

describe.skipIf(!url)('archive subset', () => {
  it('round-trips with no difference the vocabulary does not document', { timeout: 120_000 }, async () => {
    const report = await runArchive(url ?? '');
    expect(report.documents).toBeGreaterThan(130);
    expect(archiveFailures(report)).toEqual([]);
  });
});

it('fails the archive run on an unmappable document or an undocumented difference', () => {
  expect(archiveFailures({ unmappable: [], undocumented: [] })).toEqual([]);
  expect(archiveFailures({ unmappable: ['post https://x.test/p/1: Page: name must be a string'], undocumented: [] })).toEqual([
    'unmappable post https://x.test/p/1: Page: name must be a string',
  ]);
  expect(archiveFailures({ unmappable: [], undocumented: ['comment piefed https://x.test/c/1: dropped tag'] })).toEqual([
    'undocumented comment piefed https://x.test/c/1: dropped tag',
  ]);
});
