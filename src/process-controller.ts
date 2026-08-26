import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ProviderCommand } from "./providers/provider.js";

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ManagedProcess {
  pid: number;
  wait(): Promise<ProcessExit>;
  terminate(): void;
}

export interface ProcessLauncher {
  launch(command: ProviderCommand, workingDirectory: string): ManagedProcess;
}

export class LocalProcessLauncher implements ProcessLauncher {
  launch(command: ProviderCommand, workingDirectory: string): ManagedProcess {
    const child = spawn(command.executable, command.args, {
      cwd: workingDirectory,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });
    if (!child.pid) throw new Error(`Failed to start ${command.executable}`);
    return new ChildProcessHandle(child);
  }
}

class ChildProcessHandle implements ManagedProcess {
  readonly pid: number;
  private readonly completion: Promise<ProcessExit>;

  constructor(private readonly child: ChildProcess) {
    this.pid = child.pid!;
    this.completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  }

  wait(): Promise<ProcessExit> { return this.completion; }

  terminate(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(this.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    this.child.kill("SIGTERM");
  }
}
