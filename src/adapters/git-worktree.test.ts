import assert from "node:assert/strict";
import test from "node:test";
import { parseWorktreeList } from "./git-worktree.js";

test("parses agent worktrees from Git porcelain output", () => {
  const worktrees = parseWorktreeList([
    "worktree C:/code/fleet",
    "HEAD abcdef",
    "branch refs/heads/main",
    "",
    "worktree C:/code/.fleet-worktrees/fleet/12345678",
    "HEAD abcdef",
    "branch refs/heads/fleet/agent-12345678",
  ].join("\n"));

  assert.deepEqual(worktrees[1], {
    path: "C:/code/.fleet-worktrees/fleet/12345678",
    branch: "fleet/agent-12345678",
  });
});
