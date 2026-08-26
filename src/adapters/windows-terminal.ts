import { spawn } from "node:child_process";

export interface TerminalRequest {
  title: string;
  workingDirectory: string;
  taskTitle: string;
  agentId: string;
  taskId: string;
  codexPath: string;
  fleetCliPath: string;
  databasePath: string;
  model: string;
  prompt: string;
}

export class WindowsTerminalAdapter {
  launch(request: TerminalRequest): void {
    const child = spawn("wt.exe", buildWindowsTerminalArgs(request), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  }

  launchCaptain(request: CaptainRequest): void {
    const child = spawn("wt.exe", buildCaptainTerminalArgs(request), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  }
}

export interface CaptainRequest {
  codexPath: string;
  fleetCliPath: string;
  databasePath: string;
  workingDirectory: string;
  model: string;
  prompt: string;
}

export function buildWindowsTerminalArgs(request: TerminalRequest): string[] {
  const promptBase64 = Buffer.from(flattenPromptForWindowsArgument(request.prompt), "utf8").toString("base64");
  const bridgeArguments = [
    quoteProcessArgument(request.fleetCliPath),
    "worker-bridge",
    "--agent-id", quoteProcessArgument(request.agentId),
    "--codex-path", quoteProcessArgument(request.codexPath),
    "--database-path", quoteProcessArgument(request.databasePath),
    "--working-directory", quoteProcessArgument(request.workingDirectory),
    "--started-at",
  ].join(" ");
  const script = [
    "$startedAt = [DateTime]::UtcNow.ToString('o')",
    `$env:FLEET_DB = '${escapePowerShell(request.databasePath)}'`,
    `$prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${promptBase64}'))`,
    `$bridgeArgs = '${escapePowerShell(bridgeArguments)} \"' + $startedAt + '\"'`,
    `$watcher = Start-Process -FilePath '${escapePowerShell(process.execPath)}' -ArgumentList $bridgeArgs -WindowStyle Hidden -PassThru`,
    `& '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' agent status --id '${escapePowerShell(request.agentId)}' --status running --message 'El agente ha iniciado Codex en su worktree.'`,
    `& '${escapePowerShell(request.codexPath)}' -m '${escapePowerShell(request.model)}' -s danger-full-access -a never -C '${escapePowerShell(request.workingDirectory)}' \"$prompt\"`,
    "$exitCode = $LASTEXITCODE",
    "if ($watcher) { Stop-Process -Id $watcher.Id -Force -ErrorAction SilentlyContinue }",
    "if ($exitCode -eq 0) {",
    `  & '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' agent complete --id '${escapePowerShell(request.agentId)}' --message 'Codex terminó y el worker intentó cerrar la entrega.'`,
    "  $completionExitCode = $LASTEXITCODE",
    "  if ($completionExitCode -ne 0) {",
    `    & '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' agent status --id '${escapePowerShell(request.agentId)}' --status waiting --message 'Codex terminó, pero la entrega no está verificada. Falta commit, push, pull request o hay cambios locales.'`,
    "  }",
    "} else {",
    `  & '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' agent status --id '${escapePowerShell(request.agentId)}' --status failed --message \"Codex ha terminado con código $exitCode.\"`,
    "}",
    `& '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' worker-cleanup --agent-id '${escapePowerShell(request.agentId)}' --codex-path '${escapePowerShell(request.codexPath)}' --database-path '${escapePowerShell(request.databasePath)}' --working-directory '${escapePowerShell(request.workingDirectory)}' --started-at $startedAt`,
    "exit $exitCode",
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return [
    "-w", "fleet",
    "new-tab",
    "--title", request.title,
    "--suppressApplicationTitle",
    "--tabColor", "#007C91",
    "-d", request.workingDirectory,
    "powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodedScript,
  ];
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

function quoteProcessArgument(value: string): string {
  return `\"${value.replaceAll('"', '\\"')}\"`;
}

export function buildCaptainTerminalArgs(request: CaptainRequest): string[] {
  const bridgeArguments = [
    quoteProcessArgument(request.fleetCliPath),
    "captain-bridge",
    "--codex-path", quoteProcessArgument(request.codexPath),
    "--database-path", quoteProcessArgument(request.databasePath),
    "--working-directory", quoteProcessArgument(request.workingDirectory),
    "--started-at",
  ].join(" ");
  const script = [
    "$startedAt = [DateTime]::UtcNow.ToString('o')",
    `$env:FLEET_DB = '${escapePowerShell(request.databasePath)}'`,
    "$prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(flattenPromptForWindowsArgument(request.prompt), "utf8").toString("base64") + "'))",
    `$bridgeArgs = '${escapePowerShell(bridgeArguments)} \"' + $startedAt + '\"'`,
    `$watcher = Start-Process -FilePath '${escapePowerShell(process.execPath)}' -ArgumentList $bridgeArgs -WindowStyle Hidden -PassThru`,
    `& '${escapePowerShell(request.codexPath)}' -m '${escapePowerShell(request.model)}' -s danger-full-access -a never -C '${escapePowerShell(request.workingDirectory)}' \"$prompt\"`,
    "$exitCode = $LASTEXITCODE",
    "if ($watcher) { Stop-Process -Id $watcher.Id -Force -ErrorAction SilentlyContinue }",
    `& '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' captain-cleanup --working-directory '${escapePowerShell(request.workingDirectory)}' --started-at $startedAt --codex-path '${escapePowerShell(request.codexPath)}'`,
    "exit $exitCode",
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return [
    "-w", "fleet",
    "new-tab",
    "--title", "FLEET | Captain",
    "--suppressApplicationTitle",
    "--tabColor", "#E4A11B",
    "-d", request.workingDirectory,
    "powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodedScript,
  ];
}

/** Native Windows command arguments cannot safely carry literal prompt newlines. */
export function flattenPromptForWindowsArgument(prompt: string): string {
  return prompt.replace(/\r?\n/g, " ").replace(/[ \t]{2,}/g, " ").trim().replaceAll('"', '\\"');
}
