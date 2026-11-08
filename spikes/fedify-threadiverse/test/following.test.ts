// Accept and Reject change only the follow they answer. Needs a throwaway
// Postgres: TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;
const captureDir = mkdtempSync(join(tmpdir(), "peblish-following-test-"));
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.CAPTURE_DIR = captureDir;
}

test("Accept and Reject need the pending follow's id and community", { skip: databaseUrl ? false : "TEST_DATABASE_URL is not set" }, async () => {
  const { migrate, sql } = await import("../src/db.ts");
  const { acceptFollow, rejectFollow } = await import("../src/inbox.ts");
  try {
    await migrate();
    await sql`delete from following`;
    const community = "https://remote.test/c/news";
    const rows = async () =>
      (await sql<{ follow_id: string; accepted: boolean }[]>`select follow_id, accepted from following`).map((row) => ({ ...row }));
    const follow = async (followId: string) =>
      await sql`insert into following (local_identifier, remote_uri, follow_id) values ('u.t1', ${community}, ${followId})`;

    await follow("follow-1");
    assert.equal(await acceptFollow("follow-1", "https://elsewhere.test/c/news"), false, "wrong community");
    assert.equal(await acceptFollow("follow-2", community), false, "wrong Follow id");
    assert.deepEqual(await rows(), [{ follow_id: "follow-1", accepted: false }]);
    assert.equal(await acceptFollow("follow-1", community), true);
    assert.deepEqual(await rows(), [{ follow_id: "follow-1", accepted: true }]);
    assert.equal(await acceptFollow("follow-1", community), false, "a repeated Accept changes nothing");

    // We unfollowed; a late Accept must not bring the row back.
    await sql`delete from following`;
    assert.equal(await acceptFollow("follow-1", community), false);
    assert.deepEqual(await rows(), []);

    await follow("follow-3");
    assert.equal(await rejectFollow("follow-3", "https://elsewhere.test/c/news"), false, "wrong community");
    assert.equal((await rows()).length, 1);
    assert.equal(await rejectFollow("follow-3", community), true);
    assert.deepEqual(await rows(), []);
  } finally {
    await sql.end();
    rmSync(captureDir, { recursive: true, force: true });
  }
});
