import assert from "node:assert/strict";
import test from "node:test";
import { buildCaptainTerminalArgs, buildWindowsTerminalArgs } from "./windows-terminal.js";

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

test("builds an interactive Codex captain terminal", () => {
  const args = buildCaptainTerminalArgs({
    codexPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    fleetCliPath: "C:\\work\\fleet\\dist\\cli.js",
    databasePath: "C:\\Users\\example\\AppData\\Local\\Fleet\\fleet.db",
    workingDirectory: "C:\\work\\fleet",
    model: "gpt-5.6-luna",
    prompt: "Welcome to Fleet",
  });

  assert.equal(args[4], "FLEET | Captain");
  assert.equal(args[1], "new");
  assert.ok(args.at(-1)?.includes("codex.cmd"));
  assert.ok(args.at(-1)?.includes("-s danger-full-access"));
  assert.ok(args.at(-1)?.includes("-m 'gpt-5.6-luna'"));
  assert.ok(args.at(-1)?.includes("-a never"));
  assert.ok(args.at(-1)?.includes("Welcome to Fleet"));
});
