import { describe, expect, it } from 'vitest';
import { runArchive } from './archive.ts';

// The archive of feddit.com never leaves the maintainer's machine, so CI has no
// FEDDIT_ARCHIVE_DB_URL and skips this. Locally: restore piefed-db.dump into its own
// database (LANE-NOTES.md) and point the variable at it.
const url = process.env.FEDDIT_ARCHIVE_DB_URL;

describe.skipIf(!url)('archive subset', () => {
  it('round-trips with no difference the vocabulary does not document', { timeout: 120_000 }, async () => {
    const report = await runArchive(url ?? '');
    expect(report.documents).toBeGreaterThan(130);
    expect(report.unmappable).toEqual([]);
    expect(report.undocumented).toEqual([]);
  });
});
