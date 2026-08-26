import assert from "node:assert/strict";
import test from "node:test";
import { buildCaptainTerminalArgs, buildWindowsTerminalArgs, flattenPromptForWindowsArgument } from "./windows-terminal.js";

test("flattens multiline prompts before passing them to a native Windows command", () => {
  assert.equal(flattenPromptForWindowsArgument("first\r\n\r\nsecond\nthird"), "first second third");
  assert.equal(flattenPromptForWindowsArgument('run node "C:\\Users\\a b\\cli.js"'), 'run node \\"C:\\Users\\a b\\cli.js\\"');
});

test("embeds the complete worker prompt as one native command argument", () => {
  const args = buildWindowsTerminalArgs({
    title: "FLEET | fleet | abc12345",
    workingDirectory: "C:\\worktrees\\abc12345",
    taskTitle: "Implement a terminal adapter",
    agentId: "abc12345-0000-0000-0000-000000000000",
    taskId: "task-123",
    codexPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    fleetCliPath: "C:\\work\\fleet\\dist\\cli.js",
    databasePath: "C:\\Users\\example\\AppData\\Local\\Fleet\\fleet.db",
    model: "gpt-5.6-terra",
    prompt: "first line\n\nassigned task: update the worker",
  });

  const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
  const encodedPrompt = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encodedPrompt);
  assert.equal(Buffer.from(encodedPrompt, "base64").toString("utf8"), "first line assigned task: update the worker");
});

test("builds a named Windows Terminal tab for a worker", () => {
  const args = buildWindowsTerminalArgs({
    title: "FLEET | fleet | abc12345",
    workingDirectory: "C:\\worktrees\\abc12345",
    taskTitle: "Implement a terminal adapter",
    agentId: "abc12345-0000-0000-0000-000000000000",
    taskId: "task-123",
    codexPath: "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    fleetCliPath: "C:\\work\\fleet\\dist\\cli.js",
    databasePath: "C:\\Users\\example\\AppData\\Local\\Fleet\\fleet.db",
    model: "gpt-5.6-terra",
    prompt: "Work on the terminal adapter",
  });

  assert.deepEqual(args.slice(0, 5), ["-w", "fleet", "new-tab", "--title", "FLEET | fleet | abc12345"]);
  assert.ok(args.includes("--suppressApplicationTitle"));
  assert.ok(args.includes("C:\\worktrees\\abc12345"));
  assert.equal(args.at(-2), "-EncodedCommand");
  const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
  assert.ok(script.includes("agent status"));
  assert.ok(script.includes("gpt-5.6-terra"));
  assert.ok(script.includes("FromBase64String"));
  assert.ok(script.includes(' -C \'C:\\worktrees\\abc12345\' "$prompt"'));
  assert.ok(script.includes("worker-bridge"));
  assert.ok(script.includes("--started-at"));
  assert.ok(script.includes("agent complete"));
  assert.ok(script.includes("worker-cleanup"));
  assert.ok(script.includes("exit $exitCode"));
  assert.ok(!script.includes("State: waiting for the Codex CLI adapter"));
  assert.ok(!script.includes(";"));
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
  assert.equal(args[1], "fleet");
  assert.equal(args[args.length - 2], "-EncodedCommand");
  const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
  assert.ok(script.includes("codex.cmd"));
  assert.ok(script.includes("-s danger-full-access"));
  assert.ok(script.includes("-m 'gpt-5.6-luna'"));
  assert.ok(script.includes("-a never"));
  assert.ok(script.includes("FromBase64String"));
  assert.ok(script.includes(' -C \'C:\\work\\fleet\' "$prompt"'));
  assert.ok(script.includes("captain-bridge"));
  assert.ok(script.includes("--started-at"));
  assert.ok(!args.at(-1)?.includes("Welcome to Fleet"));
  assert.ok(!script.includes(";"));
  assert.ok(script.includes("exit $exitCode"));
});
