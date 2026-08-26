import assert from "node:assert/strict";
import test from "node:test";
import { assertProfileSupportsTask, getExecutionProfile } from "./execution-profiles.js";

test("keeps workers out of danger-full-access by default", () => {
  assert.equal(getExecutionProfile("captain").sandbox, "danger-full-access");
  for (const id of ["worker-coding", "worker-review", "worker-research", "worker-browser", "worker-writing", "worker-operations"]) {
    assert.notEqual(getExecutionProfile(id).sandbox, "danger-full-access");
  }
  assert.equal(assertProfileSupportsTask("worker-research", "research").sandbox, "read-only");
  assert.throws(() => assertProfileSupportsTask("worker-research", "coding"), /does not support coding/);
});
