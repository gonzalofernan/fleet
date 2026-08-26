import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PullRequestLookup } from "./adapters/github-pull-request.js";
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

  const result = new FleetService(store, undefined, undefined, settingsForWorkspace(root), lookup).reconcileMergedPullRequests(root);

  assert.equal(result.errors.length, 0);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0]?.taskCompleted, true);
  assert.equal(store.snapshot().agents[0]?.status, "completed");
  assert.equal(store.snapshot().tasks[0]?.status, "completed");
  assert.equal(new FleetService(store, undefined, undefined, settingsForWorkspace(root), lookup).reconcileMergedPullRequests(root).merged.length, 0);
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

  const result = new FleetService(store, undefined, undefined, settingsForWorkspace(root), lookup).reconcileMergedPullRequests(root);

  assert.equal(result.merged[0]?.taskCompleted, false);
  assert.equal(store.snapshot().tasks[0]?.status, "pending");
  assert.equal(store.snapshot().agents.find((agent) => agent.id === activeAgent.id)?.status, "waiting");
  store.close();
});
