import assert from "node:assert/strict";
import test from "node:test";
import { defaultTaskSpec } from "./domain.js";
import { agentFixture, taskFixture } from "./test-fixtures.js";
import { buildWorkerPrompt } from "./worker.js";

const project = { id: "project-1", name: "fleet", rootPath: "C:\\Fleet\\projects\\fleet", createdAt: "2026-08-26T10:00:00.000Z" };
const options = {
  fleetCliPath: "C:\\Fleet\\dist\\cli.js",
  controlRoot: process.cwd(),
  attemptId: "attempt-1",
  projectContext: {
    directory: project.rootPath,
    project: `${project.rootPath}\\PROJECT.md`,
    status: `${project.rootPath}\\STATUS.md`,
    decisions: `${project.rootPath}\\DECISIONS.md`,
  },
};

test("builds a coding prompt with an explicit TaskSpec and linked outbox commands", () => {
  const task = taskFixture({
    title: "Implement worker launch",
    spec: defaultTaskSpec("Implement worker launch", { acceptanceCriteria: ["Tests pass"] }),
  });
  const prompt = buildWorkerPrompt({
    agent: agentFixture({ status: "provisioning", branch: "fleet/agent-agent12", worktreePath: "C:\\Fleet\\worktrees\\agent12" }),
    task,
    project,
  }, options);

  assert.match(prompt, /FLEET TASK SPEC \(AUTHORITATIVE\)/);
  assert.match(prompt, /Attempt id: attempt-1/);
  assert.match(prompt, /Acceptance criteria:\n- Tests pass/);
  assert.match(prompt, /--attempt "attempt-1"/);
  assert.match(prompt, /--dedupe-key "attempt:attempt-1:decision:<name>"/);
  assert.match(prompt, /git push -u origin HEAD/);
  assert.match(prompt, /gh pr create/);
});

test("does not require Git delivery for research work", () => {
  const title = "Research transcription models";
  const prompt = buildWorkerPrompt({
    agent: agentFixture({ role: "researcher", executionProfile: "worker-research", status: "provisioning" }),
    task: taskFixture({ title, spec: defaultTaskSpec(title, { kind: "research", deliveryMode: "report-only" }) }),
    project,
  }, options);

  assert.match(prompt, /Delivery mode: report-only/);
  assert.match(prompt, /Do not create a commit, push, or pull request/);
  assert.doesNotMatch(prompt, /git push -u origin HEAD/);
});
