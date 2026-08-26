import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCodexQueueScript, findStartedCodexSession, formatFleetMessageForCaptain } from "./codex-bridge.js";
import { messageFixture } from "./test-fixtures.js";

test("finds the Codex session created for a bridge working directory", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-bridge-"));
  mkdirSync(join(root, "2026"), { recursive: true });
  writeFileSync(join(root, "2026", "worker.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: "worker-session", cwd: "C:\\Fleet\\worktree", timestamp: "2026-08-26T10:01:00.000Z" } })}\n`);
  writeFileSync(join(root, "2026", "old.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: "old-session", cwd: "C:\\Fleet\\worktree", timestamp: "2026-08-26T09:00:00.000Z" } })}\n`);

  assert.equal(findStartedCodexSession({
    workingDirectory: "c:/fleet/worktree",
    startedAt: "2026-08-26T10:00:00.000Z",
    sessionsRoot: root,
  }), "worker-session");
});

test("formats a Fleet message with provenance and human intervention state", () => {
  const text = formatFleetMessageForCaptain(messageFixture({
    type: "approval",
    priority: "high",
    text: "Necesito confirmar el formato de creación.",
    requiresHuman: true,
    decisionId: "decision-1",
    projectName: "fleet",
    agentRole: "implementer",
    taskTitle: "Separar checkout",
  }));

  assert.match(text, /fleet \/ implementer \/ Separar checkout/);
  assert.match(text, /Requiere intervención humana: sí/);
  assert.match(text, /Necesito confirmar/);
  assert.match(text, /agent reply --id "agent-1" --message "message-1"/);
});

test("queues the complete Fleet message as one native Windows argument", () => {
  const script = buildCodexQueueScript("C:\\Codex\\codex.cmd", "session-1", "[FLEET MESSAGE]\n\nMensaje del agente:\nNecesito confirmar el formato de \"PROJECT.md\".");
  const encodedMessage = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encodedMessage);
  assert.equal(Buffer.from(encodedMessage, "base64").toString("utf8"), "[FLEET MESSAGE] Mensaje del agente: Necesito confirmar el formato de \\\"PROJECT.md\\\".");
  assert.match(script, /queue --thread 'session-1' --message \"\$message\"/);
});
