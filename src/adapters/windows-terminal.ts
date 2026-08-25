import { spawn } from "node:child_process";

export interface TerminalRequest {
  title: string;
  workingDirectory: string;
  taskTitle: string;
  agentId: string;
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
  const message = [
    "Clear-Host",
    "Write-Host 'FLEET WORKER CONSOLE' -ForegroundColor Cyan",
    `Write-Host 'Agent: ${escapePowerShell(request.agentId)}'`,
    `Write-Host 'Task: ${escapePowerShell(request.taskTitle)}'`,
    "Write-Host 'State: waiting for the Codex CLI adapter' -ForegroundColor Yellow",
    "Write-Host ''",
    "Write-Host 'This worktree is isolated. Do not edit main directly.' -ForegroundColor DarkGray",
  ].join("; ");
  return [
    "-w", "fleet",
    "new-tab",
    "--title", request.title,
    "--suppressApplicationTitle",
    "--tabColor", "#007C91",
    "-d", request.workingDirectory,
    "powershell.exe", "-NoExit", "-Command", message,
  ];
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

export function buildCaptainTerminalArgs(request: CaptainRequest): string[] {
  const command = `Clear-Host; & '${escapePowerShell(request.codexPath)}' -m '${escapePowerShell(request.model)}' -s danger-full-access -a never -C '${escapePowerShell(request.workingDirectory)}' '${escapePowerShell(request.prompt)}'`;
  return [
    "-w", "fleet",
    "new-tab",
    "--title", "FLEET | Captain",
    "--suppressApplicationTitle",
    "--tabColor", "#E4A11B",
    "-d", request.workingDirectory,
    "powershell.exe", "-NoExit", "-Command", command,
  ];
}
