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
