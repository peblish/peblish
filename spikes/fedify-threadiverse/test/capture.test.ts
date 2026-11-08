// Capture records are bounded in size, and a stream file stops growing at its cap.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const captureDir = mkdtempSync(join(tmpdir(), "peblish-capture-test-"));
process.env.CAPTURE_DIR = captureDir;
const { capture, MAX_BODY_BYTES, MAX_STREAM_BYTES, parseMaybeJson } = await import("../src/capture.ts");

after(() => rmSync(captureDir, { recursive: true, force: true }));

test("a body over the limit is truncated, not parsed", () => {
  const big = JSON.stringify({ text: "y".repeat(MAX_BODY_BYTES) });
  const kept = parseMaybeJson(big);
  assert.equal(typeof kept, "string");
  assert.ok((kept as string).length < 5000);
  assert.deepEqual(parseMaybeJson('{"a":1}'), { a: 1 });
});

test("a stream file at its cap stops growing", () => {
  const file = join(captureDir, "rejected.jsonl");
  writeFileSync(file, "");
  truncateSync(file, MAX_STREAM_BYTES + 1); // sparse, costs no disk
  capture("rejected", { outcome: "after the cap" });
  assert.equal(statSync(file).size, MAX_STREAM_BYTES + 1);

  capture("inbound", { path: "/inbox" });
  assert.ok(statSync(join(captureDir, "inbound.jsonl")).size > 0, "other streams are unaffected");
});
