import assert from "node:assert/strict";
import test from "node:test";
import { buildCaptainTerminalArgs, buildWindowsTerminalArgs, flattenPromptForWindowsArgument } from "./windows-terminal.js";

const request = {
  runtimeId: "runtime-123",
  title: "FLEET | fleet | abc12345",
  workingDirectory: "C:\\worktrees\\abc12345",
  fleetCliPath: "C:\\work\\fleet\\dist\\cli.js",
  databasePath: "C:\\Users\\example\\AppData\\Local\\Fleet\\fleet.db",
};

test("flattens messages passed to a native provider command", () => {
  assert.equal(flattenPromptForWindowsArgument("first\r\n\r\nsecond\nthird"), "first second third");
  assert.equal(flattenPromptForWindowsArgument('run node "C:\\Users\\a b\\cli.js"'), 'run node \\"C:\\Users\\a b\\cli.js\\"');
});

test("opens one worker tab that runs only the unified supervisor", () => {
  const args = buildWindowsTerminalArgs(request);
  assert.deepEqual(args.slice(0, 5), ["-w", "fleet", "new-tab", "--title", request.title]);
  const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
  assert.match(script, /runtime run --id 'runtime-123'/);
  assert.match(script, /--database-path/);
  assert.doesNotMatch(script, /codex\.cmd|captain-bridge|worker-bridge/);
});

test("opens the captain in the same named Windows Terminal window", () => {
  const args = buildCaptainTerminalArgs({
    runtimeId: request.runtimeId,
    workingDirectory: "C:\\work\\fleet",
    fleetCliPath: request.fleetCliPath,
    databasePath: request.databasePath,
  });
  assert.equal(args[1], "fleet");
  assert.equal(args[4], "FLEET | Captain");
  const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
  assert.match(script, /runtime run/);
  assert.doesNotMatch(script, /danger-full-access|captain-host|captain-bridge/);
});
