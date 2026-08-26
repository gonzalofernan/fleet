import assert from "node:assert/strict";
import test from "node:test";
import { ensurePullRequest, validateWorktreeReadyForCompletion } from "./completion.js";

test("rejects completion when the worktree is not clean", () => {
  assert.throws(
    () => validateWorktreeReadyForCompletion("C:\\worktree", "fleet/agent-test", (_path, args) => args[0] === "status" ? " M src/app.ts" : "fleet/agent-test"),
    /uncommitted or untracked changes/,
  );
});

test("rejects completion when the local commit has not been pushed", () => {
  assert.throws(
    () => validateWorktreeReadyForCompletion("C:\\worktree", "fleet/agent-test", (_path, args) => {
      if (args[0] === "branch") return "fleet/agent-test";
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "local-commit";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/fleet/agent-test";
      return "remote-commit";
    }),
    /is not pushed/,
  );
});

test("accepts a clean worktree whose HEAD matches its upstream", () => {
  const proof = validateWorktreeReadyForCompletion("C:\\worktree", "fleet/agent-test", (_path, args) => {
    if (args[0] === "branch") return "fleet/agent-test";
    if (args[0] === "status") return "";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "pushed-commit";
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/fleet/agent-test";
    return "pushed-commit";
  }, () => "https://github.com/example/fleet/pull/1");
  assert.deepEqual(proof, { commit: "pushed-commit", upstream: "origin/fleet/agent-test", pullRequestUrl: "https://github.com/example/fleet/pull/1" });
});

test("rejects completion when the branch has no pull request", () => {
  assert.throws(
    () => validateWorktreeReadyForCompletion("C:\\worktree", "fleet/agent-test", (_path, args) => {
      if (args[0] === "branch") return "fleet/agent-test";
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "pushed-commit";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "origin/fleet/agent-test";
      return "pushed-commit";
    }, () => ""),
    /No pull request exists/,
  );
});

test("creates a pull request when the pushed branch has none", () => {
  const calls: string[][] = [];
  const url = ensurePullRequest("C:\\worktree", "fleet/agent-test", (_path, args) => {
    calls.push(args);
    if (args[1] === "view") throw new Error("no pull request");
    return "https://github.com/example/fleet/pull/2";
  });
  assert.equal(url, "https://github.com/example/fleet/pull/2");
  assert.deepEqual(calls, [
    ["pr", "view", "--json", "url", "--jq", ".url"],
    ["pr", "create", "--fill", "--head", "fleet/agent-test"],
  ]);
});
