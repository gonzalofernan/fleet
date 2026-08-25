import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsTerminalArgs } from "./windows-terminal.js";

test("builds a named Windows Terminal tab for a worker", () => {
  const args = buildWindowsTerminalArgs({
    title: "FLEET | fleet | abc12345",
    workingDirectory: "C:\\worktrees\\abc12345",
    taskTitle: "Implement a terminal adapter",
    agentId: "abc12345-0000-0000-0000-000000000000",
  });

  assert.deepEqual(args.slice(0, 5), ["-w", "fleet", "new-tab", "--title", "FLEET | fleet | abc12345"]);
  assert.ok(args.includes("--suppressApplicationTitle"));
  assert.ok(args.includes("C:\\worktrees\\abc12345"));
});
