import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupCodexSessions, findCodexSessions } from "./codex-sessions.js";

test("finds Codex sessions from rollout metadata without touching other files", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-sessions-"));
  mkdirSync(join(root, "2026", "08"), { recursive: true });
  writeFileSync(join(root, "2026", "08", "session.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { session_id: "session-1", cwd: "C:/fleet", timestamp: "2026-08-25T10:00:00.000Z" }})}\n`);
  writeFileSync(join(root, "2026", "08", "other.jsonl"), "not a session\n");

  assert.deepEqual(findCodexSessions(root).map((session) => session.id), ["session-1"]);
});

test("cleans only sessions created for this Fleet workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-sessions-"));
  const writeSession = (name: string, id: string, cwd: string, timestamp: string) => {
    writeFileSync(join(root, name), `${JSON.stringify({ type: "session_meta", payload: { session_id: id, cwd, timestamp } })}\n`);
  };
  writeSession("owned.jsonl", "owned", "C:/fleet", "2026-08-25T10:01:00.000Z");
  writeSession("old.jsonl", "old", "C:/fleet", "2026-08-25T09:59:00.000Z");
  writeSession("other.jsonl", "other", "C:/other", "2026-08-25T10:02:00.000Z");
  const deleted: string[] = [];

  assert.deepEqual(cleanupCodexSessions({
    workingDirectory: "C:/fleet",
    startedAt: "2026-08-25T10:00:00.000Z",
    codexPath: "codex.cmd",
    sessionsRoot: root,
    deleteSession: (id) => {
      deleted.push(id);
      return true;
    },
  }), ["owned"]);
  assert.deepEqual(deleted, ["owned"]);
});
