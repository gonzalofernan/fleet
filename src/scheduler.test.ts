import assert from "node:assert/strict";
import test from "node:test";
import type { Loop } from "./domain.js";
import { isLoopDue } from "./scheduler.js";

function loop(schedule: string, lastScheduledAt: string | null = null): Loop {
  return {
    id: "loop-1", projectId: "project-1", title: "Review", schedule, enabled: true, directoryPath: null,
    taskSpec: { objective: "Review", kind: "review", deliveryMode: "report-only", acceptanceCriteria: [], contextPaths: [], riskLevel: "low", executionProfile: "worker-review" },
    role: "reviewer", provider: "codex", model: "gpt-5.6-terra", lastScheduledAt,
    createdAt: "2026-08-26T08:00:00.000Z", updatedAt: "2026-08-26T08:00:00.000Z",
  };
}

test("supports manual, interval, and five-field cron schedules", () => {
  const now = new Date(2026, 7, 26, 10, 30, 0, 0);
  const seventyMinutesAgo = new Date(now.getTime() - 70 * 60_000).toISOString();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60_000).toISOString();
  const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const sameMinute = new Date(now.getTime() + 10_000).toISOString();
  assert.equal(isLoopDue(loop("manual"), now), false);
  assert.equal(isLoopDue(loop("@every 1h", seventyMinutesAgo), now), true);
  assert.equal(isLoopDue(loop("@every 1h", thirtyMinutesAgo), now), false);
  assert.equal(isLoopDue(loop("30 10 * * *", oneMinuteAgo), now), true);
  assert.equal(isLoopDue(loop("30 10 * * *", sameMinute), now), false);
});
