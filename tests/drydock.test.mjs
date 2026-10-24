import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDrydockReport,
  DRYDOCK_SCHEMA,
} from "../src/check/drydock.mjs";
const report = {
  schema: DRYDOCK_SCHEMA,
  candidate_sha256: "a".repeat(64),
  file: "a.ts",
  source_snapshot_sha256: "b".repeat(64),
  catalog_sha256: "c".repeat(64),
  engine_version: "1",
  runtime_verified: false,
  status: "unknown",
  findings: [{ status: "unknown" }],
  limitations: ["single_file_only"],
};
test("unknown and limitations survive evidence import", () => {
  assert.deepEqual(
    validateDrydockReport(report, "a".repeat(64), "a.ts"),
    report,
  );
});
test("changed bytes, paths, success claims and missing provenance are rejected", () => {
  assert.throws(() => validateDrydockReport(report, "d".repeat(64), "a.ts"));
  assert.throws(() => validateDrydockReport(report, "a".repeat(64), "b.ts"));
  for (const change of [
    { status: "passed" },
    { runtime_verified: true },
    { catalog_sha256: "" },
    { limitations: [] },
  ])
    assert.throws(() =>
      validateDrydockReport({ ...report, ...change }, "a".repeat(64), "a.ts"),
    );
});
