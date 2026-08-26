import { readFileSync, readdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  filePath: string;
}

export function defaultCodexSessionsPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

export function findCodexSessions(root = defaultCodexSessionsPath()): CodexSessionMeta[] {
  const files = collectJsonlFiles(root);
  const sessions: CodexSessionMeta[] = [];
  for (const filePath of files) {
    try {
      const firstLine = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
      const record = JSON.parse(firstLine) as { type?: string; payload?: { session_id?: string; cwd?: string; timestamp?: string } };
      if (record.type !== "session_meta" || !record.payload?.session_id || !record.payload.cwd || !record.payload.timestamp) continue;
      sessions.push({ id: record.payload.session_id, cwd: record.payload.cwd, timestamp: record.payload.timestamp, filePath });
    } catch {
      // Ignore partially written or malformed rollout files.
    }
  }
  return sessions;
}

export function cleanupCodexSessions(details: {
  workingDirectory: string;
  startedAt: string;
  codexPath: string;
  sessionsRoot?: string;
  deleteSession?: (sessionId: string) => boolean;
}): string[] {
  const startedAt = Date.parse(details.startedAt);
  const deleted: string[] = [];
  for (const session of findCodexSessions(details.sessionsRoot)) {
    if (!samePath(session.cwd, details.workingDirectory) || Number.isNaN(startedAt) || Date.parse(session.timestamp) < startedAt) continue;
    const deleteSession = details.deleteSession ?? ((sessionId: string) => deleteCodexSession(details.codexPath, sessionId));
    if (deleteSession(session.id)) deleted.push(session.id);
  }
  return deleted;
}

function samePath(left: string, right: string): boolean {
  const comparable = (value: string) => normalize(resolve(value)).replaceAll("/", "\\").toLowerCase();
  return comparable(left) === comparable(right);
}

function deleteCodexSession(codexPath: string, sessionId: string): boolean {
  const command = `"${codexPath.replaceAll('"', '""')}" delete --force ${sessionId}`;
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function collectJsonlFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectJsonlFiles(path) : entry.name.endsWith(".jsonl") ? [path] : [];
    });
  } catch {
    return [];
  }
}
