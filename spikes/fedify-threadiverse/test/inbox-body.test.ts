// The inbox paths read and capture a bounded body; nothing else is read or
// captured before authentication. The app is called in process: no server, no
// database (every request here is answered before Fedify or Postgres is used).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const captureDir = mkdtempSync(join(tmpdir(), "peblish-inbox-test-"));
process.env.CAPTURE_DIR = captureDir;
process.env.FEDDIT_CONTROL_TOKEN = "test-token";
process.env.FEDDIT_ORIGIN = "https://lab.example.test";
const { MAX_BODY_BYTES } = await import("../src/capture.ts");
const { app } = await import("../src/routes.ts");
const { sql } = await import("../src/db.ts");

after(async () => {
  await sql.end();
  rmSync(captureDir, { recursive: true, force: true });
});

const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(`https://lab.example.test${path}`, { method: "POST", body, headers });

/** A body of `chunks` 64 KiB pieces with no Content-Length, as a chunked upload arrives. */
const chunked = (chunks: number) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks-- > 0) controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      else controller.close();
    },
  });

test("a body over the limit is refused with 413 before Fedify sees it", async () => {
  const big = "x".repeat(MAX_BODY_BYTES + 1);
  assert.equal((await post("/inbox", big)).status, 413);
  assert.equal((await post("/ap/u.alice/inbox", big)).status, 413);
});

test("a chunked body over the limit is refused too", async () => {
  const response = await app.request("https://lab.example.test/inbox", {
    method: "POST",
    body: chunked(10), // 640 KiB
    // @ts-expect-error `duplex` is required for a stream body and missing from the DOM typings
    duplex: "half",
  });
  assert.equal(response.status, 413);
});

test("a path that only ends in /inbox is neither read nor captured", async () => {
  const response = await post("/spike/x/inbox", '{"type":"Create"}', { "content-type": "application/json" });
  assert.equal(response.status, 401);
  assert.equal(existsSync(join(captureDir, "inbound.jsonl")), false);
});
