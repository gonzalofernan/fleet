import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PullRequestLookup } from "./adapters/github-pull-request.js";
import { WindowsTerminalAdapter } from "./adapters/windows-terminal.js";
import { settingsForWorkspace } from "./settings.js";
import { FleetService } from "./service.js";
import { FleetStore } from "./storage.js";

test("reconciles an exactly matching merged PR and completes its only task agent", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-pr-test-"));
  const store = new FleetStore(join(root, "fleet.db"));
  const project = store.addProject("fleet", root);
  const task = store.createTask(project.id, "Ship reconciliation");
  const agent = store.requestAgent(task.id, "implementer");
  store.provisionAgent(agent.id, { branch: "fleet/agent-123", worktreePath: join(root, "worker"), terminalTitle: "worker" });
  const lookup: PullRequestLookup = {
    findMergedPullRequest: (_projectRoot, branch) => branch === "fleet/agent-123"
      ? { number: 42, url: "https://example.test/pr/42", headRefName: branch, baseRefName: "main", mergedAt: "2026-08-25T12:00:00Z" }
      : null,
  };

  const settings = { ...settingsForWorkspace(root), autoCleanupWorktrees: false };
  const result = new FleetService(store, undefined, undefined, settings, lookup).reconcileMergedPullRequests(root);

  assert.equal(result.errors.length, 0);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0]?.taskCompleted, true);
  assert.equal(store.snapshot().agents[0]?.status, "completed");
  assert.equal(store.snapshot().tasks[0]?.status, "completed");
  assert.equal(new FleetService(store, undefined, undefined, settings, lookup).reconcileMergedPullRequests(root).merged.length, 0);
  store.close();
});

test("does not complete a task while it has another active agent", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-pr-test-"));
  const store = new FleetStore(join(root, "fleet.db"));
  const project = store.addProject("fleet", root);
  const task = store.createTask(project.id, "Ship reconciliation");
  const mergedAgent = store.requestAgent(task.id, "implementer");
  const activeAgent = store.requestAgent(task.id, "reviewer");
  store.provisionAgent(mergedAgent.id, { branch: "fleet/agent-123", worktreePath: join(root, "worker"), terminalTitle: "worker" });
  store.provisionAgent(activeAgent.id, { branch: "fleet/agent-456", worktreePath: join(root, "reviewer"), terminalTitle: "reviewer" });
  const lookup: PullRequestLookup = { findMergedPullRequest: (_root, branch) => branch === "fleet/agent-123" ? { number: 42, url: "https://example.test/pr/42", headRefName: branch, baseRefName: "main", mergedAt: "2026-08-25T12:00:00Z" } : null };

  const result = new FleetService(store, undefined, undefined, { ...settingsForWorkspace(root), autoCleanupWorktrees: false }, lookup).reconcileMergedPullRequests(root);

  assert.equal(result.merged[0]?.taskCompleted, false);
  assert.equal(store.snapshot().tasks[0]?.status, "pending");
  assert.equal(store.snapshot().agents.find((agent) => agent.id === activeAgent.id)?.status, "provisioning");
  store.close();
});

test("fails the runtime, attempt, agent, and task when Windows Terminal rejects launch", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-launch-test-"));
  const store = new FleetStore(join(root, "fleet.db"));
  const project = store.addProject("fleet", root);
  const task = store.createTask(project.id, "Launch safely");
  const requested = store.requestAgent(task.id, "implementer");
  const agent = store.provisionAgent(requested.id, { branch: "fleet/agent-launch", worktreePath: root, terminalTitle: "worker" });
  class FailingTerminal extends WindowsTerminalAdapter {
    override launch(): void { throw new Error("wt unavailable"); }
  }
  const previous = process.env.FLEET_CODEX_PATH;
  process.env.FLEET_CODEX_PATH = process.execPath;
  try {
    assert.throws(() => new FleetService(store, undefined, new FailingTerminal(), settingsForWorkspace(root)).launchAgent(agent.id), /wt unavailable/);
  } finally {
    if (previous === undefined) delete process.env.FLEET_CODEX_PATH;
    else process.env.FLEET_CODEX_PATH = previous;
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.runtimes[0]?.status, "failed");
  assert.equal(snapshot.attempts[0]?.status, "failed");
  assert.equal(snapshot.agents[0]?.status, "failed");
  assert.equal(snapshot.tasks[0]?.status, "failed");
  store.close();
});
