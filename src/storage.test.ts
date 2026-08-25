import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FleetStore } from "./storage.js";

test("persists a project, task, and requested agent", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-test-"));
  const store = new FleetStore(join(home, "fleet.db"));
  const project = store.addProject("fleet", home);
  const task = store.createTask(project.id, "Create the Codex adapter");
  const agent = store.requestAgent(task.id, "implementer");
  const snapshot = store.snapshot();

  assert.equal(snapshot.projects[0]?.id, project.id);
  assert.equal(snapshot.tasks[0]?.projectId, project.id);
  assert.equal(snapshot.agents[0]?.taskId, task.id);
  assert.equal(snapshot.agents[0]?.worktreePath, null);
  assert.equal(agent.status, "requested");
  store.close();
});

test("provisions a requested agent with its runtime details", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-test-"));
  const store = new FleetStore(join(home, "fleet.db"));
  const project = store.addProject("fleet", home);
  const task = store.createTask(project.id, "Open a terminal");
  const agent = store.requestAgent(task.id, "implementer");
  const provisioned = store.provisionAgent(agent.id, {
    branch: "fleet/agent-test",
    worktreePath: join(home, "worktree"),
    terminalTitle: "FLEET | fleet | test",
  });

  assert.equal(provisioned.status, "waiting");
  assert.equal(provisioned.branch, "fleet/agent-test");
  assert.equal(store.getAgentContext(agent.id).project.name, "fleet");
  store.close();
});

test("rejects a task for an unknown project", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-test-"));
  const store = new FleetStore(join(home, "fleet.db"));
  assert.throws(() => store.createTask("missing", "Impossible task"), /Unknown project/);
  store.close();
});
