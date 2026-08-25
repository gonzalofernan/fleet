import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboard } from "./dashboard.js";

test("shows recovered workers as unverified instead of active", () => {
  const dashboard = renderDashboard({
    projects: [],
    tasks: [],
    loops: [],
    messages: [],
    agents: [{
      id: "agent-1234", taskId: "missing", role: "recovered", provider: "unknown", model: "unknown", status: "unknown",
      branch: "fleet/agent-1234", worktreePath: "C:/worktree", terminalTitle: "FLEET | test", createdAt: "2026-01-01T00:00:00.000Z",
    }],
  });

  assert.match(dashboard, /0 active     1 unverified/);
  assert.match(dashboard, /unknown/);
});
