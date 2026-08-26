import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerPrompt } from "./worker.js";

test("builds a worker prompt with task context and Fleet reporting commands", () => {
  const prompt = buildWorkerPrompt({
    agent: {
      id: "agent-123",
      taskId: "task-123",
      role: "implementer",
      provider: "codex",
      model: "gpt-5.6-terra",
      status: "provisioning",
      branch: "fleet/agent-agent12",
      worktreePath: "C:\\Fleet\\worktrees\\agent12",
      terminalTitle: "FLEET | fleet | agent12",
      createdAt: "2026-08-26T10:00:00.000Z",
    },
    task: {
      id: "task-123",
      projectId: "project-123",
      title: "Implement worker launch",
      status: "pending",
      createdAt: "2026-08-26T10:00:00.000Z",
    },
    project: {
      id: "project-123",
      name: "fleet",
      rootPath: "C:\\Fleet\\projects\\fleet",
      createdAt: "2026-08-26T10:00:00.000Z",
    },
  }, {
    fleetCliPath: "C:\\Fleet\\dist\\cli.js",
    controlRoot: process.cwd(),
    projectContext: {
      directory: "C:\\Fleet\\projects\\fleet",
      project: "C:\\Fleet\\projects\\fleet\\PROJECT.md",
      status: "C:\\Fleet\\projects\\fleet\\STATUS.md",
      decisions: "C:\\Fleet\\projects\\fleet\\DECISIONS.md",
    },
  });

  assert.match(prompt, /Implement worker launch/);
  assert.match(prompt, /FLEET TASK BRIEF \(AUTHORITATIVE\)/);
  assert.match(prompt, /This is the assigned task\. Do not report that no task brief was provided/);
  assert.match(prompt, /gpt-5\.6-terra/);
  assert.match(prompt, /Fleet project context \(authoritative\): C:\\Fleet\\projects\\fleet\\PROJECT\.md/);
  assert.match(prompt, /Do not substitute the tracked projects\/<name>\/PROJECT\.md/);
  assert.match(prompt, /message send --agent "agent-123" --task "task-123"/);
  assert.match(prompt, /charters[\\/]roles[\\/]implementer\.md/);
  assert.match(prompt, /type approval/);
  assert.match(prompt, /type completed/);
});
