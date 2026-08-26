import assert from "node:assert/strict";
import test from "node:test";
import { selectMergedPullRequest } from "./github-pull-request.js";

test("accepts only a merged PR whose head is the exact registered branch", () => {
  const pullRequest = selectMergedPullRequest([
    { number: 8, url: "https://example.test/pr/8", headRefName: "fleet/agent-other", baseRefName: "main", mergedAt: "2026-08-25T10:00:00Z" },
    { number: 9, url: "https://example.test/pr/9", headRefName: "fleet/agent-123", baseRefName: "main", mergedAt: null },
    { number: 10, url: "https://example.test/pr/10", headRefName: "fleet/agent-123", baseRefName: "main", mergedAt: "2026-08-25T11:00:00Z" },
  ], "fleet/agent-123");

  assert.deepEqual(pullRequest, {
    number: 10, url: "https://example.test/pr/10", headRefName: "fleet/agent-123", baseRefName: "main", mergedAt: "2026-08-25T11:00:00Z",
  });
});
