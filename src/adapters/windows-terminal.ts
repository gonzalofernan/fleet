import { spawnSync } from "node:child_process";

export interface TerminalRequest {
  runtimeId: string;
  title: string;
  workingDirectory: string;
  fleetCliPath: string;
  databasePath: string;
  tabColor?: string;
}

export interface CaptainRequest extends Omit<TerminalRequest, "title" | "tabColor"> {}

export class WindowsTerminalAdapter {
  launch(request: TerminalRequest): void {
    const result = spawnSync("wt.exe", buildWindowsTerminalArgs(request), {
      stdio: "ignore",
      windowsHide: false,
    });
    if (result.error) throw new Error(`Windows Terminal could not be started: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Windows Terminal rejected the Fleet tab with exit code ${result.status}`);
  }

  launchCaptain(request: CaptainRequest): void {
    this.launch({ ...request, title: "FLEET | Captain", tabColor: "#E4A11B" });
  }
}

export function buildWindowsTerminalArgs(request: TerminalRequest): string[] {
  const script = [
    `$env:FLEET_DB = '${escapePowerShell(request.databasePath)}'`,
    `& '${escapePowerShell(process.execPath)}' '${escapePowerShell(request.fleetCliPath)}' runtime run --id '${escapePowerShell(request.runtimeId)}' --database-path '${escapePowerShell(request.databasePath)}'`,
    "$exitCode = $LASTEXITCODE",
    "exit $exitCode",
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return [
    "-w", "fleet",
    "new-tab",
    "--title", request.title,
    "--suppressApplicationTitle",
    "--tabColor", request.tabColor ?? "#007C91",
    "-d", request.workingDirectory,
    "powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodedScript,
  ];
}

export function buildCaptainTerminalArgs(request: CaptainRequest): string[] {
  return buildWindowsTerminalArgs({ ...request, title: "FLEET | Captain", tabColor: "#E4A11B" });
}

/** Native Windows command arguments cannot safely carry literal prompt newlines. */
export function flattenPromptForWindowsArgument(prompt: string): string {
  return prompt.replace(/\r?\n/g, " ").replace(/[ \t]{2,}/g, " ").trim().replaceAll('"', '\\"');
}

function escapePowerShell(value: string): string { return value.replaceAll("'", "''"); }
