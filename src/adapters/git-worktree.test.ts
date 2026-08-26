import assert from "node:assert/strict";
import test from "node:test";
import { assertFleetWorktreePath, parseWorktreeList } from "./git-worktree.js";

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

test("accepts configured and legacy Fleet roots but rejects unrelated paths", () => {
  const project = "C:\\Fleet\\projects\\demo";
  assert.doesNotThrow(() => assertFleetWorktreePath(project, "C:\\Fleet\\worktrees\\demo\\agent-1", "C:\\Fleet\\worktrees"));
  assert.doesNotThrow(() => assertFleetWorktreePath(project, "C:\\Fleet\\projects\\.fleet-worktrees\\demo\\agent-1", "C:\\Fleet\\worktrees"));
  assert.throws(() => assertFleetWorktreePath(project, "C:\\Users\\person\\Documents", "C:\\Fleet\\worktrees"), /outside Fleet roots/);
});
