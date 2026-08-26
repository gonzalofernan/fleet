import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProcessRuntime } from "./domain.js";
import type { ExecutionProfile } from "./execution-profiles.js";
import type { ManagedProcess, ProcessLauncher } from "./process-controller.js";
import type { AgentProviderAdapter, ProviderCommand, ProviderSessionLookup } from "./providers/provider.js";
import { ProviderRegistry } from "./providers/provider.js";
import { settingsForWorkspace } from "./settings.js";
import { FleetStore } from "./storage.js";
import { runSupervisedRuntime } from "./supervisor.js";

class FakeProvider implements AgentProviderAdapter {
  readonly id = "fake";
  readonly messages: string[] = [];
  buildCommand(_runtime: ProcessRuntime, _profile: ExecutionProfile): ProviderCommand {
    return { executable: process.execPath, args: ["-e", "process.exit(0)"] };
  }
  findSession(_options: ProviderSessionLookup): string | null { return "fake-session"; }
  sendMessage(_sessionId: string, message: string): boolean { this.messages.push(message); return true; }
  cleanupSessions(_options: ProviderSessionLookup): string[] { return ["fake-session"]; }
}

class ImmediateProcessLauncher implements ProcessLauncher {
  launch(_command: ProviderCommand, _workingDirectory: string): ManagedProcess {
    return { pid: 4242, wait: async () => ({ exitCode: 0, signal: null }), terminate: () => undefined };
  }
}

test("supervises a report worker through attempt, runtime, session, and completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-supervisor-"));
  const path = join(root, "fleet.db");
  const store = new FleetStore(path);
  const project = store.addProject("research", root);
  const task = store.createTask(project.id, "Research options", { kind: "research", deliveryMode: "report-only", executionProfile: "worker-research" });
  const requested = store.requestAgent(task.id, "researcher", "fake", "test-model", "worker-research");
  const agent = store.provisionAgent(requested.id, { branch: "fleet/agent-research", worktreePath: root, terminalTitle: "worker" });
  const attempt = store.createTaskAttempt(agent.id);
  const runtime = store.createRuntime({
    kind: "worker", ownerId: agent.id, attemptId: attempt.id, workspaceKey: root, provider: "fake", model: "test-model",
    executionProfile: "worker-research", workingDirectory: root,
    launchConfig: { prompt: task.title, fleetCliPath: "cli.js", databasePath: path },
  });
  store.close();

  const provider = new FakeProvider();
  const result = await runSupervisedRuntime(
    { runtimeId: runtime.id, databasePath: path, settings: settingsForWorkspace(join(root, "workspace")) },
    { providers: new ProviderRegistry([provider]), processes: new ImmediateProcessLauncher() },
  );
  assert.equal(result, 0);

  const verified = new FleetStore(path);
  assert.equal(verified.getAgent(agent.id).status, "completed");
  assert.equal(verified.getTask(task.id).status, "completed");
  assert.equal(verified.getAttempt(attempt.id).status, "succeeded");
  assert.equal(verified.getRuntime(runtime.id).status, "stopped");
  assert.equal(verified.getRuntime(runtime.id).sessionId, "fake-session");
  verified.close();
});

test("delivers a captain outbox message through the supervised provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-supervisor-"));
  const path = join(root, "fleet.db");
  const store = new FleetStore(path);
  const message = store.sendMessage({ type: "info", text: "Worker milestone" });
  const runtime = store.createRuntime({
    kind: "captain", workspaceKey: root, provider: "fake", model: "test-model", executionProfile: "captain",
    workingDirectory: root, launchConfig: { prompt: "Captain", fleetCliPath: "cli.js", databasePath: path },
  });
  store.close();
  const provider = new FakeProvider();
  await runSupervisedRuntime(
    { runtimeId: runtime.id, databasePath: path, settings: { ...settingsForWorkspace(join(root, "workspace")), pullRequestPollMs: 60_000, loopPollMs: 60_000 } },
    { providers: new ProviderRegistry([provider]), processes: new ImmediateProcessLauncher() },
  );
  const verified = new FleetStore(path);
  assert.equal(verified.listMessages().find((entry) => entry.id === message.id)?.status, "delivered");
  assert.equal(provider.messages.length, 1);
  assert.match(provider.messages[0]!, /Worker milestone/);
  verified.close();
});

test("runs a controlled real child process on Windows when explicitly enabled", {
  skip: process.platform !== "win32" || process.env.FLEET_RUN_WINDOWS_E2E !== "1",
}, async () => {
  const { LocalProcessLauncher } = await import("./process-controller.js");
  const processHandle = new LocalProcessLauncher().launch({ executable: process.execPath, args: ["-e", "process.exit(0)"] }, process.cwd());
  const result = await processHandle.wait();
  assert.equal(result.exitCode, 0);
});
