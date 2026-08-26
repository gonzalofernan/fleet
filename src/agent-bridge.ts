import type { AgentReply } from "./domain.js";
import { findStartedCodexSession, formatFleetMessageForCaptain, queueCodexMessage } from "./codex-bridge.js";
import { FleetStore } from "./storage.js";

export interface WorkerBridgeOptions {
  agentId: string;
  codexPath: string;
  databasePath: string;
  workingDirectory: string;
  startedAt: string;
}

export interface CaptainBridgeOptions {
  codexPath: string;
  databasePath: string;
  workingDirectory: string;
  startedAt: string;
}

export function startWorkerBridge(options: WorkerBridgeOptions): void {
  const store = new FleetStore(options.databasePath);
  let sessionId: string | null = null;
  let timer: NodeJS.Timeout;
  const stop = () => {
    clearInterval(timer);
    store.close();
  };
  const poll = () => {
    try {
      if (!sessionId) {
        sessionId = findStartedCodexSession(options);
        if (sessionId) store.attachAgentSession(options.agentId, sessionId, options.startedAt);
      }
      if (sessionId) deliverReplies(store, options.agentId, options.codexPath, sessionId);
      const status = store.getAgentContext(options.agentId).agent.status;
      if (["completed", "failed", "cancelled"].includes(status)) stop();
    } catch {
      stop();
    }
  };
  timer = setInterval(poll, 350);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  poll();
}

export function startCaptainBridge(options: CaptainBridgeOptions): void {
  const store = new FleetStore(options.databasePath);
  let sessionId: string | null = null;
  let timer: NodeJS.Timeout;
  const stop = () => {
    clearInterval(timer);
    store.close();
  };
  const poll = () => {
    try {
      if (!sessionId) sessionId = findStartedCodexSession(options);
      if (!sessionId) return;
      for (const message of store.listMessages("unread")) {
        if (!queueCodexMessage(options.codexPath, sessionId, formatFleetMessageForCaptain(message))) continue;
        store.markMessageDelivered(message.id);
      }
      for (const message of store.listMessagesDueForReminder()) {
        if (!queueCodexMessage(options.codexPath, sessionId, formatFleetMessageForCaptain(message, true))) continue;
        store.markMessageReminded(message.id);
      }
    } catch {
      stop();
    }
  };
  timer = setInterval(poll, 350);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  poll();
}

function deliverReplies(store: FleetStore, agentId: string, codexPath: string, sessionId: string): void {
  for (const reply of store.listQueuedAgentReplies(agentId)) {
    const message = formatReplyForWorker(reply);
    if (queueCodexMessage(codexPath, sessionId, message)) store.markAgentReplyDelivered(reply.id);
  }
}

function formatReplyForWorker(reply: AgentReply): string {
  return [
    "[FLEET CAPTAIN REPLY]",
    "The Fleet captain has replied to your pending question.",
    "Continue the assigned task using this decision as authoritative operational guidance:",
    reply.text,
    "If the decision resolves the blocker, report the resumed progress to Fleet before continuing.",
  ].join("\n");
}
