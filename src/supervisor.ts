import { formatFleetMessageForCaptain } from "./codex-bridge.js";
import type { AgentReply, ProcessRuntime } from "./domain.js";
import { getExecutionProfile } from "./execution-profiles.js";
import { LocalProcessLauncher, type ManagedProcess, type ProcessLauncher } from "./process-controller.js";
import { CodexProviderAdapter } from "./providers/codex.js";
import { ProviderRegistry } from "./providers/provider.js";
import { FleetService } from "./service.js";
import { ensureSettings, type FleetSettings } from "./settings.js";
import { FleetStore } from "./storage.js";

export interface SupervisorOptions {
  runtimeId: string;
  databasePath: string;
  settings?: FleetSettings;
}

export interface SupervisorDependencies {
  processes?: ProcessLauncher;
  providers?: ProviderRegistry;
}

export async function runSupervisedRuntime(options: SupervisorOptions, dependencies: SupervisorDependencies = {}): Promise<number> {
  const store = new FleetStore(options.databasePath);
  const settings = options.settings ?? ensureSettings();
  let runtime = store.getRuntime(options.runtimeId);
  const providers = dependencies.providers ?? new ProviderRegistry([
    new CodexProviderAdapter(runtime.launchConfig.codexPath),
  ]);
  const provider = providers.get(runtime.provider);
  const profile = getExecutionProfile(runtime.executionProfile);
  const processes = dependencies.processes ?? new LocalProcessLauncher();
  let child: ManagedProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let tickRunning = false;
  let sessionId: string | null = runtime.sessionId;
  let lastPullRequestSync = 0;
  let lastLoopSync = 0;
  let terminationRequested = false;
  let ownsRuntime = false;

  const requestStop = () => {
    if (terminationRequested) return;
    terminationRequested = true;
    if (ownsRuntime) {
      try { store.requestRuntimeCancellation(runtime.id, "Supervisor process received a termination signal"); } catch { /* best effort */ }
    }
    child?.terminate();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    runtime = store.startRuntime(runtime.id, process.pid);
    ownsRuntime = true;
    if (runtime.kind === "worker" && runtime.ownerId) {
      const agent = store.getAgent(runtime.ownerId);
      if (agent.status === "provisioning" || agent.status === "waiting") store.updateAgentStatus(agent.id, "running");
    }
    child = processes.launch(provider.buildCommand(runtime, profile), runtime.workingDirectory);
    runtime = store.setRuntimeChild(runtime.id, child.pid);

    const tick = () => {
      if (tickRunning) return;
      tickRunning = true;
      try {
        runtime = store.heartbeatRuntime(runtime.id, process.pid);
        if (!sessionId && runtime.startedAt) {
          sessionId = provider.findSession({ workingDirectory: runtime.workingDirectory, startedAt: runtime.startedAt });
          if (sessionId) runtime = store.attachRuntimeSession(runtime.id, sessionId);
        }
        if (sessionId) {
          if (runtime.kind === "captain") {
            for (const delivery of deliverCaptainOutbox(store, provider, runtime, sessionId)) {
              new FleetService(store, undefined, undefined, settings).refreshProject(delivery.projectId, delivery.activity);
            }
          }
          if (runtime.kind === "worker" && runtime.ownerId) {
            for (const delivery of deliverWorkerOutbox(store, provider, runtime, runtime.ownerId, sessionId)) {
              new FleetService(store, undefined, undefined, settings).refreshProject(delivery.projectId, delivery.activity);
            }
          }
        }
        if (runtime.kind === "captain") {
          const timestamp = Date.now();
          if (timestamp - lastPullRequestSync >= settings.pullRequestPollMs) {
            synchronizePullRequests(store, settings);
            lastPullRequestSync = timestamp;
          }
          if (timestamp - lastLoopSync >= settings.loopPollMs) {
            new FleetService(store, undefined, undefined, settings).runDueLoops(new Date());
            lastLoopSync = timestamp;
          }
        }
        const latest = store.getRuntime(runtime.id);
        if (latest.status === "cancelling") child?.terminate();
      } catch (error) {
        store.requestRuntimeCancellation(runtime.id, `Supervisor tick failed: ${errorMessage(error)}`);
        child?.terminate();
      } finally {
        tickRunning = false;
      }
    };
    tick();
    timer = setInterval(tick, settings.heartbeatIntervalMs);
    const result = await child.wait();
    if (timer) clearInterval(timer);
    return finalizeRuntime(store, settings, provider, runtime.id, result.exitCode);
  } catch (error) {
    try {
      if (!ownsRuntime) return 1;
      const latest = store.getRuntime(runtime.id);
      if (!["stopped", "failed", "cancelled"].includes(latest.status)) store.finishRuntime(runtime.id, "failed", null, errorMessage(error));
      if (runtime.kind === "worker" && runtime.ownerId) {
        const agent = store.getAgent(runtime.ownerId);
        if (!["completed", "failed", "cancelled"].includes(agent.status)) store.updateAgentStatus(agent.id, "failed", errorMessage(error));
      }
    } catch { /* preserve original failure */ }
    return 1;
  } finally {
    if (timer) clearInterval(timer);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    store.close();
  }
}

function deliverCaptainOutbox(
  store: FleetStore,
  provider: ReturnType<ProviderRegistry["get"]>,
  runtime: ProcessRuntime,
  sessionId: string,
): ProjectDelivery[] {
  const deliveries: ProjectDelivery[] = [];
  for (const claim of store.claimMessages(runtime.id)) {
    try {
      if (!provider.sendMessage(sessionId, formatFleetMessageForCaptain(claim.message))) throw new Error("Provider rejected the message");
      store.acknowledgeMessageClaim(claim.message.id, claim.token);
      if (claim.message.taskId) {
        const task = store.getTask(claim.message.taskId);
        deliveries.push({ projectId: task.projectId, activity: `Mensaje ${claim.message.type} entregado: ${claim.message.text}` });
      }
    } catch (error) {
      store.releaseMessageClaim(claim.message.id, claim.token, errorMessage(error));
    }
  }
  for (const message of store.listMessagesDueForReminder()) {
    if (provider.sendMessage(sessionId, formatFleetMessageForCaptain(message, true))) store.markMessageReminded(message.id);
  }
  return deliveries;
}

function deliverWorkerOutbox(
  store: FleetStore,
  provider: ReturnType<ProviderRegistry["get"]>,
  runtime: ProcessRuntime,
  agentId: string,
  sessionId: string,
): ProjectDelivery[] {
  const deliveries: ProjectDelivery[] = [];
  for (const claim of store.claimAgentReplies(agentId, runtime.id)) {
    try {
      if (!provider.sendMessage(sessionId, formatReplyForWorker(claim.reply))) throw new Error("Provider rejected the reply");
      store.acknowledgeAgentReplyClaim(claim.reply.id, claim.token);
      const task = store.getTask(store.getAgent(agentId).taskId);
      deliveries.push({ projectId: task.projectId, activity: `Respuesta del capitán entregada al agente ${agentId.slice(0, 8)}.` });
    } catch (error) {
      store.releaseAgentReplyClaim(claim.reply.id, claim.token, errorMessage(error));
    }
  }
  return deliveries;
}

interface ProjectDelivery { projectId: string; activity: string }

function finalizeRuntime(
  store: FleetStore,
  settings: FleetSettings,
  provider: ReturnType<ProviderRegistry["get"]>,
  runtimeId: string,
  exitCode: number | null,
): number {
  let runtime = store.getRuntime(runtimeId);
  const sessionLookup = { workingDirectory: runtime.workingDirectory, startedAt: runtime.startedAt ?? runtime.createdAt };
  try { provider.cleanupSessions(sessionLookup); } catch { /* session cleanup is retried by maintenance */ }
  if (runtime.kind === "captain") {
    const status = runtime.status === "cancelling" ? "cancelled" : exitCode === 0 ? "stopped" : "failed";
    store.finishRuntime(runtime.id, status, exitCode, exitCode === 0 ? undefined : `Captain exited with code ${exitCode}`);
    return exitCode ?? 1;
  }
  if (!runtime.ownerId) {
    store.finishRuntime(runtime.id, exitCode === 0 ? "stopped" : "failed", exitCode, "Worker runtime has no owner agent");
    return exitCode ?? 1;
  }
  const service = new FleetService(store, undefined, undefined, settings);
  let context = store.getAgentContext(runtime.ownerId);
  if (context.agent.status === "completed") {
    store.finishRuntime(runtime.id, "stopped", exitCode);
    return 0;
  }
  if (context.agent.status === "cancelled") {
    store.finishRuntime(runtime.id, "cancelled", exitCode);
    return 0;
  }
  if (context.agent.status === "failed") {
    store.finishRuntime(runtime.id, "failed", exitCode, "Agent failed before its runtime exited");
    return exitCode ?? 1;
  }
  if (runtime.status === "cancelling") {
    store.updateAgentStatus(context.agent.id, "cancelled", "El runtime fue cancelado por el supervisor.");
    store.finishRuntime(runtime.id, "cancelled", exitCode);
    return 0;
  }
  if (exitCode === 0) {
    try {
      if (context.task.spec.deliveryMode === "git-pr") {
        service.completeAgent(context.agent.id, "El proceso Codex terminó correctamente y Fleet verificó la entrega Git/PR.");
      } else {
        store.updateAgentStatus(context.agent.id, "completed", `Entrega ${context.task.spec.deliveryMode} finalizada correctamente.`);
      }
      store.finishRuntime(runtime.id, "stopped", exitCode);
      return 0;
    } catch (error) {
      context = store.getAgentContext(context.agent.id);
      if (!["completed", "failed", "cancelled"].includes(context.agent.status)) {
        store.updateAgentStatus(context.agent.id, "waiting", `El proceso terminó pero la entrega no está verificada: ${errorMessage(error)}`);
      }
      store.finishRuntime(runtime.id, "failed", exitCode, errorMessage(error));
      return 1;
    }
  }
  store.updateAgentStatus(context.agent.id, "failed", `Codex terminó con código ${exitCode}.`);
  runtime = store.getRuntime(runtime.id);
  store.finishRuntime(runtime.id, "failed", exitCode, `Provider process exited with code ${exitCode}`);
  return exitCode ?? 1;
}

function synchronizePullRequests(store: FleetStore, settings: FleetSettings): void {
  const result = new FleetService(store, undefined, undefined, settings).reconcileMergedPullRequests();
  for (const reconciled of result.merged) {
    store.sendMessage({
      agentId: reconciled.agent.id,
      taskId: reconciled.task.id,
      type: "info",
      dedupeKey: `pr-merged:${reconciled.merge.number}`,
      allowTerminalAgent: true,
      text: `PR #${reconciled.merge.number} fusionada: ${reconciled.merge.url}. ${reconciled.taskCompleted ? "Tarea completada y recursos retirados." : "La tarea conserva otros intentos activos."}`,
    });
  }
}

function formatReplyForWorker(reply: AgentReply): string {
  return [
    "[FLEET CAPTAIN REPLY]",
    reply.replyToMessageId ? `Respuesta al mensaje: ${reply.replyToMessageId}` : "Respuesta operativa del capitán.",
    reply.text,
    "Continúa la tarea con esta decisión. No vuelvas a solicitar la misma confirmación.",
  ].join("\n");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
