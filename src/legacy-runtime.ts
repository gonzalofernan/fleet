import { spawnSync } from "node:child_process";

export function terminateLegacyCaptainBridges(fleetCliPath: string): number[] {
  if (process.platform !== "win32") return [];
  const script = buildLegacyCaptainCleanupScript(fleetCliPath, process.pid);
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
}

export function buildLegacyCaptainCleanupScript(fleetCliPath: string, currentPid: number): string {
  const cliBase64 = Buffer.from(fleetCliPath, "utf8").toString("base64");
  return [
    `$cli = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cliBase64}'))`,
    `Get-CimInstance Win32_Process | Where-Object {`,
    `  $_.ProcessId -ne ${currentPid} -and $_.Name -in @('node.exe', 'node') -and $_.CommandLine -and`,
    `  $_.CommandLine.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and`,
    `  $_.CommandLine.IndexOf('captain-bridge', [StringComparison]::OrdinalIgnoreCase) -ge 0`,
    `} | ForEach-Object {`,
    `  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue`,
    `  Write-Output $_.ProcessId`,
    `}`,
  ].join("\n");
}
